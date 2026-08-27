/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_PACT_API_BASE: string;
  readonly VITE_PACT_ROOM?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
