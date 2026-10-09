/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_WS_URL?: string;
  readonly VITE_API_URL?: string;
  readonly VITE_VIEWER_TOKEN?: string;
  /** Nombre anterior de VITE_VIEWER_TOKEN, aceptado por compatibilidad. */
  readonly VITE_AUTH_TOKEN?: string;
  readonly VITE_RETENTION_MIN?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
