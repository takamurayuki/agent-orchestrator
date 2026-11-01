import type { Answer, AskedQuestion } from '@agent-orchestrator/contracts';

/**
 * 質問ラウンドの決定的な補助関数（RA-06: 回答/スキップ/戻る）。
 */
export interface AnswerInput {
  questionId: string;
  value: string | null;
  skipped: boolean;
}

export type AnswerValidation = { ok: true; answers: Answer[]; skippedBlocking: AskedQuestion[] } | { ok: false; error: string };

/** 現在ラウンドの質問に対する回答を検証し、Answer レコードに変換する。選択肢がある質問は value が選択肢または自由入力（文字列）。 */
export function validateAnswers(currentQuestions: AskedQuestion[], inputs: AnswerInput[], round: number, now: string): AnswerValidation {
  if (inputs.length === 0) return { ok: false, error: '回答がありません' };
  const byId = new Map(currentQuestions.map((q) => [q.id, q]));
  const seen = new Set<string>();
  const answers: Answer[] = [];
  const skippedBlocking: AskedQuestion[] = [];
  for (const a of inputs) {
    const q = byId.get(a.questionId);
    if (!q) return { ok: false, error: `現在のラウンドにない質問 ID です: ${a.questionId}` };
    if (seen.has(a.questionId)) return { ok: false, error: `質問 ${a.questionId} への回答が重複しています` };
    seen.add(a.questionId);
    if (!a.skipped && (a.value === null || a.value.trim() === '')) return { ok: false, error: `質問 ${a.questionId} の回答が空です（スキップする場合は skipped を指定）` };
    if (a.skipped && q.decisionImpact === 'blocking') skippedBlocking.push(q);
    answers.push({ questionId: a.questionId, round, value: a.skipped ? null : (a.value ?? '').trim(), skipped: a.skipped, answeredAt: now });
  }
  // 未回答の質問はスキップ扱いにしない: すべての質問に回答またはスキップが必要
  const missing = currentQuestions.filter((q) => !seen.has(q.id));
  if (missing.length > 0) return { ok: false, error: `未回答の質問があります: ${missing.map((m) => m.id).join(', ')}（スキップする場合は skipped: true）` };
  return { ok: true, answers, skippedBlocking };
}

/** 選択肢付き質問の回答が選択肢外の自由入力かどうか（UI 表示用。拒否はしない）。 */
export function isFreeTextAnswer(question: AskedQuestion, value: string): boolean {
  return question.options.length > 0 && !question.options.some((o) => o.value === value);
}

/** 「戻る」で戻る先のラウンド番号。回答済みの最大ラウンド。無ければ null */
export function previousAnsweredRound(answers: Answer[]): number | null {
  const rounds = answers.map((a) => a.round);
  return rounds.length === 0 ? null : Math.max(...rounds);
}
