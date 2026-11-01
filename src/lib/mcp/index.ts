import { auth, defineMcp } from "@lovable.dev/mcp-js";
import listMeasurementsTool from "./tools/list-measurements";
import measurementSummaryTool from "./tools/measurement-summary";

// Vite inlines el ref estable en build; la SUPABASE_URL publicada puede ser un proxy.
const projectRef = (import.meta.env["VITE_SUPABASE_PROJECT_ID"] as string | undefined) ?? "project-ref-unset";

export default defineMcp({
  name: "respuestamedica",
  title: "RespuestaMedica",
  version: "0.1.0",
  instructions:
    "Herramientas de solo lectura para RespuestaMedica. Permiten al asistente leer las mediciones de signos vitales del usuario autenticado (pulso, SpO2 experimental, presión arterial experimental) y un resumen de su pulso. Nunca modifiques datos; solo lectura.",
  auth: auth.oauth.issuer({
    issuer: `https://${projectRef}.supabase.co/auth/v1`,
    acceptedAudiences: "authenticated",
    requireOAuthClientClaim: true,
  }),
  tools: [listMeasurementsTool, measurementSummaryTool],
});
