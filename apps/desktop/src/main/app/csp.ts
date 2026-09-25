/**
 * CSP-политика окна (TASK-008 §6/§14, арх. 08 §4): заголовок ставится в
 * createWindow через session.webRequest.onHeadersReceived.
 *
 * Prod — `default-src 'self'; script-src 'self'`: только собранные ассеты своего
 * origin, никакого inline/remote-кода.
 *
 * Dev — «+ dev-разрешение vite-хоста» (§6): origin dev-сервера и 'unsafe-inline'
 * для script-src (inline-preamble @vitejs/plugin-react; послабление ТОЛЬКО в dev —
 * риск «CSP может сломать HMR», §22) и connect-src с ws:// того же host:port для
 * HMR-websocket. Невалидный dev-URL — откат к строгой prod-политике.
 */

/** Строгая политика prod (и откат при невалидном dev-URL). */
const PROD_POLICY = "default-src 'self'; script-src 'self'";

/** Политика для окна: devServerUrl — ELECTRON_RENDERER_URL (индикатор dev, §13). */
export function buildCspPolicy(devServerUrl: string | undefined): string {
  if (devServerUrl === undefined) {
    return PROD_POLICY;
  }
  let origin: URL;
  try {
    origin = new URL(devServerUrl);
  } catch {
    return PROD_POLICY;
  }
  const originText = origin.origin;

  return (
    `default-src 'self'; ` +
    `script-src 'self' ${originText} 'unsafe-inline'; ` +
    `connect-src 'self' ${originText} ws://${origin.host}`
  );
}
