import { describe, it, expect } from 'vitest';
import { PUBLIC_BP_DATASETS, getPublicBpDataset } from '../bpTrainingDatasets';

describe('bpTrainingDatasets — catálogo de datasets públicos (F5)', () => {
  it('catálogo no vacío y con campos obligatorios', () => {
    expect(PUBLIC_BP_DATASETS.length).toBeGreaterThan(0);
    for (const d of PUBLIC_BP_DATASETS) {
      expect(d.id).toBeTruthy();
      expect(d.name).toBeTruthy();
      expect(d.url).toMatch(/^https?:\/\//);
      expect(d.kind).toBe('clinical_reference');
      expect(d.notes.length).toBeGreaterThan(10);
    }
  });

  it('getPublicBpDataset resuelve por id y undefined si no existe', () => {
    const d = getPublicBpDataset('mimic-iv-waveform');
    expect(d).toBeDefined();
    expect(d!.id).toBe('mimic-iv-waveform');
    expect(getPublicBpDataset('no-existe')).toBeUndefined();
  });

  it('ids únicos', () => {
    const ids = PUBLIC_BP_DATASETS.map((d) => d.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});