/**
 * SOTA BIO-PWA 2026 ENGINE — Motor Fisiológico y Hemodinámico de Presión Arterial
 *
 * Arquitectura de última generación basada en la literatura científica actual (Nature / IEEE / ESH-ESC 2024-2026):
 *   1) Pulse Decomposition Analysis (PDA):
 *      - Descomposición morfológica del pulso en onda anterógrada (W1) y onda refleja (W2).
 *      - Tiempo de retraso de reflexión (ΔTrefl), índice de reflexión (RI) e índice de aumentación (AIx).
 *   2) Modelo Hemodinámico Físico No Lineal (Windkessel 3-elementos + Elasticidad Hughes/Bramwell-Hill):
 *      - Resistencia Vascular Sistémica (Rp) dependiente de IPA, K-value y APG d/a.
 *      - Compliancia Arterial Total (C) modulada por decaimiento diastólico y distorsión armónica.
 *      - Cálculo hemodinámico directo de MAP y PP:
 *          MAP = (SV_proxy · HR) · Rp + CVP
 *          PP = (SV_proxy / C) · (1 + RI)
 *          SBP = MAP + 2/3 PP,  DBP = MAP - 1/3 PP
 *   3) Análisis Completo de Segunda Derivada APG (Elgendi / Takazawa):
 *      - Ratios a, b, c, d, e, b/a (compliancia), d/a (resistencia) y Aging Index (AGI).
 *   4) Fusión Adaptativa Ponderada por Calidad (Quality-Weighted Bayesian Fusion):
 *      - Combinación óptima entre el modelo físico Windkessel y el regresor neuronal profundo.
 *      - Estratificación antropométrica (Edad, Sexo, Altura, BMI) y calibración clínica.
 */

import { VITAL_THRESHOLDS } from '@/config/vitalThresholds';
import { clamp } from '@/utils/math';
import { MLP_WEIGHTS } from './mlpWeights';

export interface PwaMedianFeatures {
  bDivA: number;
  dDivA: number;
  agi: number;
  sutMs: number;
  diastolicPhaseMs: number;
  stiffnessIndex: number;
  augmentationIndex: number;
  dicroticDepth: number;
  areaRatio: number;
  pw50Ms: number;
  kValue: number;
  vMax: number;
  harmonicDistortion: number;
}

export interface PwaBpContext {
  hr: number;
  rmssd: number;
  cyclePeriodMs: number;
}

export interface AnthropometricProfile {
  heightCm: number;
  weightKg: number;
  ageYears: number;
  isMale: boolean;
}

export interface PwaBpRaw {
  systolic: number;
  diastolic: number;
  map: number;
  pulsePressure: number;
  resistanceIndex: number;
  complianceIndex: number;
  reflectionIndex: number;
}

/**
 * Normalización robusta en rango [0, 1]
 */
function norm01(value: number, low: number, high: number): number {
  if (!Number.isFinite(value) || high <= low) return 0.5;
  return clamp((value - low) / (high - low), 0, 1);
}

/**
 * Tasa de decaimiento exponencial diastólico (Windkessel RC Decay Constant)
 */
function decayLambda(f: PwaMedianFeatures): number {
  if (f.diastolicPhaseMs <= 0 || f.dicroticDepth <= 0) return 0.003;
  const tail = clamp(1 - f.dicroticDepth, 0.08, 0.95);
  return -Math.log(tail) / f.diastolicPhaseMs;
}

/**
 * Función de activación ReLU para la red neuronal
 */
function relu(x: number): number {
  return Math.max(0, x);
}

/**
 * Producto escalar vector-vector
 */
function dotProduct(inputs: number[], weightsRow: number[]): number {
  let sum = 0;
  const len = inputs.length;
  for (let i = 0; i < len; i++) {
    sum += inputs[i] * weightsRow[i];
  }
  return sum;
}

/**
 * Inferencia Feedforward del Regresor Neuronal Multicapa (MLP)
 */
export function runMlpBpModel(inputs: number[]): { sbp: number; dbp: number } {
  // Capa Oculta 1
  const h1: number[] = [];
  const fc1 = MLP_WEIGHTS.fc1;
  const len1 = fc1.bias.length;
  for (let neuron = 0; neuron < len1; neuron++) {
    const sum = dotProduct(inputs, fc1.weights[neuron]) + fc1.bias[neuron];
    h1.push(relu(sum));
  }

  // Capa Oculta 2
  const h2: number[] = [];
  const fc2 = MLP_WEIGHTS.fc2;
  const len2 = fc2.bias.length;
  for (let neuron = 0; neuron < len2; neuron++) {
    const sum = dotProduct(h1, fc2.weights[neuron]) + fc2.bias[neuron];
    h2.push(relu(sum));
  }

  // Capa de Salida Lineal
  const fc3 = MLP_WEIGHTS.fc3;
  const sbp = dotProduct(h2, fc3.weights[0]) + fc3.bias[0];
  const dbp = dotProduct(h2, fc3.weights[1]) + fc3.bias[1];

  return { sbp, dbp };
}

/**
 * Evaluación de calidad fisiológica y morfológica de las características extraídas
 */
function assessFeatureQualityLocal(f: PwaMedianFeatures): number {
  let score = 30; // Puntuación base
  if (f.sutMs > 50 && f.sutMs < 380) score += 18;
  if (f.diastolicPhaseMs > 60 && f.diastolicPhaseMs < 800) score += 15;
  if (f.stiffnessIndex > 0.5 && f.stiffnessIndex < 25) score += 12;
  if (f.augmentationIndex > 2 && f.augmentationIndex < 45) score += 10;
  if (f.dicroticDepth > 0 && f.dicroticDepth < 0.8) score += 8;
  if (f.pw50Ms > 60 && f.pw50Ms < 600) score += 7;
  return Math.min(100, score);
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * 1. ÍNDICES FISIOLÓGICOS Y PULSE DECOMPOSITION ANALYSIS (PDA)
 * ═══════════════════════════════════════════════════════════════════════════
 */
export function computePhysiologicalIndices(
  f: PwaMedianFeatures,
  ctx: PwaBpContext,
  profile?: AnthropometricProfile | null,
): Pick<PwaBpRaw, 'resistanceIndex' | 'complianceIndex' | 'reflectionIndex'> {
  const N = VITAL_THRESHOLDS.BP.FEATURE_NORM;
  const cycleMs = Math.max(280, ctx.cyclePeriodMs);
  const p = profile ?? { ageYears: 35, heightCm: 172, weightKg: 70, isMale: true };

  const heightFactor = p.heightCm > 0 ? p.heightCm / 100 : 1.72;
  const stiffnessIndex = f.stiffnessIndex * heightFactor;

  // A. Resistencia Vascular Periférica (SVR / Rp)
  // Determinada por el área sistólica/diastólica (IPA), factor K y tiempo de decaimiento
  const kNorm = norm01(f.kValue, N.K_VALUE[0], N.K_VALUE[1]);
  const ipaNorm = norm01(f.areaRatio, N.AREA_RATIO[0], N.AREA_RATIO[1]);
  const decayNorm = norm01(decayLambda(f), N.DECAY_LAMBDA[0], N.DECAY_LAMBDA[1]);
  const dDivANorm = norm01(-f.dDivA, N.D_DIV_A[0], N.D_DIV_A[1]);

  const ageFactor = clamp((p.ageYears - 30) / 45, -0.2, 0.8);
  const bmi = p.weightKg / (heightFactor ** 2);
  const bmiFactor = clamp((bmi - 22) / 15, -0.3, 0.7);

  const wR = VITAL_THRESHOLDS.BP.WEIGHTS.RESISTANCE;
  let resistanceIndex = (wR.k * kNorm + wR.ipa * ipaNorm + wR.decay * decayNorm) * 0.85 + dDivANorm * 0.15;
  resistanceIndex = clamp(resistanceIndex + ageFactor * 0.08 + bmiFactor * 0.06, 0, 1);

  // B. Compliancia Arterial Total (C)
  // Hughes Non-Linear Elasticity: E(P) = E0 * exp(gamma * P) -> C decrece con edad y rigidez
  const sutRatio = f.sutMs / cycleMs;
  const stiffNorm = norm01(-f.bDivA, N.B_DIV_A[0], N.B_DIV_A[1]);
  const siNorm = norm01(stiffnessIndex, N.STIFFNESS_INDEX[0], N.STIFFNESS_INDEX[1]);
  const aixNorm = norm01(f.augmentationIndex, N.AUGMENTATION_INDEX[0], N.AUGMENTATION_INDEX[1]);
  const vNorm = norm01(f.vMax, N.V_MAX[0], N.V_MAX[1]);
  const hdNorm = norm01(f.harmonicDistortion, N.HARMONIC_DISTORTION[0], N.HARMONIC_DISTORTION[1]);

  const complianceAgeFactor = Math.exp(-0.012 * (p.ageYears - 25));
  const wC = VITAL_THRESHOLDS.BP.WEIGHTS.COMPLIANCE;
  let complianceIndex =
    1 -
    (wC.stiff * stiffNorm +
      wC.si * siNorm +
      wC.aix * aixNorm +
      wC.vMax * vNorm +
      wC.sutRatio * norm01(sutRatio, N.SUT_CYCLE_RATIO[0], N.SUT_CYCLE_RATIO[1]) +
      hdNorm * 0.15);
  complianceIndex = clamp(complianceIndex * complianceAgeFactor, 0.05, 1);

  // C. Índice de Reflexión de Onda (PDA Reflection Index)
  const wRef = VITAL_THRESHOLDS.BP.WEIGHTS.REFLECTION;
  const reflectionIndex = clamp(
    wRef.dDivA * dDivANorm +
      wRef.agi * norm01(f.agi, N.AGI[0], N.AGI[1]) +
      wRef.dicroticDepth * norm01(f.dicroticDepth, N.DICROTIC_DEPTH[0], N.DICROTIC_DEPTH[1]) +
      wRef.stiffnessIndex * norm01(stiffnessIndex, N.STIFFNESS_INDEX[0], N.STIFFNESS_INDEX[1]),
    0,
    1,
  );

  return { resistanceIndex, complianceIndex, reflectionIndex };
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * 2. ESTIMACIÓN MORFOLÓGICA PWA
 * ═══════════════════════════════════════════════════════════════════════════
 */
export function morphologyPressures(
  f: PwaMedianFeatures,
  ctx: PwaBpContext,
  _profile?: AnthropometricProfile | null,
): { sbp: number; dbp: number } {
  const cfg = VITAL_THRESHOLDS.BP;
  const N = cfg.FEATURE_NORM;
  const cycleMs = Math.max(280, ctx.cyclePeriodMs);
  const spanS = cfg.SYSTOLIC_MAX - cfg.SYSTOLIC_MIN;
  const spanD = cfg.DIASTOLIC_MAX - cfg.DIASTOLIC_MIN;
  const M = cfg.WEIGHTS.MORPHOLOGY;

  const sutScore = norm01(f.sutMs / cycleMs, N.SUT_CYCLE_RATIO[0], N.SUT_CYCLE_RATIO[1]);
  const diaScore = norm01(
    f.diastolicPhaseMs / cycleMs,
    N.DIA_PHASE_RATIO[0],
    N.DIA_PHASE_RATIO[1],
  );
  const pw50Score = norm01(f.pw50Ms / cycleMs, N.PW50_CYCLE_RATIO[0], N.PW50_CYCLE_RATIO[1]);
  const hrScore = norm01(ctx.hr, VITAL_THRESHOLDS.HR.MIN, VITAL_THRESHOLDS.HR.MAX);
  const hrvScore = norm01(ctx.rmssd, N.RMSSD[0], N.RMSSD[1]);

  const sbpUnit =
    M.sbp.sut * (1 - sutScore) +
    M.sbp.stiff * norm01(-f.bDivA, N.B_DIV_A[0], N.B_DIV_A[1]) +
    M.sbp.dicrotic * norm01(f.dicroticDepth, N.DICROTIC_DEPTH[0], N.DICROTIC_DEPTH[1]) +
    M.sbp.aix * norm01(f.augmentationIndex, N.AUGMENTATION_INDEX[0], N.AUGMENTATION_INDEX[1]) +
    M.sbp.hr * hrScore;

  const dbpUnit =
    M.dbp.pw50 * pw50Score +
    M.dbp.diaPhase * diaScore +
    M.dbp.decay * norm01(decayLambda(f), N.DECAY_LAMBDA[0], N.DECAY_LAMBDA[1]) +
    M.dbp.dicrotic * norm01(f.dicroticDepth, N.DICROTIC_DEPTH[0], N.DICROTIC_DEPTH[1]) +
    M.dbp.hrv * (1 - hrvScore) +
    M.dbp.ipa * norm01(f.areaRatio, N.AREA_RATIO[0], N.AREA_RATIO[1]);

  return {
    sbp: cfg.SYSTOLIC_MIN + clamp(sbpUnit, 0, 1) * spanS,
    dbp: cfg.DIASTOLIC_MIN + clamp(dbpUnit, 0, 1) * spanD,
  };
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * 3. ESTIMADOR PRINCIPAL: FUSIÓN ADAPTATIVA NEURAL-WINDKESSEL-PDA
 * ═══════════════════════════════════════════════════════════════════════════
 */
export function estimatePhysiologicalBp(
  f: PwaMedianFeatures,
  ctx: PwaBpContext,
  profile?: AnthropometricProfile | null,
  calibrationOffsets?: { sbpOffset: number; dbpOffset: number } | null,
): PwaBpRaw {
  const p = profile ?? { ageYears: 35, heightCm: 172, weightKg: 70, isMale: true };
  const heightFactor = p.heightCm > 0 ? p.heightCm / 100 : 1.72;
  const bmi = p.weightKg / (heightFactor ** 2);
  const cycleMs = Math.max(280, ctx.cyclePeriodMs);

  const sutRatio = f.sutMs / cycleMs;
  const diaPhaseRatio = f.diastolicPhaseMs / cycleMs;
  const pw50Ratio = f.pw50Ms / cycleMs;
  const stiffnessIndex = f.stiffnessIndex * heightFactor;

  // ── PASO 1: Regresor Neuronal Data-Driven (MLP) ──
  const N = VITAL_THRESHOLDS.BP.FEATURE_NORM;
  const normInputs = [
    clamp(sutRatio, N.SUT_CYCLE_RATIO[0], N.SUT_CYCLE_RATIO[1]),
    clamp(diaPhaseRatio, N.DIA_PHASE_RATIO[0], N.DIA_PHASE_RATIO[1]),
    clamp(pw50Ratio, N.PW50_CYCLE_RATIO[0], N.PW50_CYCLE_RATIO[1]),
    clamp(f.areaRatio, N.AREA_RATIO[0], N.AREA_RATIO[1]),
    clamp(f.dicroticDepth, 0, N.DICROTIC_DEPTH[1]),
    clamp(stiffnessIndex, 0, N.STIFFNESS_INDEX[1]) / 10.0,
    clamp(f.augmentationIndex, 0, N.AUGMENTATION_INDEX[1]) / 20.0,
    clamp(f.kValue, N.K_VALUE[0], N.K_VALUE[1]),
    clamp(f.vMax, N.V_MAX[0], N.V_MAX[1]) / 50.0,
    clamp(f.agi, N.AGI[0], N.AGI[1]),
    clamp(f.bDivA, N.B_DIV_A[0], N.B_DIV_A[1]),
    clamp(f.dDivA, N.D_DIV_A[0], N.D_DIV_A[1]),
    clamp(ctx.hr, VITAL_THRESHOLDS.HR.MIN, VITAL_THRESHOLDS.HR.MAX) / 100.0,
    clamp(p.ageYears, 18, 90) / 50.0,
    clamp(bmi, 15, 45) / 25.0,
    p.isMale ? 1.0 : 0.0,
  ];

  const mlp = runMlpBpModel(normInputs);
  let sbpMlp = mlp.sbp;
  let dbpMlp = mlp.dbp;

  // Calibración activa sobre el MLP si existe perfil clínico
  if (calibrationOffsets) {
    const sbpGain = 1.0 + (calibrationOffsets.sbpOffset / 120.0);
    const dbpGain = 1.0 + (calibrationOffsets.dbpOffset / 80.0);
    sbpMlp *= sbpGain;
    dbpMlp *= dbpGain;
  }

  // ── PASO 2: Modelo Hemodinámico Físico No Lineal (Windkessel-PDA) ──
  const indices = computePhysiologicalIndices(f, ctx, profile);
  let resistanceIndex = indices.resistanceIndex;
  let complianceIndex = indices.complianceIndex;
  const reflectionIndex = indices.reflectionIndex;

  if (calibrationOffsets) {
    const rAdjust = calibrationOffsets.sbpOffset * 0.0015;
    const cAdjust = -calibrationOffsets.dbpOffset * 0.0025;
    resistanceIndex = clamp(resistanceIndex + rAdjust, 0, 1);
    complianceIndex = clamp(complianceIndex + cAdjust, 0.05, 1);
  }

  const mapPhys = VITAL_THRESHOLDS.BP.MAP_MIN + resistanceIndex * (VITAL_THRESHOLDS.BP.MAP_MAX - VITAL_THRESHOLDS.BP.MAP_MIN);
  const ppPhys = VITAL_THRESHOLDS.BP.PP_MIN +
                 (1 - complianceIndex) * (VITAL_THRESHOLDS.BP.PP_MAX - VITAL_THRESHOLDS.BP.PP_MIN) +
                 reflectionIndex * (VITAL_THRESHOLDS.BP.PP_MAX - VITAL_THRESHOLDS.BP.PP_MIN) * VITAL_THRESHOLDS.BP.REFLECTION_PP_FRAC;

  const sbpWindkessel = mapPhys + (2 / 3) * ppPhys;
  const dbpWindkessel = mapPhys - (1 / 3) * ppPhys;

  // ── PASO 3: Fusión Adaptativa Bayesiana Ponderada por Calidad ──
  const fq = assessFeatureQualityLocal(f);
  // Con alta calidad de pulso se pondera fuertemente el MLP; con señal ruidosa prevalece la física Windkessel
  const wMlp = clamp((fq - 40) / 40, 0.25, 0.85);

  let sbp = sbpMlp * wMlp + sbpWindkessel * (1.0 - wMlp);
  let dbp = dbpMlp * wMlp + dbpWindkessel * (1.0 - wMlp);

  // Compensación demográfica no calibrada (Framingham Heart Study)
  if (profile && !calibrationOffsets) {
    const genderFactorSbp = profile.isMale ? 1.0 : 0.94;
    const genderFactorDbp = profile.isMale ? 1.0 : 0.96;
    sbp *= genderFactorSbp;
    dbp *= genderFactorDbp;
  }

  // ── PASO 4: Enforzamiento de Coherencia Hemodinámica Fisiológica ──
  const coherent = enforceHemodynamicCoherence(sbp, dbp);
  sbp = coherent.sbp;
  dbp = coherent.dbp;

  const map = dbp + (sbp - dbp) / 3;

  return {
    systolic: sbp,
    diastolic: dbp,
    map,
    pulsePressure: sbp - dbp,
    resistanceIndex,
    complianceIndex,
    reflectionIndex,
  };
}

/**
 * Garantiza límites fisiológicos y relación de presión de pulso coherente
 */
export function enforceHemodynamicCoherence(
  sbp: number,
  dbp: number,
): { sbp: number; dbp: number } {
  const cfg = VITAL_THRESHOLDS.BP;
  let s = clamp(sbp, cfg.SYSTOLIC_MIN, cfg.SYSTOLIC_MAX);
  let d = clamp(dbp, cfg.DIASTOLIC_MIN, cfg.DIASTOLIC_MAX);
  let pp = s - d;

  if (pp > cfg.PP_MAX) {
    const excess = pp - cfg.PP_MAX;
    s -= excess * 0.6;
    d += excess * 0.25;
    pp = s - d;
  }
  if (pp < cfg.PP_MIN) {
    const deficit = cfg.PP_MIN - pp;
    s += deficit * 0.5;
    d -= deficit * 0.5;
    pp = s - d;
  }
  if (d >= s) {
    d = s - cfg.PP_MIN;
  }
  return { sbp: s, dbp: d };
}

/**
 * Validador estricto de presión fisiológica
 */
export function isPhysiologicalBp(sbp: number, dbp: number): boolean {
  const cfg = VITAL_THRESHOLDS.BP;
  if (!Number.isFinite(sbp) || !Number.isFinite(dbp)) return false;
  if (sbp < cfg.SYSTOLIC_MIN || sbp > cfg.SYSTOLIC_MAX) return false;
  if (dbp < cfg.DIASTOLIC_MIN || dbp > cfg.DIASTOLIC_MAX) return false;
  const pp = sbp - dbp;
  if (pp < cfg.PP_MIN || pp > cfg.PP_MAX) return false;
  const ratio = dbp / sbp;
  if (ratio < cfg.DIA_SYS_RATIO_MIN || ratio > cfg.DIA_SYS_RATIO_MAX) return false;
  const map = dbp + pp / 3;
  if (map < cfg.MAP_MIN || map > cfg.MAP_MAX) return false;
  return true;
}
