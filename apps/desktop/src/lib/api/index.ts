import type { Transport } from './transport';
import { TauriTransport } from './tauri';
import { MockTransport } from './mock';

export * from './transport';

let instance: Transport | null = null;

/** Tauri when running inside the webview, otherwise the in-browser mock (dev / Playwright). */
export function getTransport(): Transport {
  if (instance) return instance;
  const inTauri = typeof window !== 'undefined' && typeof window.__TAURI_INTERNALS__ !== 'undefined';
  instance = inTauri ? new TauriTransport() : new MockTransport(new URLSearchParams(window.location.search));
  return instance;
}
