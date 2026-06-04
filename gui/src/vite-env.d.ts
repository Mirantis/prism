/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Absolute runtime URL for packaged builds (e.g. http://localhost:3003). */
  readonly VITE_RUNTIME_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
