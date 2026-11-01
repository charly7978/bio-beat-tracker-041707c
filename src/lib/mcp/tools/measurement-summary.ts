import { defineTool, ToolError } from "@lovable.dev/mcp-js";
import { z } from "zod";
import { supabaseForUser } from "../supabase";

export default defineTool({
  name: "measurement_summary",
  title: "Heart rate summary",
  description:
    "Summarizes the signed-in user's heart rate over the last N days: average, minimum, maximum and number of measurements.",
  inputSchema: {
    days: z.number().int().min(1).max(365).default(30).describe("Number of days to look back (1-365)."),
  },
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  handler: async ({ days }, ctx) => {
    const supabase = supabaseForUser(ctx);
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    const { data, error } = await supabase
      .from("measurements")
      .select("heart_rate, quality, measured_at")
      .gte("measured_at", since)
      .order("measured_at", { ascending: false });
    if (error) throw new ToolError(`No se pudo calcular el resumen: ${error.message}`);

    const rows = data ?? [];
    if (rows.length === 0) {
      return {
        content: [{ type: "text", text: `No hay mediciones en los últimos ${days} días.` }],
        structuredContent: {
          days,
          count: 0,
          avgHeartRateBpm: null,
          minHeartRateBpm: null,
          maxHeartRateBpm: null,
          avgSignalQualityPercent: null,
        },
      };
    }

    const hrs = rows.map((r) => r.heart_rate);
    const qualities = rows.map((r) => r.quality);
    const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    const summary = {
      days,
      count: rows.length,
      avgHeartRateBpm: Math.round(avg(hrs) * 10) / 10,
      minHeartRateBpm: Math.min(...hrs),
      maxHeartRateBpm: Math.max(...hrs),
      avgSignalQualityPercent: Math.round(avg(qualities) * 10) / 10,
    };
    return {
      content: [
        {
          type: "text",
          text: `Resumen de ${summary.count} mediciones en ${days} días: pulso medio ${summary.avgHeartRateBpm} lpm (mín ${summary.minHeartRateBpm}, máx ${summary.maxHeartRateBpm}), calidad media de señal ${summary.avgSignalQualityPercent}%.`,
        },
      ],
      structuredContent: summary,
    };
  },
});
