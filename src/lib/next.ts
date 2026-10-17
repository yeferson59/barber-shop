/**
 * Valor de `?next=` seguro para redirigir: solo rutas relativas del mismo sitio
 * (rechaza `//evil.com`, `/\evil.com` y caracteres de control). "" si no vale.
 */
export function safeNext(raw: string | null): string {
  if (!raw) return "";
  return /^\/(?![/\\])/.test(raw) && !/[\u0000-\u001f]/.test(raw) ? raw : "";
}
