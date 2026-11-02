<script lang="ts">
  import type { SandboxSetupState } from '@agent-orchestrator/contracts';
  import Alert from './Alert.svelte';
  import StatusBadge from './StatusBadge.svelte';

  interface Props {
    setup: SandboxSetupState | null;
    busy: boolean;
    onStart: (policy: 'pinned' | 'latest') => void;
    /** 既にイメージがあり、更新のために再ビルドする場合（文言が変わる） */
    update?: boolean;
    onCancel: () => void;
  }

  let { setup, busy, onStart, onCancel, update = false }: Props = $props();
  let consent = $state(false);
  let policy = $state<'pinned' | 'latest'>('pinned');

  const running = $derived(setup?.state === 'running');
  const manifest = $derived(setup?.manifest ?? null);
  const stepLabel: Record<string, string> = { pending: '待機', running: '実行中', ok: '完了', fail: '失敗', skipped: '中止' };
  const stepTone: Record<string, 'neutral' | 'info' | 'success' | 'danger' | 'warning'> = { pending: 'neutral', running: 'info', ok: 'success', fail: 'danger', skipped: 'warning' };
  const startLabel = $derived(setup?.state === 'failed' || setup?.state === 'cancelled' ? '再試行' : update ? 'サンドボックスを更新する' : 'サンドボックスを準備する');
</script>

<section class="setup" aria-labelledby="sandbox-heading" data-testid="sandbox-setup" data-state={setup?.state ?? 'idle'}>
  <h3 id="sandbox-heading">{update ? 'サンドボックスを更新する（再ビルド・数分）' : 'サンドボックスを準備する（初回のみ・数分）'}</h3>
  <p class="small">
    {update ? 'AI を隔離して動かす Docker イメージを作り直します（脆弱性対応やツールの更新）。' : 'AI を隔離して動かすための Docker イメージがまだありません。'}このアプリから固定された手順で用意できます:
    Docker Hub から<strong>ピン留めしたベースイメージ</strong>を取得し、その内容が記録済みのダイジェストと一致することを確認してから、2 つのイメージ（AI 実行用・通信制限プロキシ用）をローカルでビルドします。
    取得・ビルドする内容は固定で、任意のコマンドは実行しません。失敗した場合はイメージを使わず停止します。
  </p>
  {#if manifest}
    <dl class="small manifest">
      <dt>ベースイメージ</dt>
      <dd><code>{manifest.baseImage}</code><span class="muted">（ダイジェスト <code>{manifest.baseDigest.slice(0, 19)}…</code>）</span></dd>
      <dt>作成するイメージ</dt>
      <dd>{manifest.images.map((i) => `${i.label}（${i.tag}）`).join('、')}</dd>
      {#if manifest.toolchain}
        <dt>固定版のツール</dt>
        <dd>{Object.entries(manifest.toolchain).map(([k, v]) => `${k} ${v}`).join('、')}</dd>
      {/if}
    </dl>
  {/if}

  {#if !running}
    <fieldset class="policy" data-testid="sandbox-policy">
      <legend>版の方針</legend>
      <label class="option"><input type="radio" name="sandbox-policy" value="pinned" bind:group={policy} disabled={busy} /> <span><strong>固定版</strong><span class="small muted">: 検証済みの版（ベースイメージのダイジェスト・エージェント・pnpm・uv）。再現性を優先</span></span></label>
      <label class="option"><input type="radio" name="sandbox-policy" value="latest" bind:group={policy} disabled={busy} /> <span><strong>最新版</strong><span class="small muted">: 取得時点の最新（ベースの浮動タグとツールの latest）。取得した版はイメージに記録され、環境チェックに表示。脆弱性対応を優先</span></span></label>
    </fieldset>
  {/if}

  {#if !running}
    <div class="consent">
      <input type="checkbox" id="sandbox-consent" bind:checked={consent} disabled={busy} data-testid="sandbox-consent" />
      <label for="sandbox-consent">Docker Hub からベースイメージ（約 70 MB）と、npm / PyPI からツールを取得することに同意する</label>
    </div>
  {/if}
  <div class="row">
    {#if running}
      <button type="button" class="danger" onclick={onCancel} disabled={busy} data-testid="sandbox-cancel">準備を中止</button>
      <span class="small muted" role="status">準備中です。ネットワーク速度により数分かかります。</span>
    {:else}
      <button type="button" class="primary" onclick={() => onStart(policy)} disabled={busy || !consent} data-testid="sandbox-start">{startLabel}</button>
      {#if !consent}<span class="small muted">同意にチェックすると開始できます。</span>{/if}
    {/if}
  </div>

  {#if setup && setup.state !== 'idle'}
    <ol class="steps" aria-label="準備の手順" data-testid="sandbox-steps">
      {#each setup.steps as step (step.id)}
        <li data-status={step.status}>
          <StatusBadge label={stepLabel[step.status] ?? step.status} tone={stepTone[step.status] ?? 'neutral'} />
          {step.label}
          {#if step.detail}<span class="small muted"> — {step.detail}</span>{/if}
        </li>
      {/each}
    </ol>
    {#if setup.state === 'succeeded'}
      <Alert tone="success" role="status" title="サンドボックスの準備が完了しました" message="環境を再チェックしています。完了すると依頼を開始できます。" testid="sandbox-done" />
    {:else if setup.state === 'cancelled'}
      <Alert tone="warning" role="status" title="準備を中止しました" message="途中の状態は残しません。準備を続ける場合は「再試行」を押してください。" testid="sandbox-cancelled" />
    {:else if setup.state === 'failed' && setup.error}
      <Alert tone="danger" role="alert" title="サンドボックスの準備に失敗しました" testid="sandbox-error">
        <p class="small"><strong>原因:</strong> {setup.error.message}<span class="muted">（{setup.error.code}）</span></p>
        <p class="small"><strong>復旧方法:</strong> {setup.error.fix}</p>
      </Alert>
    {/if}
    {#if setup.logTail.length > 0}
      <details data-testid="sandbox-log">
        <summary>詳細ログ（末尾 {setup.logTail.length} 行、秘密情報はマスキング済み）</summary>
        <pre>{setup.logTail.join('\n')}</pre>
      </details>
    {/if}
  {/if}
</section>

<style>
  .policy {
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 0.5rem 0.8rem;
    margin: 0.5rem 0;
    display: grid;
    gap: 0.35rem;
  }
  .policy legend {
    padding: 0 0.3rem;
  }
  .policy .option {
    display: flex;
    gap: 0.5rem;
    align-items: flex-start;
    font-weight: 400;
    margin: 0;
  }
  .policy input {
    margin-top: 0.3rem;
  }
  .setup {
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 0.75rem 1rem;
    margin: 0.75rem 0;
    background: var(--surface-alt);
  }
  .manifest {
    margin: 0.5rem 0;
  }
  .consent {
    display: flex;
    gap: 0.5rem;
    align-items: center;
    margin: 0.6rem 0;
  }
  .consent label {
    margin: 0;
  }
  .consent input {
    width: 1.2rem;
    height: 1.2rem;
  }
  .steps {
    list-style: none;
    padding: 0;
    margin: 0.75rem 0 0.5rem;
    display: grid;
    gap: 0.3rem;
  }
  pre {
    max-height: 14rem;
    overflow: auto;
    font-size: 0.8rem;
  }
</style>
