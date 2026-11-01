<script lang="ts">
  import { onMount } from 'svelte';
  import { SCREENS, app, type Screen } from './lib/stores/app.svelte';
  import { initApp } from './lib/stores/actions';
  import Home from './components/Home.svelte';
  import Interview from './components/Interview.svelte';
  import Running from './components/Running.svelte';
  import Result from './components/Result.svelte';
  import Alert from './lib/components/Alert.svelte';

  onMount(() => {
    void initApp();
  });

  function available(screen: Screen): boolean {
    if (screen === 'interview') return app.draft !== null;
    if (screen === 'running') return app.run !== null;
    return true;
  }
</script>

<div class="app">
  <header class="topbar">
    <div class="brand">
      <span class="logo" aria-hidden="true">◎</span>
      <span>Agent Orchestrator</span>
    </div>
    <nav aria-label="画面切り替え" data-testid="screen-nav">
      <ul>
        {#each SCREENS as s (s.id)}
          <li>
            <button type="button" class:active={app.screen === s.id} aria-current={app.screen === s.id ? 'page' : undefined} disabled={!available(s.id)} onclick={() => app.navigate(s.id)} title={s.description} data-testid="nav-{s.id}">
              {s.label}
            </button>
          </li>
        {/each}
      </ul>
    </nav>
  </header>

  <main id="main" tabindex="-1">
    {#if app.error}
      <div style="margin-bottom: 1rem">
        <Alert tone="danger" role="alert" title={app.error.message} message={`エラーコード: ${app.error.code}`} testid="global-error">
          <button type="button" class="link" onclick={() => (app.error = null)}>閉じる</button>
        </Alert>
      </div>
    {/if}

    {#if app.screen === 'home'}
      <Home />
    {:else if app.screen === 'interview'}
      <Interview />
    {:else if app.screen === 'running'}
      <Running />
    {:else}
      <Result />
    {/if}
  </main>

  <footer class="statusbar">
    <span data-testid="transport-kind">接続: {app.transportKind === 'tauri' ? 'Tauri（ローカルランナー）' : 'モック（ブラウザ開発用）'}</span>
    <span data-testid="runner-alive">ランナー: {app.runnerAlive === null ? '確認中' : app.runnerAlive ? '稼働中' : '停止'}</span>
    {#if app.busy}
      <span role="status">{app.busy}中…</span>
    {/if}
  </footer>

  <div class="sr-only" aria-live="polite" aria-atomic="true" data-testid="live-region">{app.live}</div>
</div>

<style>
  .app {
    min-height: 100vh;
    display: grid;
    grid-template-rows: auto 1fr auto;
  }
  .topbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    padding: 0.6rem 1.25rem;
    background: var(--surface);
    border-bottom: 1px solid var(--border);
    position: sticky;
    top: 0;
    z-index: 2;
  }
  .brand {
    font-weight: 700;
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }
  .logo {
    color: var(--primary);
    font-size: 1.3rem;
  }
  nav ul {
    list-style: none;
    display: flex;
    gap: 0.4rem;
    margin: 0;
    padding: 0;
  }
  nav button.active {
    background: var(--primary);
    color: var(--primary-text);
    border-color: var(--primary);
    font-weight: 700;
  }
  main {
    padding: 1.25rem;
    max-width: 1400px;
    width: 100%;
    margin: 0 auto;
  }
  .statusbar {
    display: flex;
    gap: 1.5rem;
    padding: 0.4rem 1.25rem;
    border-top: 1px solid var(--border);
    background: var(--surface);
    font-size: 0.85rem;
    color: var(--muted);
  }
</style>
