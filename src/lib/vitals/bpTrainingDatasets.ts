/**
 * Catálogo de datasets públicos para el entrenamiento del MLP de PA (F5).
 *
 * Documenta la procedencia de los datos clínicos que habilitarían la sustitución
 * de los pesos sintéticos (`formula_generated`) por pesos entrenados sobre
 * mediciones reales. NO implica que el entrenamiento se haya ejecutado: el
 * gate de promoción (`evaluateBpWeightsPromotion`) exige un informe clínico
 * válido antes de tocar `mlpWeights.ts`.
 */
export interface PublicBpDataset {
  id: string;
  name: string;
  url: string;
  kind: 'clinical_reference';
  notes: string;
}

export const PUBLIC_BP_DATASETS: PublicBpDataset[] = [
  {
    id: 'mimic-iv-waveform',
    name: 'MIMIC-IV Waveform Database',
    url: 'https://physionet.org/content/mimic4wdb/0.1.0/',
    kind: 'clinical_reference',
    notes: 'Señales PPG/ABP + demografía de UCI. Requiere credencial PhysioNet y DUA.',
  },
  {
    id: 'uci-heart-disease',
    name: 'UCI Heart Disease (Cleveland)',
    url: 'https://archive.ics.uci.edu/dataset/45/heart+disease',
    kind: 'clinical_reference',
    notes: 'Variables clínicas + PA. Dataset pequeño, útil para validación cruzada.',
  },
  {
    id: 'ppg-bp-liang2018',
    name: 'PPG-BP Dataset (Liang et al. 2018)',
    url: 'https://figshare.com/articles/dataset/PPG-BP/5459299',
    kind: 'clinical_reference',
    notes: 'Pares PPG/PA de referencia. Dataset público pequeño para calibración.',
  },
];

export function getPublicBpDataset(id: string): PublicBpDataset | undefined {
  return PUBLIC_BP_DATASETS.find((d) => d.id === id);
}