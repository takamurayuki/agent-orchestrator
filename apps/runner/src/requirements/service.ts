import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CONTRADICTION_QUESTION_PREFIX, VERIFICATION_PROFILES, type AskedQuestion, type DraftApproveResult, type DraftState, type DraftView, type Fact, type ProjectInfo, type TaskProposal, type VerificationProfileName } from '@agent-orchestrator/contracts';
import { nowIso } from '../config.js';
import { detectProhibitedOperations } from '../policy.js';
import type { Repository, DraftRow } from '../storage/repository.js';
import { checkProfileReadiness } from '../verification/profiles.js';
import { activeDecisions, decisionFromContradiction, decisionFromInterviewAnswer, decisionsFromRevision, makeDecision, resolveConflicts, retractDecision } from './decisions.js';
import { applyGenerationDecisions, attachGeneratorInputs, detectGenerationScripts, generationQuestions, inputQuestions, unknownGenerationScripts } from './generated.js';
import { analyzeContradictions, analyzeGap, contradictionsToQuestions, validateProposal, type InterviewModel } from './gap-analyzer.js';
import { previousAnsweredRound, validateAnswers, type AnswerInput } from './questions.js';
import { renderDigest, type RepoDigest, type RepoInspector } from './repo-inspector.js';
import { generateTask, parseAndValidateTaskYaml } from './task-generator.js';

/**
 * Requirements Agent の会話状態機械（SPEC §5）。
 * DRAFT_CREATED → REPO_ANALYZING → GAP_ANALYZING → ASKING ↔ ANSWERING → SUMMARY_READY → AWAITING_APPROVAL → APPROVED → YAML_VALIDATED → READY_TO_RUN
 * - 調査/モデル出力の失敗 → BLOCKED（推測で確定しない）
 * - 要件編集 → 新 revision、承認フラグをリセット
 * - 承認済み revision は immutable。Run に渡るのは approved_tasks のスナップショットだけ
 */
export class DraftServiceError extends Error {
  constructor(
    readonly code: 'NOT_FOUND' | 'INVALID_STATE' | 'INVALID_PARAMS' | 'DRAFT_BLOCKED' | 'VALIDATION_FAILED' | 'POLICY_REJECTED',
    message: string
  ) {
    super(message);
    this.name = 'DraftServiceError';
  }
}

export interface DraftServiceDeps {
  repo: Repository;
  inspector: RepoInspector;
  model: InterviewModel;
  tasksDir: string;
  onDraftUpdated?: (view: DraftView) => void;
}

interface DraftContext {
  digest: RepoDigest;
  info: ProjectInfo;
  /** 矛盾で差し戻したときの素案（判断と対象要件の紐付けに使う。再起動後は失われる＝分かる範囲で） */
  pendingProposal?: TaskProposal | null;
}

export class DraftService {
  /** ダイジェストはメモリに保持（SQLite には facts と Q/A だけ保存）。再起動後は再調査する */
  private readonly contexts = new Map<string, DraftContext>();

  constructor(private readonly deps: DraftServiceDeps) {}

  // ---- public API ----

  async create(input: { projectPath: string; request: string; signal?: AbortSignal }): Promise<DraftView> {
    const signal = input.signal ?? new AbortController().signal;
    const prohibited = detectProhibitedOperations(input.request).map((p) => `${p.code}: ${p.guidance}`);
    const inspection = await this.deps.inspector.inspect(input.projectPath);
    const project = this.deps.repo.upsertProject(inspection.info.path, inspection.info);
    let draft = this.deps.repo.createDraft(project.id, input.request, prohibited);
    draft = this.deps.repo.updateDraft(draft.id, { state: 'REPO_ANALYZING' });
    if (!inspection.ok) {
      draft = this.deps.repo.updateDraft(draft.id, { state: 'BLOCKED', blockedReason: `リポジトリを調査できません（${inspection.code}）: ${inspection.message}` });
      return this.emit(this.view(draft));
    }
    this.contexts.set(draft.id, { digest: inspection.digest, info: inspection.info });
    draft = this.deps.repo.updateDraft(draft.id, { facts: inspection.facts, state: 'GAP_ANALYZING' });
    this.emit(this.view(draft));
    return this.emit(await this.runRound(draft, 1, signal));
  }

  async answer(input: { draftId: string; answers?: AnswerInput[]; back?: boolean; signal?: AbortSignal }): Promise<DraftView> {
    const signal = input.signal ?? new AbortController().signal;
    let draft = this.getDraftOrThrow(input.draftId);
    if (input.back) return this.emit(await this.back(draft, signal));
    if (draft.state !== 'ASKING') throw new DraftServiceError('INVALID_STATE', `状態 ${draft.state} では回答できません`);
    const current = this.currentQuestions(draft);
    const validated = validateAnswers(current, input.answers ?? [], draft.round, nowIso());
    if (!validated.ok) throw new DraftServiceError('INVALID_PARAMS', validated.error);
    draft = this.deps.repo.updateDraft(draft.id, { state: 'ANSWERING' });
    this.deps.repo.addAnswers(draft.id, validated.answers);
    // すべての回答を意思決定ログに記録する（v2.2: 通常質問 = interview、矛盾質問 = contradiction。同じ事項は履歴として積む）
    const pending = this.contexts.get(draft.id)?.pendingProposal ?? null;
    for (const a of validated.answers) {
      if (a.skipped || a.value === null) continue;
      const q = current.find((x) => x.id === a.questionId);
      if (!q) continue;
      let input;
      if (a.questionId.startsWith(CONTRADICTION_QUESTION_PREFIX)) {
        const contradictionId = a.questionId.slice(CONTRADICTION_QUESTION_PREFIX.length);
        const c = draft.contradictions.find((x) => x.id === contradictionId);
        input = c ? decisionFromContradiction(c, a.value, a.answeredAt, pending) : { ...decisionFromInterviewAnswer(q, a.value, a.answeredAt), topicKey: contradictionId, source: 'contradiction' as const };
      } else {
        input = decisionFromInterviewAnswer(q, a.value, a.answeredAt);
      }
      this.deps.repo.addDecision(draft.id, makeDecision(input, this.deps.repo.getDecision(draft.id, input.topicKey)));
    }
    this.supersedeConflicts(draft.id);
    if (validated.answers.some((a) => a.questionId.startsWith(CONTRADICTION_QUESTION_PREFIX))) {
      draft = this.deps.repo.updateDraft(draft.id, { contradictions: draft.contradictions.filter((c) => !validated.answers.some((a) => a.questionId === `${CONTRADICTION_QUESTION_PREFIX}${c.id}` && !a.skipped)) });
    }
    if (validated.skippedBlocking.length > 0) {
      // 安全性に重要な未確定項目のスキップは許可するが次へ進めない（SPEC §3.1-3）
      draft = this.deps.repo.updateDraft(draft.id, {
        state: 'BLOCKED',
        blockedReason: `blocking の質問がスキップされました: ${validated.skippedBlocking.map((q) => `${q.id}「${q.question}」`).join('、')}。「戻る」で回答してください。`
      });
      return this.emit(this.view(draft));
    }
    return this.emit(await this.runRound(draft, draft.round + 1, signal));
  }

  async revise(input: { draftId: string; edits: Partial<Pick<TaskProposal, 'title' | 'requirements' | 'outOfScope' | 'acceptanceCriteria' | 'approach'>> }): Promise<DraftView> {
    let draft = this.getDraftOrThrow(input.draftId);
    if (!['SUMMARY_READY', 'AWAITING_APPROVAL', 'APPROVED', 'YAML_VALIDATED', 'READY_TO_RUN'].includes(draft.state)) {
      throw new DraftServiceError('INVALID_STATE', `状態 ${draft.state} では要件を編集できません`);
    }
    const current = this.deps.repo.getRevision(draft.id, draft.currentRevision);
    if (!current?.proposal) throw new DraftServiceError('INVALID_STATE', 'タスク素案がありません');
    const proposal: TaskProposal = { ...current.proposal, ...stripUndefined(input.edits) };
    // 要件修正は「最新の明示的指示」として意思決定ログに記録（v2.2）
    const editedAt = nowIso();
    for (const d of decisionsFromRevision(current.proposal, proposal, editedAt)) this.deps.repo.addDecision(draft.id, makeDecision(d, this.deps.repo.getDecision(draft.id, d.topicKey)));
    this.supersedeConflicts(draft.id);
    // 常に新 revision（承認フラグはリセット）。承認済み revision は不変のまま残る（RA-11/RA-12）
    const rev = this.deps.repo.createRevision(draft.id, proposal, null, []);
    draft = this.deps.repo.updateDraft(draft.id, { state: 'SUMMARY_READY', approvedTaskId: null });
    draft = this.finalizeRevision(draft, rev.revision, proposal);
    return this.emit(this.view(draft));
  }

  async approve(input: { draftId: string; revision: number; acknowledgeDataSharing: true }): Promise<DraftApproveResult> {
    let draft = this.getDraftOrThrow(input.draftId);
    if (draft.state === 'BLOCKED') throw new DraftServiceError('DRAFT_BLOCKED', draft.blockedReason ?? 'BLOCKED');
    if (draft.state !== 'AWAITING_APPROVAL') throw new DraftServiceError('INVALID_STATE', `状態 ${draft.state} では承認できません`);
    if (input.revision !== draft.currentRevision) throw new DraftServiceError('INVALID_STATE', `revision ${input.revision} は最新（${draft.currentRevision}）ではありません。内容を確認し直してください`);
    const rev = this.deps.repo.getRevision(draft.id, input.revision);
    if (!rev?.taskYaml || !rev.proposal) throw new DraftServiceError('VALIDATION_FAILED', 'task.yaml が生成されていません');
    if (rev.approved) throw new DraftServiceError('INVALID_STATE', 'この revision は既に承認済みです');
    const blocking = this.unansweredBlocking(draft);
    if (blocking.length > 0) throw new DraftServiceError('DRAFT_BLOCKED', `blocking の質問が未回答です: ${blocking.join(', ')}`);
    if (draft.contradictions.some((c) => c.severity === 'blocking')) throw new DraftServiceError('DRAFT_BLOCKED', `重大な矛盾が未解消です: ${draft.contradictions.map((c) => c.id).join(', ')}`);
    const parsed = parseAndValidateTaskYaml(rev.taskYaml);
    if (!parsed.ok) throw new DraftServiceError('VALIDATION_FAILED', `task.yaml が契約に適合しません: ${parsed.errors.join('; ')}`);
    if ((parsed.task.generatedArtifacts ?? []).length > 0) {
      const scripts = (await this.context(draft)).digest.projectScripts ?? {};
      const missing = (parsed.task.generatedArtifacts ?? []).filter((g) => typeof scripts[g.script] !== 'string');
      if (missing.length > 0) throw new DraftServiceError('VALIDATION_FAILED', `生成スクリプトがプロジェクトの scripts（package.json / pyproject の [tool.agent-orchestrator.scripts]）にありません: ${missing.map((g) => `${g.script}（${g.path}）`).join(', ')}。承認前に生成手段を確定してください`);
    }
    const project = this.deps.repo.getProject(draft.projectId);
    const readiness = checkProfileReadiness(project?.path ?? parsed.task.repository, parsed.task.verificationProfile);
    if (!readiness.ready) throw new DraftServiceError('VALIDATION_FAILED', `検証プロファイルを実行できません: ${readiness.detail}`);
    for (const r of parsed.task.requirements) {
      const ops = detectProhibitedOperations(r);
      if (ops.length > 0) throw new DraftServiceError('POLICY_REJECTED', `要件に禁止操作が含まれています（${ops.map((o) => o.code).join(', ')}）。${ops[0]!.guidance}`);
    }

    draft = this.deps.repo.updateDraft(draft.id, { state: 'APPROVED' });
    this.emit(this.view(draft));
    draft = this.deps.repo.updateDraft(draft.id, { state: 'YAML_VALIDATED' });
    this.emit(this.view(draft));
    const dir = join(this.deps.tasksDir, safeSegment(parsed.task.id), 'revisions', String(rev.revision));
    mkdirSync(dir, { recursive: true });
    const yamlPath = join(dir, 'task.yaml');
    writeFileSync(yamlPath, rev.taskYaml, 'utf8');
    writeFileSync(join(dir, 'decisions.json'), JSON.stringify(this.deps.repo.listDecisions(draft.id), null, 2), 'utf8');
    const approved = this.deps.repo.approveRevision(draft.id, rev.revision, parsed.task, rev.taskYaml, yamlPath);
    draft = this.getDraftOrThrow(draft.id);
    const view = this.emit(this.view(draft));
    return { draft: view, approvedTaskId: approved.id, taskYaml: approved.taskYaml, taskYamlPath: yamlPath };
  }

  getView(draftId: string): DraftView {
    return this.view(this.getDraftOrThrow(draftId));
  }

  // ---- internals ----

  private getDraftOrThrow(id: string): DraftRow {
    const d = this.deps.repo.getDraft(id);
    if (!d) throw new DraftServiceError('NOT_FOUND', `draft が見つかりません: ${id}`);
    return d;
  }

  private currentQuestions(draft: DraftRow): AskedQuestion[] {
    return this.deps.repo.listQuestions(draft.id).filter((q) => q.round === draft.round);
  }

  private unansweredBlocking(draft: DraftRow): string[] {
    const answered = new Set(this.deps.repo.listAnswers(draft.id).filter((a) => !a.skipped).map((a) => a.questionId));
    return this.deps.repo.listQuestions(draft.id).filter((q) => q.decisionImpact === 'blocking' && !answered.has(q.id)).map((q) => q.id);
  }

  private async context(draft: DraftRow): Promise<DraftContext> {
    const cached = this.contexts.get(draft.id);
    if (cached) return cached;
    const project = this.deps.repo.getProject(draft.projectId);
    if (!project) throw new DraftServiceError('NOT_FOUND', 'project が見つかりません');
    const inspection = await this.deps.inspector.inspect(project.path);
    if (!inspection.ok) throw new DraftServiceError('DRAFT_BLOCKED', `リポジトリを再調査できません: ${inspection.message}`);
    const ctx = { digest: inspection.digest, info: inspection.info };
    this.contexts.set(draft.id, ctx);
    return ctx;
  }

  /** モデルを呼び、質問アルゴリズムを適用して次の状態へ遷移する。 */
  private async runRound(draft: DraftRow, round: number, signal: AbortSignal): Promise<DraftView> {
    const ctx = await this.context(draft);
    const asked = this.deps.repo.listQuestions(draft.id);
    const answers = this.deps.repo.listAnswers(draft.id);
    draft = this.deps.repo.updateDraft(draft.id, { state: 'GAP_ANALYZING', round });
    const result = await this.deps.model.interview(
      {
        request: draft.request,
        facts: draft.facts,
        digestText: renderDigest(ctx.digest),
        askedQuestions: asked,
        answers,
        round,
        remainingQuestions: Math.max(0, 15 - asked.length),
        prohibitedOperations: draft.prohibited
      },
      signal
    );
    if (!result.ok) {
      draft = this.deps.repo.updateDraft(draft.id, { state: 'BLOCKED', blockedReason: `Requirements Agent の出力を利用できません: ${result.error}` });
      return this.view(draft);
    }
    const knownSources = new Set<string>([...ctx.digest.tree, 'package.json', 'package.json#scripts', '.git/HEAD', 'git status', ...ctx.digest.configFiles]);
    const gap = analyzeGap({ modelOutput: result.value, inspectorFacts: draft.facts, askedQuestions: asked, answers, round, knownSources });
    if (!gap.ok) {
      draft = this.deps.repo.updateDraft(draft.id, { state: 'BLOCKED', blockedReason: gap.error });
      return this.view(draft);
    }
    const a = gap.analysis;
    draft = this.deps.repo.updateDraft(draft.id, { facts: a.facts, summary: a.interview.summary });
    if (a.blocked) {
      draft = this.deps.repo.updateDraft(draft.id, { state: 'BLOCKED', blockedReason: a.blocked.reason });
      return this.view(draft);
    }
    if (!a.summaryReady) {
      this.deps.repo.addQuestions(draft.id, a.questions.map((q) => ({ ...q, round })));
      draft = this.deps.repo.updateDraft(draft.id, { state: 'ASKING', round });
      return this.view(draft);
    }
    // 質問終了 → 素案生成（RA-09/RA-10）。承認済み・回答済みの判断は拘束力のある前提として渡す（v2.2）
    const decisions = activeDecisions(this.deps.repo.listDecisions(draft.id));
    const proposal = await this.deps.model.propose(
      { request: draft.request, facts: draft.facts, digestText: renderDigest(ctx.digest), askedQuestions: asked, answers, prohibitedOperations: draft.prohibited, summary: a.interview.summary, decisions },
      signal
    );
    if (!proposal.ok) {
      draft = this.deps.repo.updateDraft(draft.id, { state: 'BLOCKED', blockedReason: `タスク素案を生成できません: ${proposal.error}` });
      return this.view(draft);
    }
    const validatedRaw = validateProposal(proposal.value);
    if (!validatedRaw.ok) {
      draft = this.deps.repo.updateDraft(draft.id, { state: 'BLOCKED', blockedReason: validatedRaw.error });
      return this.view(draft);
    }
    // 生成物（v0.2.1、D-41）: GEN- 質問への判断を素案に適用し、生成手段が不明なものは推測せず承認前に尋ねる
    const scriptsMap: Record<string, string> = { ...(ctx.digest.projectScripts ?? {}) };
    const activeGen = activeDecisions(this.deps.repo.listDecisions(draft.id));
    // 入力の分類（v0.2.2、D-42）を付けてから判断を適用する（script の差し替え → 対象外 / 入力なしで続行）
    const validated = { ok: true as const, value: applyGenerationDecisions(attachGeneratorInputs(applyGenerationDecisions(validatedRaw.value, activeGen), ctx.digest.generators ?? {}), activeGen) };
    const unknownGen = unknownGenerationScripts(validated.value.generatedArtifacts, scriptsMap);
    if (unknownGen.length > 0) {
      const nextRound = round + 1;
      const questions = generationQuestions(unknownGen, detectGenerationScripts(scriptsMap, ctx.digest.tree), nextRound);
      if (asked.length + questions.length > 15 || nextRound > 5) {
        draft = this.deps.repo.updateDraft(draft.id, { state: 'BLOCKED', blockedReason: `生成物の更新手段が確定しないまま質問上限に達しました: ${unknownGen.map((a) => `${a.path}（${a.script}）`).join(' / ')}。生成スクリプトを package.json に用意するか、依頼から生成物の更新を外してください。` });
        return this.view(draft);
      }
      this.deps.repo.addQuestions(draft.id, questions);
      this.contexts.set(draft.id, { ...ctx, pendingProposal: validated.value });
      draft = this.deps.repo.updateDraft(draft.id, { state: 'ASKING', round: nextRound, summary: a.interview.summary });
      return this.view(draft);
    }
    // 入力が Git 管理外の生成物（v0.2.2、D-42）: 隔離ワークスペースでは再現できないため、承認前に利用者の判断を求める（推測で続行しない）
    const inputQs = inputQuestions(validated.value.generatedArtifacts, activeGen, round + 1);
    if (inputQs.length > 0) {
      const nextRound = round + 1;
      if (asked.length + inputQs.length > 15 || nextRound > 5) {
        draft = this.deps.repo.updateDraft(draft.id, { state: 'BLOCKED', blockedReason: `生成物の入力不足が未解決のまま質問上限に達しました: ${validated.value.generatedArtifacts.filter((a) => a.inputStatus === 'missing').map((a) => a.path).join(' / ')}` });
        return this.view(draft);
      }
      this.deps.repo.addQuestions(draft.id, inputQs);
      this.contexts.set(draft.id, { ...ctx, pendingProposal: validated.value });
      draft = this.deps.repo.updateDraft(draft.id, { state: 'ASKING', round: nextRound, summary: a.interview.summary });
      return this.view(draft);
    }
    // 矛盾検出（v2.1）: 要件同士 / 要件と既存コード・設定。blocking は承認前に解消させる（質問として差し戻す）
    const contra = await this.deps.model.detectContradictions(
      { request: draft.request, facts: draft.facts, digestText: renderDigest(ctx.digest), askedQuestions: asked, answers, prohibitedOperations: draft.prohibited, summary: a.interview.summary, proposal: validated.value, decisions },
      signal
    );
    if (!contra.ok) {
      draft = this.deps.repo.updateDraft(draft.id, { state: 'BLOCKED', blockedReason: `矛盾検出を実行できません: ${contra.error}` });
      return this.view(draft);
    }
    const contraAnalysis = analyzeContradictions(contra.value, decisions);
    if (!contraAnalysis.ok) {
      draft = this.deps.repo.updateDraft(draft.id, { state: 'BLOCKED', blockedReason: contraAnalysis.error });
      return this.view(draft);
    }
    if (contraAnalysis.blocking.length > 0) {
      const nextRound = round + 1;
      const questions = contradictionsToQuestions(contraAnalysis.blocking, nextRound);
      const totalAsked = asked.length + questions.length;
      if (totalAsked > 15 || nextRound > 5) {
        draft = this.deps.repo.updateDraft(draft.id, { state: 'BLOCKED', contradictions: contraAnalysis.blocking, blockedReason: `重大な矛盾が未解消のまま質問上限に達しました: ${contraAnalysis.blocking.map((c) => c.description).join(' / ')}。依頼内容を見直してください。` });
        return this.view(draft);
      }
      this.deps.repo.addQuestions(draft.id, questions);
      this.contexts.set(draft.id, { ...ctx, pendingProposal: validated.value });
      draft = this.deps.repo.updateDraft(draft.id, { state: 'ASKING', round: nextRound, contradictions: contraAnalysis.blocking, summary: a.interview.summary });
      return this.view(draft);
    }
    const proposalWithMinor: TaskProposal = contraAnalysis.minor.length > 0 ? { ...validated.value, openItems: [...validated.value.openItems, ...contraAnalysis.minor.map((c) => `軽微な矛盾: ${c.description}（推奨: ${c.recommendation}）`)] } : validated.value;
    draft = this.deps.repo.updateDraft(draft.id, { state: 'SUMMARY_READY', round, contradictions: [] });
    const current = this.deps.repo.getRevision(draft.id, draft.currentRevision);
    const revision = current && !current.approved && !current.proposal ? current.revision : this.deps.repo.createRevision(draft.id, null, null, []).revision;
    draft = this.finalizeRevision(draft, revision, proposalWithMinor);
    return this.view(draft);
  }

  /** 素案から task.yaml を生成・検証し、revision に保存。成功なら AWAITING_APPROVAL。 */
  private finalizeRevision(draft: DraftRow, revision: number, proposal: TaskProposal): DraftRow {
    const project = this.deps.repo.getProject(draft.projectId);
    const info = project?.inspected ?? this.contexts.get(draft.id)?.info ?? null;
    const repository = project?.path ?? '';
    const baseRef = info?.defaultBaseRef ?? info?.currentBranch ?? 'HEAD';
    const previous = this.deps.repo.listRevisions(draft.id).find((r) => r.taskYaml);
    const previousTaskId = previous?.taskYaml ? parseAndValidateTaskYaml(previous.taskYaml) : null;
    const profileName = (VERIFICATION_PROFILES as readonly string[]).includes(info?.verificationProfile?.name ?? '') ? (info!.verificationProfile!.name as VerificationProfileName) : 'node-pnpm';
    const generated = generateTask({ proposal, repository, baseRef, verificationProfile: profileName, ...(previousTaskId?.ok ? { taskId: previousTaskId.task.id } : {}) });
    const readiness = info?.verificationProfile?.ready ?? false;
    const errors = [...(generated.ok ? [] : generated.errors), ...(readiness ? [] : [`検証プロファイル ${profileName} を実行できません: ${info?.verificationProfile?.missingScripts.length ? `scripts 不足 ${info.verificationProfile.missingScripts.join(', ')}` : 'package.json と lockfile（pnpm / npm / yarn 1）を確認してください'}`])];
    this.deps.repo.updateRevision(draft.id, revision, { proposal, taskYaml: generated.yaml, validationErrors: errors });
    const state: DraftState = errors.length === 0 ? 'AWAITING_APPROVAL' : 'SUMMARY_READY';
    return this.deps.repo.updateDraft(draft.id, { state, currentRevision: revision });
  }

  /** 戻る: 直前の回答ラウンドを取り消し、そのラウンドの質問を再表示する。 */
  private async back(draft: DraftRow, _signal: AbortSignal): Promise<DraftView> {
    if (['APPROVED', 'YAML_VALIDATED', 'READY_TO_RUN'].includes(draft.state)) throw new DraftServiceError('INVALID_STATE', '承認後は戻れません。要件を編集すると新しい revision になります');
    const answers = this.deps.repo.listAnswers(draft.id);
    const target = previousAnsweredRound(answers);
    if (target === null) throw new DraftServiceError('INVALID_STATE', '戻れる回答がありません');
    // target より後のラウンドの質問（未回答）を削除し、target の回答を取り消す
    for (const q of this.deps.repo.listQuestions(draft.id)) if (q.round > target) this.deps.repo.removeQuestionsForRound(draft.id, q.round);
    // 取り消したラウンドの判断は削除せず retracted にして履歴に残す（v2.2）
    for (const a of this.deps.repo.listAnswers(draft.id)) {
      if (a.round !== target || a.skipped) continue;
      const topicKey = a.questionId.startsWith(CONTRADICTION_QUESTION_PREFIX) ? a.questionId.slice(CONTRADICTION_QUESTION_PREFIX.length) : a.questionId;
      const d = this.deps.repo.getDecision(draft.id, topicKey);
      if (d && d.status === 'active') this.deps.repo.addDecision(draft.id, retractDecision(d));
    }
    this.deps.repo.retractAnswersForRound(draft.id, target);
    const current = this.deps.repo.getRevision(draft.id, draft.currentRevision);
    if (current && !current.approved && current.proposal) {
      // 素案は無効化（再評価後に作り直す）
      this.deps.repo.updateRevision(draft.id, current.revision, { proposal: null, taskYaml: null, validationErrors: [] });
    }
    draft = this.deps.repo.updateDraft(draft.id, { state: 'ASKING', round: target, blockedReason: null, approvedTaskId: null });
    return this.view(draft);
  }

  private view(draft: DraftRow): DraftView {
    const project = this.deps.repo.getProject(draft.projectId);
    const asked = this.deps.repo.listQuestions(draft.id);
    const answers = this.deps.repo.listAnswers(draft.id);
    const rev = this.deps.repo.getRevision(draft.id, draft.currentRevision);
    const info = project?.inspected ?? null;
    return {
      id: draft.id,
      projectPath: project?.path ?? '',
      request: draft.request,
      state: draft.state,
      revision: draft.currentRevision,
      round: draft.round,
      totalQuestionsAsked: asked.length,
      facts: draft.facts as Fact[],
      currentQuestions: draft.state === 'ASKING' ? asked.filter((q) => q.round === draft.round).slice(0, 3) : [],
      askedQuestions: asked,
      answers,
      blockingQuestions: this.unansweredBlocking(draft),
      summary: draft.summary,
      proposal: rev?.proposal ?? null,
      taskYaml: rev?.taskYaml ?? null,
      validationErrors: rev?.validationErrors ?? [],
      blockedReason: draft.state === 'BLOCKED' ? draft.blockedReason : null,
      prohibitedOperations: draft.prohibited,
      verificationReadiness: info?.verificationProfile ? { profile: info.verificationProfile.name, ready: info.verificationProfile.ready, missingScripts: info.verificationProfile.missingScripts, detail: info.verificationProfile.ready ? '実行可能' : `scripts 不足: ${info.verificationProfile.missingScripts.join(', ') || 'lockfile 等'}` } : null,
      contradictions: draft.contradictions,
      decisions: this.deps.repo.listDecisions(draft.id),
      approved: rev?.approved ?? false,
      approvedTaskId: draft.approvedTaskId,
      createdAt: draft.createdAt,
      updatedAt: draft.updatedAt
    };
  }

  /** 同一事項に矛盾する判断があれば新しい方を優先し、古い方を superseded にする（古い判断が新しい明示的指示を上書きしない） */
  private supersedeConflicts(draftId: string): void {
    const { updated } = resolveConflicts(this.deps.repo.listDecisions(draftId));
    for (const d of updated) this.deps.repo.addDecision(draftId, d);
  }

  private emit(view: DraftView): DraftView {
    try {
      this.deps.onDraftUpdated?.(view);
    } catch {
      /* ignore listener failures */
    }
    return view;
  }
}

function stripUndefined<T extends object>(obj: T): Partial<T> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as Partial<T>;
}

function safeSegment(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80) || 'task';
}
