<script lang="ts">
  import type { EnvironmentReport, SandboxSetupState } from '@agent-orchestrator/contracts';
  import SandboxSetup from './SandboxSetup.svelte';
  import { ENV_STATUS_LABELS, ENV_STATUS_TONES, formatDateTime } from '../labels';
  import type { UiError } from '../stores/app.svelte';
  import StatusBadge from './StatusBadge.svelte';
  import Alert from './Alert.svelte';

  interface Props {
    report: EnvironmentReport | null;
    error: UiError | null;
    busy: boolean;
    onRecheck: () => void;
    setup?: SandboxSetupState | null;
    onSandboxStart?: () => void;
    onSandboxCancel?: () => void;
    /** 右のレール用: 状態 1 行 + 折りたたみの項目一覧（問題がある項目だけ常時表示） */
    compact?: boolean;
  }

  let { report, error, busy, onRecheck, setup = null, onSandboxStart, onSandboxCancel, compact = false }: Props = $props();
  const imagesMissing = $derived(report ? report.checks.some((c) => c.id.startsWith('docker.image.') && c.status === 'fail') : false);
  const dockerFailing = $derived(report ? report.checks.some((c) => (c.id === 'docker' || c.id === 'docker.cli' || c.id === 'docker.daemon') && c.status === 'fail') : false);
  const attention = $derived(report ? report.checks.filter((c) => c.status !== 'ok') : []);
  const okChecks = $derived(report ? report.checks.filter((c) => c.status === 'ok') : []);

  const modeLabels: Record<string, string> = {
    'docker-desktop-windows': 'Docker Desktop (Windows コンテナ)',
    'docker-linux': 'Docker (Linux)',
    'docker-wsl': 'Docker (WSL2 バックエンド)',
    unavailable: '実行環境なし'
  };
</script>

<section class="card" class:quiet={compact} aria-labelledby="setup-heading" data-testid="setup-check">
  <div class="row between">
    <h2 id="setup-heading">セットアップチェック</h2>
    <button type="button" class="ghost small" onclick={onRecheck} disabled={busy} aria-label="環境を再チェック">再チェック</button>
  </div>

  {#if error}
    <Alert tone="danger" role="alert" title="環境チェックを実行できません" message={`${error.message} (${error.code})`} testid="env-error">
      <p class="small">ランナー（Node サイドカー）が起動しているか確認してください。開発時は <code>pnpm --filter @agent-orchestrator/runner build</code> を実行してから再チェックしてください。</p>
    </Alert>
  {:else if !report}
    <p class="muted" role="status">環境を確認しています…</p>
  {:else}
    <div class="status">
      <StatusBadge label={report.canRun ? '実行可能' : '実行不可：セットアップが必要です'} tone={report.canRun ? 'success' : 'danger'} testid="env-status" />
      <div class="tiny muted">{modeLabels[report.executionMode] ?? report.executionMode} ／ 確認時刻 {formatDateTime(report.checkedAt)}</div>
    </div>
    {#if !report.canRun}
      <Alert tone="warning" role="status" title="実行環境が整っていないため、依頼の開始はできません">
        <p class="small">プロジェクトの確認や過去の履歴の閲覧はできます。以下の修正方法に従って環境を整えてから「再チェック」を押してください。</p>
      </Alert>
    {/if}
    {#if (imagesMissing && !dockerFailing) || (setup && setup.state !== 'idle')}
      <SandboxSetup {setup} {busy} onStart={() => onSandboxStart?.()} onCancel={() => onSandboxCancel?.()} />
    {/if}

    {#if compact}
      {#if attention.length > 0}
        <ul class="list-plain" aria-label="確認が必要な項目">
          {#each attention as check (check.id)}
            <li class="check-row" data-testid="env-check" data-status={check.status}>
              <StatusBadge label={ENV_STATUS_LABELS[check.status] ?? check.status} tone={ENV_STATUS_TONES[check.status] ?? 'neutral'} />
              <strong>{check.label}</strong>
              <div class="detail">{check.detail}</div>
              {#if check.fix}<div class="fix"><strong>修正方法:</strong> {check.fix}</div>{/if}
            </li>
          {/each}
        </ul>
      {/if}
      <details class="section" data-testid="env-ok">
        <summary>正常 {okChecks.length} 件</summary>
        <ul class="list-plain" aria-label="環境チェック項目">
          {#each okChecks as check (check.id)}
            <li class="check-row" data-testid="env-check" data-status={check.status}>
              <StatusBadge label={ENV_STATUS_LABELS[check.status] ?? check.status} tone={ENV_STATUS_TONES[check.status] ?? 'neutral'} />
              <strong>{check.label}</strong>
              <div class="detail">{check.detail}</div>
            </li>
          {/each}
        </ul>
      </details>
    {:else}
      <ul class="list-plain" aria-label="環境チェック項目">
        {#each report.checks as check (check.id)}
          <li class="check-row" data-testid="env-check" data-status={check.status}>
            <StatusBadge label={ENV_STATUS_LABELS[check.status] ?? check.status} tone={ENV_STATUS_TONES[check.status] ?? 'neutral'} />
            <strong>{check.label}</strong>
            <div class="detail">{check.detail}</div>
            {#if check.fix}<div class="fix"><strong>修正方法:</strong> {check.fix}</div>{/if}
          </li>
        {/each}
      </ul>
    {/if}
  {/if}
</section>

<style>
  .status {
    display: grid;
    gap: 0.2rem;
    margin: 0.3rem 0 0.6rem;
  }
  button.small {
    min-height: 1.9rem;
    padding: 0.2rem 0.6rem;
    font-size: 0.82rem;
  }
</style>
