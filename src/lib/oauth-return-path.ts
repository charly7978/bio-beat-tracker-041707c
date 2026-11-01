// Valida una ruta de retorno same-origin para flujos OAuth (consent → login → consent).
// Acepta solo paths locales canónicos, preservando query y fragment; rechaza
// network paths, backslashes y caracteres de control.
export function oauthReturnPath(value: unknown): string {
  // \p{Cc} = categoría Unicode de caracteres de control (incluye \x00–\x1f y
  // \x7f): misma propuesta de sanitización sin escapes explícitos prohibidos.
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//") || /[\p{Cc}\\]/u.test(value)) return "/";
  // Un origen fijo de parseo mantiene la validación segura incluso durante SSR.
  const origin = "https://app.invalid";
  try {
    const target = new URL(value, origin);
    if (target.origin !== origin || target.pathname.startsWith("//")) return "/";
    return target.pathname + target.search + target.hash;
  } catch {
    return "/";
  }
}
