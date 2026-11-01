import { createClient } from "@supabase/supabase-js";
import type { ToolContext } from "@lovable.dev/mcp-js";

// Lectores perezosos: nada se evalúa en el top-level del módulo para que la
// extracción del manifiesto no dependa de variables de entorno en runtime.
function supabaseProjectUrl(): string {
  const url = import.meta.env["VITE_SUPABASE_URL"] as string | undefined;
  if (!url) throw new Error("VITE_SUPABASE_URL no está configurada");
  return url;
}

function supabasePublishableKey(): string {
  const key = import.meta.env["VITE_SUPABASE_PUBLISHABLE_KEY"] as string | undefined;
  if (!key) throw new Error("VITE_SUPABASE_PUBLISHABLE_KEY no está configurada");
  return key;
}

/**
 * Cliente Supabase con alcance del llamante: el token OAuth verificado viaja
 * en el header Authorization, por lo que las políticas RLS limitan cada
 * consulta a las filas del propio usuario.
 */
export function supabaseForUser(ctx: ToolContext) {
  const token = ctx.getToken();
  if (!token) throw new Error("supabaseForUser requiere un token OAuth verificado");
  return createClient(supabaseProjectUrl(), supabasePublishableKey(), {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
