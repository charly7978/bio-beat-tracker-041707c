import { defineTool, ToolError } from "@lovable.dev/mcp-js";
import { z } from "zod";
import { supabaseForUser } from "../supabase";

const toMeasurementJson = (m: {
  id: string;
  heart_rate: number;
  spo2: number;
  systolic: number;
  diastolic: number;
  arrhythmia_count: number;
  quality: number;
  measured_at: string;
}) => ({
  id: m.id,
  heartRateBpm: m.heart_rate,
  spo2Percent: m.spo2,
  bloodPressure: { systolic: m.systolic, diastolic: m.diastolic, experimental: true },
  arrhythmiaCount: m.arrhythmia_count,
  signalQualityPercent: m.quality,
  measuredAt: m.measured_at,
});

export default defineTool({
  name: "list_measurements",
  title: "List recent measurements",
  description:
    "Lists the signed-in user's most recent vital-sign measurements (heart rate, SpO2, blood pressure, signal quality). SpO2 and blood pressure are experimental estimates.",
  inputSchema: {
    limit: z.number().int().min(1).max(50).default(10).describe("Maximum number of measurements to return (1-50)."),
  },
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  handler: async ({ limit }, ctx) => {
    const supabase = supabaseForUser(ctx);
    const { data, error } = await supabase
      .from("measurements")
      .select("id, heart_rate, spo2, systolic, diastolic, arrhythmia_count, quality, measured_at")
      .order("measured_at", { ascending: false })
      .limit(limit);
    if (error) throw new ToolError(`No se pudieron leer las mediciones: ${error.message}`);
    const measurements = (data ?? []).map(toMeasurementJson);
    return {
      content: [
        {
          type: "text",
          text:
            measurements.length === 0
              ? "El usuario no tiene mediciones guardadas todavía."
              : `Últimas ${measurements.length} mediciones del usuario (SpO2 y presión arterial son estimaciones experimentales).`,
        },
      ],
      structuredContent: { measurements },
    };
  },
});
