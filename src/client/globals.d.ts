// Build-time env vars exposed by Vite (see vite.config.ts).
interface ImportMetaEnv {
  readonly VITE_APP_VERSION: string;
}
interface ImportMeta {
  readonly env: ImportMetaEnv;
}

// Dev-console handle for ad-hoc tweaks (see main.ts). Declared here so
// the assignment doesn't need an `as unknown` cast at the call site.
interface Window {
  stellata: import('./stellata').Stellata;
}
