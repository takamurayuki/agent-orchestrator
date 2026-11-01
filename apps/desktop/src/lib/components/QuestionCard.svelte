<script lang="ts">
  import type { AskedQuestion } from '@agent-orchestrator/contracts';
  import StatusBadge from './StatusBadge.svelte';
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

<article class="card question" aria-labelledby="{groupName}-title" data-testid="question-card" data-question-id={question.id}>
  <header class="row" style="justify-content: space-between; align-items: flex-start">
    <h3 id="{groupName}-title">
      <span class="muted small">質問 {index}</span><br />
      {question.question}
    </h3>
    <StatusBadge label={blocking ? '必須（回答しないと進めません）' : '任意'} tone={blocking ? 'warning' : 'neutral'} />
  </header>

  <fieldset {disabled}>
    <legend>選択肢</legend>
    {#each question.options as option (option.value)}
      <div class="option">
        <input type="radio" id="{groupName}-{option.value}" name={groupName} value={option.value} checked={answer.value === option.value && !answer.skipped} onchange={() => selectOption(option.value)} />
        <label for="{groupName}-{option.value}">{option.label}</label>
      </div>
    {/each}
    <div class="option free">
      <label for="{groupName}-free">その他（自由入力）</label>
      <input type="text" id="{groupName}-free" value={freeText} placeholder="選択肢にない場合はここに入力" oninput={(e) => setFreeText((e.currentTarget as HTMLInputElement).value)} />
    </div>
  </fieldset>

  <aside class="recommendation" aria-label="推奨案（AI の提案であり、確認済みの事実ではありません）">
    <div class="rec-title">推奨案（AI の提案）</div>
    <p class="small">{question.recommendation}</p>
    <p class="small muted">※ 推奨案は確定事項ではありません。上の選択肢で決定してください。</p>
  </aside>

  <div class="row" style="justify-content: space-between">
    <button type="button" onclick={toggleSkip} {disabled} aria-pressed={answer.skipped} data-testid="skip-question">
      {answer.skipped ? 'スキップを取り消す' : 'この質問をスキップ'}
    </button>
    <span class="small" role="status">
      {#if answer.skipped}
        スキップ予定{blocking ? '（必須のため要件は確定できず BLOCKED になります）' : ''}
      {:else if unanswered}
        未回答{blocking ? '（必須）' : ''}
      {:else}
        回答済み
      {/if}
    </span>
  </div>
</article>

<style>
  .question {
    display: grid;
    gap: 0.7rem;
  }
  .option {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.2rem 0;
  }
  .option label {
    margin: 0;
    font-weight: 400;
  }
  .option.free {
    display: block;
    margin-top: 0.4rem;
  }
  .option.free label {
    font-weight: 600;
    margin-bottom: 0.2rem;
  }
  .recommendation {
    border: 1px dashed var(--info);
    background: var(--info-bg);
    border-radius: var(--radius);
    padding: 0.5rem 0.75rem;
  }
  .rec-title {
    font-weight: 700;
    color: var(--info);
  }
</style>
