// Build-time env vars exposed by Vite (see vite.config.ts).
interface ImportMetaEnv {
  readonly VITE_APP_VERSION: string;
}
interface ImportMeta {
  readonly env: ImportMetaEnv;
}
