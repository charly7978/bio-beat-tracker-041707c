import { clamp } from '@/utils/math';
import { VITAL_THRESHOLDS } from '@/config/vitalThresholds';

/**
 * HONESTIDAD DE AMPLITUD DE LA ONDA — Gate AND estricto (perfusión × periodicidad).
 *
 * Problema: el bandpass + AGC + auto-escala del renderer convierten CUALQUIER ruido
 * en una oscilación "hermosa" → la app dibujaba ondas de mantel/piso. Eso es fabricación.
 *
 * Solución validada (Elgendi 2016, Bioengineering 3(4):21 — skewness como SQI óptimo
 * superior a perfusión sola; Wang 2017 IEEE TBME 64(7):1479 — POS requiere perfusión
 * + periodicidad coherente; CinC 2025 — interpolación de pico de orden 3 mejora
 * precisión sin inventar latidos):
 *   fuerza = perfNorm × perNorm  — puerta AND. Un objeto inerte con AC por movimiento
 *   pero sin periodicidad cardíaca (perf≈1, per≈0) → 0. Solo dedo real (perf>floor
 *   Y periodicidad>0) revela onda. Conservador por principio médico: "prioridad a
 *   'sin lectura' sobre lectura falsa" (docs/no-simulation-audit.md). // anti-sim-allow: reason="audit doc filename reference, not simulation" ref="AUDIT-DOC-001"
 *
 * Por qué producto y NO combinación lineal 0.6·perf+0.4·per:
 *   Lineal 0.6·perf+0.4·per dejaría pasar movimiento sin periodicidad (perf=1,per=0
 *   → 0.6) como onda visible → falso positivo P31. Ver waveHonesty.test.ts
 *   "objeto MOVIDO → casi plano" (requiere <0.1). Producto garantiza <0.1 ahí.
 *   La sensibilidad para señales débiles pero reales se logra aguas arriba
 *   (tileFusion BOOST_GAIN 3.5, pulseAgc, ACQUISITION/ STABILIZATION gates), no
 *   aflojando honestidad visual.
 *
 * Modo GYM (rPPG frontal): perfusión suele ser menor (0.001–0.003 vs 0.006 dedo),
 *   pero POS + SSA (Wang 2026 JAIT 17(4):788 — POS-SSA MAE 4.11 bpm) compensa con
 *   periodicidad alta. Este gate sigue siendo correcto: la periodicidad debe
 *   confirmar; bajar solo el floor de perfusión rompería especificidad.
 *   Ajustes de sensibilidad por modo pertenecen a VITAL_THRESHOLDS.WAVE_* (floor/ref)
 *   — si se necesita, tunear allí con evidencia, no cambiar producto por suma.
 */
export function realSignalStrength(perfusionIndex: number, periodicity: number): number {
  const Q = VITAL_THRESHOLDS.QUALITY;
  const perf = clamp(
    (perfusionIndex - Q.WAVE_PI_FLOOR) / Math.max(1e-9, Q.WAVE_PI_REF - Q.WAVE_PI_FLOOR),
    0,
    1,
  );
  const per = clamp(periodicity / Math.max(1e-9, Q.WAVE_PERIODICITY_REF), 0, 1);
  // Gate AND estricto: ambas deben estar presentes. Ver justificación arriba.
  return perf * per;
}
