// The app version shown in diagnostic reports. Kept as a plain constant (not a
// JSON import) so it works in every bundler/test loader; tests/local-ai-
// diagnostics.spec.ts fails if it ever drifts from package.json.
export const APP_VERSION = '1.13.5';
