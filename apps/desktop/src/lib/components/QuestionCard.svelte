<script lang="ts">
  import type { AskedQuestion } from '@agent-orchestrator/contracts';
  import type { QuestionDraftAnswer } from './types';

  interface Props {
    question: AskedQuestion;
    index: number;
    answer: QuestionDraftAnswer;
    disabled?: boolean;
    onChange: (next: QuestionDraftAnswer) => void;
  }

  let { question, index, answer, disabled = false, onChange }: Props = $props();

  const groupName = $derived(`q-${question.id}`);
  const isOption = $derived(question.options.some((o) => o.value === answer.value));
  const freeText = $derived(isOption ? '' : answer.value);
  const blocking = $derived(question.decisionImpact === 'blocking');
  const unanswered = $derived(!answer.skipped && answer.value.trim() === '');

  function selectOption(value: string) {
    onChange({ value, skipped: false });
  }
  function setFreeText(text: string) {
    onChange({ value: text, skipped: false });
  }
  function toggleSkip() {
    onChange({ value: answer.skipped ? answer.value : '', skipped: !answer.skipped });
  }
</script>

<article class="card question" class:answered={!unanswered && !answer.skipped} class:skipped={answer.skipped} aria-labelledby="{groupName}-title" data-testid="question-card" data-question-id={question.id}>
  <header class="q-head">
    <span class="stepnum" aria-hidden="true">{index}</span>
    <div class="q-title">
      <h3 id="{groupName}-title">{question.question}</h3>
      <span class="tiny" class:must={blocking} class:muted={!blocking}>{blocking ? '必須（回答しないと進めません）' : '任意'}</span>
    </div>
  </header>

  <fieldset {disabled}>
    <legend class="sr-only">選択肢</legend>
    <div class="options" role="radiogroup" aria-label="選択肢">
      {#each question.options as option (option.value)}
        <label class="option" class:checked={answer.value === option.value && !answer.skipped} for="{groupName}-{option.value}">
          <input type="radio" id="{groupName}-{option.value}" name={groupName} value={option.value} checked={answer.value === option.value && !answer.skipped} onchange={() => selectOption(option.value)} />
          <span>{option.label}</span>
        </label>
      {/each}
    </div>
    <div class="free">
      <label for="{groupName}-free" class="tiny muted">その他</label>
      <input type="text" id="{groupName}-free" value={freeText} placeholder="選択肢にない場合はここに入力" oninput={(e) => setFreeText((e.currentTarget as HTMLInputElement).value)} />
    </div>
  </fieldset>

  <aside class="recommendation" aria-label="推奨案（AI の提案であり、確認済みの事実ではありません）">
    <span class="rec-icon" aria-hidden="true">💡</span>
    <div>
      <span class="rec-title">推奨案（AI の提案）</span>
      <span class="small">{question.recommendation}</span>
      <span class="tiny muted"> ※ 確定事項ではありません。上の選択肢で決定してください。</span>
    </div>
  </aside>

  <footer class="row between">
    <span class="tiny" role="status" class:muted={!answer.skipped}>
      {#if answer.skipped}
        スキップ予定{blocking ? '（必須のため要件は確定できず BLOCKED になります）' : ''}
      {:else if unanswered}
        未回答{blocking ? '（必須）' : ''}
      {:else}
        回答済み
      {/if}
    </span>
    <button type="button" class="link" onclick={toggleSkip} {disabled} aria-pressed={answer.skipped} data-testid="skip-question">
      {answer.skipped ? 'スキップを取り消す' : 'この質問をスキップ'}
    </button>
  </footer>
</article>

<style>
  .question {
    display: grid;
    gap: 0.75rem;
    border-left: 4px solid var(--border-strong);
  }
  .question.answered {
    border-left-color: var(--success);
  }
  .question.skipped {
    border-left-color: var(--warning);
  }
  .q-head {
    display: flex;
    gap: 0.7rem;
    align-items: flex-start;
  }
  .q-title h3 {
    font-size: 1.02rem;
    margin: 0 0 0.15rem;
  }
  .must {
    color: var(--warning);
    font-weight: 600;
  }
  .options {
    display: grid;
    gap: 0.35rem;
  }
  .option {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    padding: 0.5rem 0.75rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    font-weight: 400;
    margin: 0;
    cursor: pointer;
    background: var(--surface);
  }
  .option:hover {
    border-color: var(--muted);
  }
  .option.checked {
    border-color: var(--primary);
    background: var(--primary-soft);
  }
  .option input {
    margin: 0;
    width: 1.05rem;
    height: 1.05rem;
    accent-color: var(--primary);
  }
  .free {
    margin-top: 0.4rem;
    display: grid;
    grid-template-columns: auto 1fr;
    align-items: center;
    gap: 0.6rem;
  }
  .free label {
    margin: 0;
    font-weight: 500;
    white-space: nowrap;
  }
  .free input {
    padding: 0.35rem 0.6rem;
    font-size: 0.9rem;
  }
  .recommendation {
    display: flex;
    gap: 0.55rem;
    align-items: flex-start;
    padding: 0.5rem 0.7rem;
    background: var(--surface-alt);
    border-radius: var(--radius-sm);
  }
  .rec-icon {
    flex: 0 0 auto;
  }
  .rec-title {
    font-weight: 700;
    font-size: 0.82rem;
    color: var(--text-soft);
    margin-right: 0.35rem;
  }
</style>
