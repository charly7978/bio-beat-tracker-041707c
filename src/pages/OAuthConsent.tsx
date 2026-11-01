import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { oauthReturnPath } from "@/lib/oauth-return-path";

// Wrapper tipado mínimo sobre el namespace beta `supabase.auth.oauth`:
// el SDK instalado aún no expone los tipos de estos tres métodos.
interface OAuthClientInfo {
  name?: string;
  redirect_uris?: string[];
}
interface AuthorizationDetails {
  client?: OAuthClientInfo;
  redirect_url?: string;
  redirect_to?: string;
  scope?: string;
}
interface OAuthNamespace {
  getAuthorizationDetails(id: string): Promise<{ data: AuthorizationDetails | null; error: { message: string } | null }>;
  approveAuthorization(id: string): Promise<{ data: { redirect_url?: string; redirect_to?: string } | null; error: { message: string } | null }>;
  denyAuthorization(id: string): Promise<{ data: { redirect_url?: string; redirect_to?: string } | null; error: { message: string } | null }>;
}
const oauthApi = (supabase.auth as unknown as { oauth: OAuthNamespace }).oauth;

type Phase = "loading" | "login" | "consent" | "error";

export default function OAuthConsent() {
  const [params] = useSearchParams();
  const authorizationId = params.get("authorization_id") ?? "";
  const [phase, setPhase] = useState<Phase>("loading");
  const [details, setDetails] = useState<AuthorizationDetails | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [authMode, setAuthMode] = useState<"signin" | "signup">("signin");
  const [userEmail, setUserEmail] = useState<string | null>(null);

  // Ruta de retorno validada: siempre volvemos a ESTA URL de consentimiento.
  const consentPath = oauthReturnPath(window.location.pathname + window.location.search);

  useEffect(() => {
    let active = true;
    (async () => {
      if (!authorizationId) {
        setError("Falta el identificador de autorización (authorization_id).");
        setPhase("error");
        return;
      }
      const { data: sess } = await supabase.auth.getSession();
      if (!active) return;
      if (!sess.session) {
        setPhase("login");
        return;
      }
      setUserEmail(sess.session.user.email ?? null);
      const { data, error: detError } = await oauthApi.getAuthorizationDetails(authorizationId);
      if (!active) return;
      if (detError) {
        setError(detError.message);
        setPhase("error");
        return;
      }
      const immediate = data?.redirect_url ?? data?.redirect_to;
      if (immediate && !data?.client) {
        window.location.href = immediate;
        return;
      }
      setDetails(data);
      setPhase("consent");
    })();
    return () => {
      active = false;
    };
  }, [authorizationId]);

  async function handleAuth(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    if (authMode === "signin") {
      const { error: signInError } = await supabase.auth.signInWithPassword({ email, password });
      if (signInError) {
        setBusy(false);
        setError(signInError.message);
        return;
      }
      // Recargar la misma URL de consentimiento con la sesión ya iniciada.
      window.location.href = consentPath;
      return;
    }
    const { error: signUpError } = await supabase.auth.signUp({
      email,
      password,
      options: { emailRedirectTo: new URL(consentPath, window.location.origin).href },
    });
    if (signUpError) {
      setBusy(false);
      setError(signUpError.message);
      return;
    }
    // Si el signup devuelve sesión inmediata, volvemos al consentimiento.
    const { data: sess } = await supabase.auth.getSession();
    if (sess.session) {
      window.location.href = consentPath;
      return;
    }
    setBusy(false);
    setError("Revisa tu correo para confirmar la cuenta y luego vuelve a esta pantalla.");
  }

  async function decide(approve: boolean) {
    setBusy(true);
    setError(null);
    const { data, error: decError } = approve
      ? await oauthApi.approveAuthorization(authorizationId)
      : await oauthApi.denyAuthorization(authorizationId);
    if (decError) {
      setBusy(false);
      setError(decError.message);
      return;
    }
    const target = data?.redirect_url ?? data?.redirect_to;
    if (!target) {
      setBusy(false);
      setError("El servidor de autorización no devolvió una URL de redirección.");
      return;
    }
    window.location.href = target;
  }

  const clientName = details?.client?.name ?? "una aplicación externa";

  return (
    <main className="min-h-screen flex items-center justify-center bg-background p-4">
      <div className="w-full max-w-md rounded-xl border border-border bg-card p-6 shadow-lg">
        {phase === "loading" && <p className="text-center text-muted-foreground">Cargando solicitud de conexión…</p>}

        {phase === "error" && (
          <>
            <h1 className="text-lg font-semibold text-foreground">No se pudo procesar la solicitud</h1>
            <p className="mt-2 text-sm text-destructive">{error}</p>
          </>
        )}

        {phase === "login" && (
          <>
            <h1 className="text-lg font-semibold text-foreground">Inicia sesión para continuar</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Una aplicación externa quiere conectarse a tu cuenta de RespuestaMedica.
            </p>
            <form onSubmit={handleAuth} className="mt-4 space-y-3">
              <input
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="Correo electrónico"
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              />
              <input
                type="password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Contraseña"
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              />
              {error && <p className="text-sm text-destructive">{error}</p>}
              <button
                type="submit"
                disabled={busy}
                className="w-full rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
              >
                {busy ? "Procesando…" : authMode === "signin" ? "Iniciar sesión" : "Crear cuenta"}
              </button>
              <button
                type="button"
                onClick={() => setAuthMode(authMode === "signin" ? "signup" : "signin")}
                className="w-full text-center text-sm text-muted-foreground underline"
              >
                {authMode === "signin" ? "¿No tienes cuenta? Regístrate" : "¿Ya tienes cuenta? Inicia sesión"}
              </button>
            </form>
          </>
        )}

        {phase === "consent" && details && (
          <>
            <h1 className="text-lg font-semibold text-foreground">
              Conectar {clientName} a RespuestaMedica
            </h1>
            {userEmail && <p className="mt-1 text-sm text-muted-foreground">Sesión iniciada como {userEmail}</p>}
            <p className="mt-3 text-sm text-foreground">
              Esto permite que {clientName} use esta app como tú: podrá leer tus mediciones de signos vitales mientras
              tu sesión esté activa.
            </p>
            <ul className="mt-3 list-disc space-y-1 pl-5 text-sm text-muted-foreground">
              <li>Compartir tu perfil básico y correo electrónico</li>
              <li>Leer tus mediciones (pulso, SpO2 y presión arterial experimentales)</li>
            </ul>
            <p className="mt-3 text-xs text-muted-foreground">
              Esto no omite los permisos ni las políticas de datos de la app.
            </p>
            {error && <p className="mt-2 text-sm text-destructive">{error}</p>}
            <div className="mt-5 flex gap-3">
              <button
                disabled={busy}
                onClick={() => decide(true)}
                className="flex-1 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
              >
                {busy ? "Procesando…" : "Aprobar"}
              </button>
              <button
                disabled={busy}
                onClick={() => decide(false)}
                className="flex-1 rounded-md border border-border px-3 py-2 text-sm font-medium text-foreground disabled:opacity-50"
              >
                Cancelar conexión
              </button>
            </div>
          </>
        )}
      </div>
    </main>
  );
}
