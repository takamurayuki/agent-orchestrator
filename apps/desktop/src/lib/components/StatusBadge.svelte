<script lang="ts">
  import type { Tone } from '../labels';

  interface Props {
    /** Human-readable Japanese label (always shown as text). */
    label: string;
    /** Machine code shown alongside the label, e.g. INTERRUPTED. */
    code?: string;
    tone?: Tone;
    testid?: string;
  }

  let { label, code, tone = 'neutral', testid }: Props = $props();

  const marks: Record<Tone, string> = {
    success: '✔',
    warning: '!',
    danger: '✖',
    info: '●',
    neutral: '○'
  };
</script>

<span class="badge {tone}" data-testid={testid} data-tone={tone}>
  <span aria-hidden="true">{marks[tone]}</span>
  <span>{label}</span>
  {#if code}
    <span class="code">({code})</span>
  {/if}
</span>

<style>
  .code {
    font-weight: 400;
    font-family: var(--mono);
    font-size: 0.8em;
  }
</style>
