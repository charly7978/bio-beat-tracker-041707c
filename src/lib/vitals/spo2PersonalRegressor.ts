/**
 * SpO2 personal regressor (F4) — ridge regression sobre features espectrales
 * (ratio triple R/G/B + TMDS) contra pulsioxímetro de referencia del usuario,
 * con banda de incertidumbre p5–p95 por medición.
 *
 * Módulo puro: sin React, sin cámara, sin almacenamiento. La persistencia del
 * modelo y los pares vive en CalibrationManager (siguiente capa); aquí solo
 * la matemática y la honestidad (mínimo de pares, condición estable).
 */

import { robustPercentile } from '@/modules/signal-processing/shared/dsp';
import { clamp } from '@/utils/math';

export const SPO2_REGRESSOR_MIN_PAIRS = 6;
export const SPO2_REGRESSOR_RIDGE_LAMBDA = 0.5;

export interface Spo2RegressorPair {
  timestampMs: number;
  /** Vector de features (longitud D, constante entre pares). */
  features: number[];
  /** SpO2 de referencia (%) del pulsioxímetro. */
  referenceSpo2: number;
}

export interface Spo2PersonalModel {
  /** Pesos estandarizados (longitud D). */
  weights: number[];
  bias: number;
  /** Medias y desviaciones usadas para estandarizar (para predicción). */
  featureMeans: number[];
  featureStds: number[];
  /** Residuo muestral (σ) en puntos de SpO2. */
  residualStd: number;
  /** Percentiles empíricos del residuo (p5, p95) para la banda por medición. */
  residualP5: number;
  residualP95: number;
  calibrated: boolean;
  nPairs: number;
}

export type Spo2RegressorStatus = 'FIT' | 'INSUFFICIENT_PAIRS' | 'UNSTABLE_MODEL';

export interface Spo2RegressorFitResult {
  status: Spo2RegressorStatus;
  model: Spo2PersonalModel | null;
  /** Correlación Pearson media entre predicción y referencia (honestidad). */
  r: number | null;
  /** Residuo muestral (σ). */
  residualStd: number | null;
}

function standardize(pairs: Spo2RegressorPair[]): { X: number[][]; y: number[]; means: number[]; stds: number[] } | null {
  const n = pairs.length;
  if (n === 0) return null;
  const d = pairs[0].features.length;
  if (d === 0 || !pairs.every((p) => p.features.length === d && Number.isFinite(p.referenceSpo2))) return null;
  const means = new Array(d).fill(0);
  for (const p of pairs) for (let j = 0; j < d; j++) means[j] += p.features[j];
  for (let j = 0; j < d; j++) means[j] /= n;
  const stds = new Array(d).fill(0);
  for (const p of pairs) for (let j = 0; j < d; j++) stds[j] += (p.features[j] - means[j]) ** 2;
  for (let j = 0; j < d; j++) stds[j] = Math.sqrt(stds[j] / Math.max(1, n - 1)) || 1;
  const X: number[][] = [];
  const y: number[] = [];
  for (const p of pairs) {
    const row = p.features.map((v, j) => (v - means[j]) / stds[j]);
    if (!row.every(Number.isFinite)) return null;
    X.push(row);
    y.push(p.referenceSpo2);
  }
  return { X, y, means, stds };
}

export function fitSpo2PersonalRegressor(
  pairs: Spo2RegressorPair[],
  options: { lambda?: number } = {},
): Spo2RegressorFitResult {
  const clean = pairs.filter(
    (p) => Number.isFinite(p.referenceSpo2) && p.referenceSpo2 >= 50 && p.referenceSpo2 <= 100 && Array.isArray(p.features),
  );
  if (clean.length < SPO2_REGRESSOR_MIN_PAIRS) {
    return { status: 'INSUFFICIENT_PAIRS', model: null, r: null, residualStd: null };
  }
  const std = standardize(clean);
  if (!std) return { status: 'UNSTABLE_MODEL', model: null, r: null, residualStd: null };
  const { X, y, means, stds } = std;
  const n = X.length;
  const d = X[0].length;
  const lambda = options.lambda ?? SPO2_REGRESSOR_RIDGE_LAMBDA;

  // Ridge: (XᵀX + λI) w = Xᵀ y, con bias = mean(y) - wᵀ mean(X_std=0) (ya centrado).
  // X está estandarizado (media 0 por columna), así que bias = mean(y).
  const yMean = y.reduce((a, b) => a + b, 0) / n;
  const yc = y.map((v) => v - yMean);

  // XᵀX (d×d) + λI
  const XtX: number[][] = Array.from({ length: d }, () => new Array(d).fill(0));
  const Xty: number[] = new Array(d).fill(0);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < d; j++) {
      Xty[j] += X[i][j] * yc[i];
      for (let k = 0; k < d; k++) XtX[j][k] += X[i][j] * X[i][k];
    }
  }
  for (let j = 0; j < d; j++) XtX[j][j] += lambda;

  // Resolver por eliminación gaussiana con pivote parcial.
  const A = XtX.map((row, i) => [...row, Xty[i]]);
  for (let col = 0; col < d; col++) {
    // pivote
    let pivot = col;
    let best = Math.abs(A[col][col]);
    for (let r = col + 1; r < d; r++) {
      if (Math.abs(A[r][col]) > best) { best = Math.abs(A[r][col]); pivot = r; }
    }
    if (best < 1e-12) return { status: 'UNSTABLE_MODEL', model: null, r: null, residualStd: null };
    if (pivot !== col) { const tmp = A[col]; A[col] = A[pivot]; A[pivot] = tmp; }
    const pv = A[col][col];
    for (let j = col; j <= d; j++) A[col][j] /= pv;
    for (let r = 0; r < d; r++) {
      if (r === col) continue;
      const factor = A[r][col];
      if (factor !== 0) for (let j = col; j <= d; j++) A[r][j] -= factor * A[col][j];
    }
  }
  const w = A.map((row) => row[d]);

  // Predicciones y residuos.
  const preds = X.map((row) => yMean + row.reduce((acc, v, j) => acc + v * w[j], 0));
  const residuals = preds.map((p, i) => p - y[i]);
  const ss = residuals.reduce((a, r) => a + r * r, 0);
  const residualStd = n > d + 1 ? Math.sqrt(ss / (n - d - 1)) : 0;
  const sortedRes = [...residuals].sort((a, b) => a - b);
  const p5 = robustPercentile(sortedRes, 0.05);
  const p95 = robustPercentile(sortedRes, 0.95);

  // Correlación Pearson.
  const ym = yMean;
  const pm = preds.reduce((a, b) => a + b, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) {
    sxy += (preds[i] - pm) * (y[i] - ym);
    sxx += (preds[i] - pm) ** 2;
    syy += (y[i] - ym) ** 2;
  }
  const r = sxx > 0 && syy > 0 ? clamp(sxy / Math.sqrt(sxx * syy), -1, 1) : 0;

  // Verificación de finitud.
  if (![...w, yMean, residualStd].every(Number.isFinite)) {
    return { status: 'UNSTABLE_MODEL', model: null, r: null, residualStd: null };
  }

  const model: Spo2PersonalModel = {
    weights: w,
    bias: yMean,
    featureMeans: means,
    featureStds: stds,
    residualStd,
    residualP5: p5,
    residualP95: p95,
    calibrated: true,
    nPairs: n,
  };
  return { status: 'FIT', model, r, residualStd };
}

export interface Spo2Prediction {
  spo2: number;
  p5: number;
  p95: number;
}

export function predictSpo2(model: Spo2PersonalModel, features: number[]): Spo2Prediction | null {
  if (!model.calibrated) return null;
  if (features.length !== model.weights.length) return null;
  if (!features.every(Number.isFinite)) return null;
  const std = features.map((v, j) => (v - model.featureMeans[j]) / model.featureStds[j]);
  if (!std.every(Number.isFinite)) return null;
  const raw = model.bias + std.reduce((acc, v, j) => acc + v * model.weights[j], 0);
  const spo2 = clamp(raw, 50, 100);
  return {
    spo2,
    p5: clamp(spo2 + model.residualP5, 50, 100),
    p95: clamp(spo2 + model.residualP95, 50, 100),
  };
}