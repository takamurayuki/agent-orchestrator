/// <reference types="svelte" />
/// <reference types="vite/client" />

interface Window {
  /** Present only inside the Tauri webview. */
  __TAURI_INTERNALS__?: unknown;
}
