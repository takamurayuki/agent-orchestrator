<script lang="ts">
  import type { EnvironmentReport } from '@agent-orchestrator/contracts';
  import { ENV_STATUS_LABELS, ENV_STATUS_TONES, formatDateTime } from '../labels';
  import type { UiError } from '../stores/app.svelte';
  import StatusBadge from './StatusBadge.svelte';
  import Alert from './Alert.svelte';

  interface Props {
    report: EnvironmentReport | null;
    error: UiError | null;
    busy: boolean;
    onRecheck: () => void;
  }

  let { report, error, busy, onRecheck }: Props = $props();

  const modeLabels: Record<string, string> = {
    'docker-desktop-windows': 'Docker Desktop (Windows コンテナ)',
    'docker-linux': 'Docker (Linux)',
    'docker-wsl': 'Docker (WSL2 バックエンド)',
    unavailable: '実行環境なし'
  };
</script>

<section class="card" aria-labelledby="setup-heading" data-testid="setup-check">
  <div class="row" style="justify-content: space-between">
    <h2 id="setup-heading">セットアップチェック</h2>
    <button type="button" onclick={onRecheck} disabled={busy} aria-label="環境を再チェック">再チェック</button>
  </div>

  {#if error}
    <Alert tone="danger" role="alert" title="環境チェックを実行できません" message={`${error.message} (${error.code})`} testid="env-error">
      <p class="small">ランナー（Node サイドカー）が起動しているか確認してください。開発時は <code>pnpm --filter @agent-orchestrator/runner build</code> を実行してから再チェックしてください。</p>
    </Alert>
  {:else if !report}
    <p class="muted" role="status">環境を確認しています…</p>
  {:else}
    <p>
      <StatusBadge
        label={report.canRun ? '実行可能' : '実行不可：セットアップが必要です'}
        tone={report.canRun ? 'success' : 'danger'}
        testid="env-status"
      />
      <span class="small muted" style="margin-left: 0.6rem">
        実行モード: {modeLabels[report.executionMode] ?? report.executionMode} ／ 確認時刻: {formatDateTime(report.checkedAt)}
      </span>
    </p>
    {#if !report.canRun}
      <Alert tone="warning" role="status" title="実行環境が整っていないため、依頼の開始はできません">
        <p class="small">プロジェクトの確認や過去の履歴の閲覧はできます。以下の修正方法に従って環境を整えてから「再チェック」を押してください。</p>
      </Alert>
    {/if}
    <ul class="checks" aria-label="環境チェック項目">
      {#each report.checks as check (check.id)}
        <li class="check" data-testid="env-check" data-status={check.status}>
          <div class="row">
            <StatusBadge label={ENV_STATUS_LABELS[check.status] ?? check.status} tone={ENV_STATUS_TONES[check.status] ?? 'neutral'} />
            <strong>{check.label}</strong>
          </div>
          <div class="small">{check.detail}</div>
          {#if check.fix}
            <div class="fix small"><span class="fix-label">修正方法:</span> {check.fix}</div>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
</section>

<style>
  .checks {
    list-style: none;
    padding: 0;
    margin: 0.5rem 0 0;
    display: grid;
    gap: 0.5rem;
  }
  .check {
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 0.5rem 0.75rem;
  }
  .fix {
    margin-top: 0.25rem;
    padding: 0.4rem 0.6rem;
    background: var(--warning-bg);
    border-left: 4px solid var(--warning);
    border-radius: 4px;
  }
  .fix-label {
    font-weight: 600;
  }
</style>
