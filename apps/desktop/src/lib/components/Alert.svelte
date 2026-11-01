<script lang="ts">
  import type { Snippet } from 'svelte';
  import type { Tone } from '../labels';

  interface Props {
    tone?: Tone;
    title?: string;
    message?: string;
    role?: 'alert' | 'status' | 'note';
    testid?: string;
    children?: Snippet;
  }

  let { tone = 'info', title, message, role = 'note', testid, children }: Props = $props();

  const prefix: Record<Tone, string> = {
    danger: 'エラー',
    warning: '注意',
    info: '情報',
    success: '成功',
    neutral: ''
  };
</script>

<div class="alert {tone}" role={role === 'note' ? undefined : role} data-testid={testid}>
  {#if title}
    <strong>{prefix[tone] ? `${prefix[tone]}: ` : ''}{title}</strong>
  {/if}
  {#if message}
    <div>{message}</div>
  {/if}
  {@render children?.()}
</div>
