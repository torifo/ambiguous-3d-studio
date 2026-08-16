/// <reference types="vite/client" />

interface ImportMetaEnv {
  /**
   * Phase 3 (WebAR) feature flag. Vite env vars are always strings:
   * the value 'true' enables AR; anything else (including unset) disables it.
   * The published GitHub Pages build sets this to 'false' (NFR-041).
   */
  readonly VITE_ENABLE_AR: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
