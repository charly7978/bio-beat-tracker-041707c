import { useEffect, useState } from 'react';
import { ValidationDataset, type ValidationDatasetEntry } from '@/modules/vital-signs/ValidationDataset';
import { blandAltman } from '@/lib/vitals/blandAltman';

export function StudyPanel() {
  const [entries, setEntries] = useState<ValidationDatasetEntry[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await ValidationDataset.getDataset();
        if (!cancelled) setEntries(data);
      } catch {
        if (!cancelled) setEntries([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const bpSys = blandAltman(entries
    .filter((e) => e.reference.systolic != null && e.vitals.bloodPressure.value)
    .map((e) => ({ estimate: e.vitals.bloodPressure.value!.systolic, reference: e.reference.systolic as number })));
  const bpDia = blandAltman(entries
    .filter((e) => e.reference.diastolic != null && e.vitals.bloodPressure.value)
    .map((e) => ({ estimate: e.vitals.bloodPressure.value!.diastolic, reference: e.reference.diastolic as number })));
  const spo2 = blandAltman(entries
    .filter((e) => e.reference.spo2 != null && e.vitals.spo2.value != null)
    .map((e) => ({ estimate: e.vitals.spo2.value as number, reference: e.reference.spo2 as number })));

  const renderChannel = (label: string, r: ReturnType<typeof blandAltman>) => (
    <div className="bg-zinc-950/60 border border-zinc-900/50 rounded-xl p-3.5 space-y-1">
      <div className="text-[9px] text-zinc-400 font-bold uppercase tracking-wider">{label}</div>
      {!r ? (
        <div className="text-[9px] text-zinc-600 font-mono">Sin pares válidos.</div>
      ) : (
        <div className="text-[9px] font-mono text-zinc-300 space-y-0.5">
          <div>n = {r.n}</div>
          <div>d̄ (sesgo) = {r.bias.toFixed(2)} mmHg</div>
          <div>DE = {r.sd.toFixed(2)} mmHg</div>
          <div>LoA = [{r.loaLow.toFixed(1)}, {r.loaHigh.toFixed(1)}]</div>
          <div>p5/p95 = [{r.p5.toFixed(1)}, {r.p95.toFixed(1)}]</div>
        </div>
      )}
    </div>
  );

  return (
    <div className="space-y-4 animate-in fade-in duration-200">
      <div className="flex items-center gap-1.5 text-zinc-400 text-[10px] font-bold uppercase tracking-wider">
        <span>Panel de estudio (validación vs referencia)</span>
      </div>
      <p className="text-[9px] text-zinc-500 leading-relaxed">
        Acuerdo Bland–Altman entre las estimaciones del sistema y las referencias
        clínicas registradas en el dataset de validación local (cifrado).
        Protocolo: docs/validation-protocol.md. ISO 81060-2:2018: |sesgo| ≤ 5 mmHg, DE ≤ 8 mmHg.
      </p>
      {loading ? (
        <div className="text-[9px] text-zinc-600 font-mono">Cargando dataset...</div>
      ) : (
        <>
          <div className="text-[9px] text-zinc-500 font-mono">Entradas: {entries.length}</div>
          {renderChannel('PA sistólica', bpSys)}
          {renderChannel('PA diastólica', bpDia)}
          {renderChannel('SpO2', spo2)}
        </>
      )}
    </div>
  );
}