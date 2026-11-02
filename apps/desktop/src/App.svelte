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
        {#each SCREENS as s, i (s.id)}
          <li>
            <button type="button" class:active={app.screen === s.id} aria-current={app.screen === s.id ? 'page' : undefined} disabled={!available(s.id)} onclick={() => app.navigate(s.id)} title={`${i + 1}. ${s.description}`} data-testid="nav-{s.id}">
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
      <span role="status" class="busy"><span class="dot" aria-hidden="true"></span>{app.busy}中…</span>
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
    padding: 0.55rem 1.4rem;
    background: var(--surface);
    border-bottom: 1px solid var(--border);
    position: sticky;
    top: 0;
    z-index: 4;
  }
  .brand {
    font-weight: 700;
    display: flex;
    align-items: center;
    gap: 0.5rem;
    letter-spacing: -0.01em;
  }
  .logo {
    color: var(--primary);
    font-size: 1.25rem;
  }
  nav ul {
    list-style: none;
    display: flex;
    gap: 0.25rem;
    margin: 0;
    padding: 0.2rem;
    background: var(--surface-sunken);
    border-radius: 999px;
  }
  nav button {
    border: none;
    background: transparent;
    border-radius: 999px;
    min-height: 2.1rem;
    padding: 0.3rem 0.95rem;
    color: var(--muted);
    font-weight: 600;
  }
  nav button:hover:not(:disabled) {
    background: var(--surface);
    color: var(--text);
  }
  nav button.active {
    background: var(--surface);
    color: var(--primary);
    box-shadow: var(--shadow-sm);
  }
  nav button:disabled {
    opacity: 0.45;
  }
  main {
    padding: 1.25rem 1.4rem 2rem;
    max-width: 1280px;
    width: 100%;
    margin: 0 auto;
  }
  main:focus {
    outline: none;
  }
  .statusbar {
    display: flex;
    gap: 1.5rem;
    padding: 0.4rem 1.4rem;
    border-top: 1px solid var(--border);
    background: var(--surface);
    color: var(--muted);
    font-size: 0.8rem;
  }
  .busy {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    color: var(--primary);
  }
  .dot {
    width: 0.5rem;
    height: 0.5rem;
    border-radius: 50%;
    background: var(--primary);
    animation: pulse 1.2s ease-in-out infinite;
  }
  @keyframes pulse {
    0%,
    100% {
      opacity: 0.35;
    }
    50% {
      opacity: 1;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .dot {
      animation: none;
    }
  }
</style>
