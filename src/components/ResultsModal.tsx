import React, { useMemo } from 'react';
import { Heart, AlertTriangle, Activity, X, Shield, Clock, CheckCircle2, XCircle, Brain, Loader2 } from 'lucide-react';
import { PoincarePlot } from './PoincarePlot';
import { healthRiskAnalyzer } from '@/lib/ml/riskAnalyzer';
import type { VitalSignsResult } from '@/modules/vital-signs/VitalSignsProcessor';

interface MeasurementSummaryData {
  totalBeats: number;
  arrhythmiaBeats: number;
  normalPercent: number;
}

interface VitalSignsState {
  heartRate: { value: number | null; status: string };
  spo2: { value: number | null; status: string };
  bloodPressure: {
    value: { systolic: number; diastolic: number } | null;
    status: string;
    calibration?: { available: boolean };
    diagnostics?: { featureQuality?: number };
  };
  arrhythmia: { value: { status: string; count: number } | null; status: string };
  isCalibrating?: boolean;
}

interface ResultsModalProps {
  summary: MeasurementSummaryData;
  vitalSigns: VitalSignsState;
  rrIntervals: number[];
  signalQuality: number;
  isAnalyzing: boolean;
  onClose: () => void;
  onAnalyzeAI: () => void;
}

export function ResultsModal({
  summary,
  vitalSigns,
  rrIntervals,
  isAnalyzing,
  onClose,
  onAnalyzeAI,
}: ResultsModalProps) {
  const { totalBeats, arrhythmiaBeats, normalPercent } = summary;
  const normalBeats = totalBeats - arrhythmiaBeats;
  const avgBpm = (vitalSigns.heartRate.value ?? 0) > 0 ? Math.round(vitalSigns.heartRate.value!) : '--';

  const statusColor = normalPercent >= 95 ? 'emerald' : normalPercent >= 80 ? 'yellow' : 'red';
  const statusText = normalPercent >= 95 ? 'RITMO NORMAL' : normalPercent >= 80 ? 'LEVE IRREGULARIDAD' : 'IRREGULARIDAD DETECTADA';
  const StatusIcon = normalPercent >= 95 ? CheckCircle2 : normalPercent >= 80 ? AlertTriangle : XCircle;

  const riskAssessment = useMemo(() => {
    try {
      if (!vitalSigns.heartRate.value && !vitalSigns.spo2.value) return null;
      return healthRiskAnalyzer.analyze(vitalSigns as unknown as VitalSignsResult);
    } catch {
      return null;
    }
  }, [vitalSigns]);

  const bgClass = statusColor === 'emerald' ? 'bg-emerald-500/10' : statusColor === 'yellow' ? 'bg-yellow-500/10' : 'bg-red-500/10';
  const textClass = statusColor === 'emerald' ? 'text-emerald-400' : statusColor === 'yellow' ? 'text-yellow-400' : 'text-red-400';
  const strokeClass = statusColor === 'emerald' ? 'stroke-emerald-400' : statusColor === 'yellow' ? 'stroke-yellow-400' : 'stroke-red-400';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 animate-fade-in">
      <div className="bg-black border border-slate-700/50 rounded-2xl max-w-sm w-[92%] shadow-2xl flex flex-col max-h-[85vh]">

        {/* Header con estado */}
        <div className={`flex-none px-4 py-3 ${bgClass} border-b border-zinc-900 rounded-t-2xl`}>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <StatusIcon className={`w-5 h-5 ${textClass}`} />
              <div>
                <h3 className="text-white text-sm font-bold tracking-wide">MEDICIÓN COMPLETADA</h3>
                <p className={`${textClass} text-[10px] font-semibold tracking-wider`}>{statusText}</p>
              </div>
            </div>
            <button
              onClick={onClose}
              className="p-1.5 rounded-full bg-zinc-900 hover:bg-slate-700 transition-colors"
            >
              <X className="w-4 h-4 text-zinc-400" />
            </button>
          </div>
        </div>

        {/* Métricas principales */}
        <div className="flex-1 overflow-y-auto p-4 space-y-2">

          {/* BPM y SpO2 */}
          <div className="grid grid-cols-2 gap-2">
            <div className="bg-zinc-950/80 rounded-xl p-3 text-center border border-zinc-900/50">
              <Heart className="w-4 h-4 text-red-400 mx-auto mb-1" fill="currentColor" />
              <div className="text-white text-2xl font-bold leading-none">{avgBpm}</div>
              <div className="text-zinc-500 text-[9px] mt-1 font-medium">BPM PROMEDIO</div>
            </div>
            <div className="bg-zinc-950/80 rounded-xl p-3 text-center border border-zinc-900/50">
              <Activity className="w-4 h-4 text-cyan-400 mx-auto mb-1" />
              <div className="text-white text-2xl font-bold leading-none">
                {vitalSigns.spo2.value != null && vitalSigns.spo2.value > 0 ? Math.round(vitalSigns.spo2.value) : '--'}
                <span className="text-sm text-zinc-400">%</span>
              </div>
              <div className="text-zinc-500 text-[9px] mt-1 font-medium">SpO₂</div>
            </div>
          </div>

          {/* Presión arterial */}
          {vitalSigns.bloodPressure.value && vitalSigns.bloodPressure.value.systolic > 0 && (
            <div className="bg-zinc-950/80 rounded-xl p-3 border border-zinc-900/50 flex items-center gap-3">
              <Shield className="w-5 h-5 text-blue-400" />
              <div className="flex-1">
                <div className="flex items-center gap-2 mb-1">
                  <div className="text-zinc-500 text-[9px] font-medium tracking-tight">PRESIÓN ARTERIAL</div>
                  {vitalSigns.bloodPressure.calibration?.available ? (
                    <span className="text-[8px] font-bold px-1.5 py-0.5 rounded-full bg-emerald-500/20 text-emerald-400">CALIBRADO</span>
                  ) : (
                    <span className="text-[8px] font-bold px-1.5 py-0.5 rounded-full bg-orange-500/20 text-orange-400">SIN CALIBRAR</span>
                  )}
                </div>
                <div className="text-white text-lg font-bold">
                  {Math.round(vitalSigns.bloodPressure.value.systolic)}/{Math.round(vitalSigns.bloodPressure.value.diastolic)}
                  <span className="text-xs text-zinc-500 ml-1">mmHg</span>
                </div>
              </div>
            </div>
          )}

          {/* Barras de ritmo */}
          <div className="bg-zinc-950/80 rounded-xl p-3 border border-zinc-900/50">
            <div className="flex items-center justify-between mb-2">
              <span className="text-zinc-400 text-[10px] font-semibold tracking-wide">ANÁLISIS DE RITMO</span>
              <div className="flex items-center gap-1">
                <Clock className="w-3 h-3 text-zinc-500" />
                <span className="text-zinc-500 text-[9px]">60s</span>
              </div>
            </div>

            <div className="mb-2">
              <div className="flex justify-between items-center mb-0.5">
                <span className="text-emerald-400 text-[9px] font-medium">■ Normales</span>
                <span className="text-white text-xs font-bold">{normalBeats}</span>
              </div>
              <div className="w-full h-2 bg-zinc-900 rounded-full overflow-hidden">
                <div className="h-full bg-gradient-to-r from-emerald-600 to-emerald-400 rounded-full transition-all duration-1000 ease-out"
                  style={{ width: `${totalBeats > 0 ? (normalBeats / totalBeats) * 100 : 0}%` }} />
              </div>
            </div>

            <div>
              <div className="flex justify-between items-center mb-0.5">
                <span className="text-red-400 text-[9px] font-medium">■ Arrítmicos</span>
                <span className="text-white text-xs font-bold">{arrhythmiaBeats}</span>
              </div>
              <div className="w-full h-2 bg-zinc-900 rounded-full overflow-hidden">
                <div className={`h-full rounded-full transition-all duration-1000 ease-out ${arrhythmiaBeats > 0 ? 'bg-gradient-to-r from-red-600 to-red-400' : 'bg-slate-700'}`}
                  style={{ width: `${totalBeats > 0 ? (arrhythmiaBeats / totalBeats) * 100 : 100}%` }} />
              </div>
            </div>
          </div>

          {/* Poincaré Plot */}
          {rrIntervals && rrIntervals.length >= 2 && (
            <div className="flex justify-center my-2 animate-in fade-in zoom-in-95 duration-500">
              <PoincarePlot rrIntervals={rrIntervals} width={200} height={200} />
            </div>
          )}

          {/* Porcentaje circular */}
          <div className="flex items-center justify-center gap-4 pt-1">
            <div className="relative w-16 h-16">
              <svg viewBox="0 0 36 36" className="w-full h-full -rotate-90">
                <path d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831"
                  fill="none" stroke="#1e293b" strokeWidth="3" />
                <path d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831"
                  fill="none"
                  className={strokeClass}
                  strokeWidth="3"
                  strokeDasharray={`${normalPercent}, 100`}
                  strokeLinecap="round" />
              </svg>
              <div className="absolute inset-0 flex items-center justify-center">
                <span className={`text-sm font-bold ${textClass}`}>
                  {normalPercent}%
                </span>
              </div>
            </div>
            <div>
              <div className="text-white text-xs font-semibold">Ritmo Normal</div>
              <div className="text-zinc-500 text-[9px]">{totalBeats} latidos analizados</div>
              <div className={`text-[10px] font-semibold mt-0.5 ${textClass}`}>
                {statusText}
              </div>
            </div>
          </div>

          {/* Recomendación preventiva si existe */}
          {riskAssessment && riskAssessment.recommendations.length > 0 && (
            <div className="bg-zinc-950/60 rounded-xl p-2.5 border border-zinc-900/40 text-[10px] text-zinc-400 space-y-1">
              <span className="text-[9px] font-bold uppercase text-zinc-500 block">Observación preventiva:</span>
              <p className="leading-snug">{riskAssessment.recommendations[0]}</p>
            </div>
          )}

          {/* Botón Análisis AI */}
          <button
            onClick={onAnalyzeAI}
            disabled={isAnalyzing}
            className="w-full mt-2 flex items-center justify-center gap-2 py-2.5 rounded-xl bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-500 hover:to-indigo-500 text-white font-semibold text-sm transition-all disabled:opacity-50"
          >
            {isAnalyzing ? (
              <><Loader2 className="w-4 h-4 animate-spin" /> Analizando...</>
            ) : (
              <><Brain className="w-4 h-4" /> Análisis AI de Salud</>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

