/**
 * RESUMEN ESTADÍSTICO POST-MEDICIÓN — modal de resultados.
 * Render puro: el estado vive en Index (orquestador); aquí solo props.
 */
import { AlertTriangle, Activity, Brain, CheckCircle2, Clock, Heart, Loader2, Shield, X, XCircle } from 'lucide-react';
import { PoincarePlot } from '@/components/PoincarePlot';
import type { ValidationVerdict } from '@/lib/acquisition/MeasurementWindowValidator';
import type { VitalSignsResult } from '@/modules/vital-signs/VitalSignsProcessor';

export interface MeasurementSummaryStats {
  totalBeats: number;
  arrhythmiaBeats: number;
  normalPercent: number;
}

interface MeasurementSummaryModalProps {
  summary: MeasurementSummaryStats;
  validationVerdict: ValidationVerdict | null;
  vitalSigns: VitalSignsResult;
  rrIntervals: number[];
  isAnalyzing: boolean;
  onClose: () => void;
  onAnalyze: () => void;
}

export function MeasurementSummaryModal({
  summary,
  validationVerdict,
  vitalSigns,
  rrIntervals,
  isAnalyzing,
  onClose,
  onAnalyze,
}: MeasurementSummaryModalProps) {
  const { totalBeats, arrhythmiaBeats, normalPercent } = summary;
  const normalBeats = totalBeats - arrhythmiaBeats;
  const avgBpm = (vitalSigns.heartRate.value ?? 0) > 0 ? Math.round(vitalSigns.heartRate.value!) : '--';
  const statusColor = normalPercent >= 95 ? 'emerald' : normalPercent >= 80 ? 'yellow' : 'red';
  const statusText = normalPercent >= 95 ? 'RITMO NORMAL' : normalPercent >= 80 ? 'LEVE IRREGULARIDAD' : 'IRREGULARIDAD DETECTADA';
  const statusIcon = normalPercent >= 95 ? CheckCircle2 : normalPercent >= 80 ? AlertTriangle : XCircle;
  const bgClass = statusColor === 'emerald' ? 'bg-emerald-500/10' : statusColor === 'yellow' ? 'bg-yellow-500/10' : 'bg-red-500/10';
  const textClass = statusColor === 'emerald' ? 'text-emerald-400' : statusColor === 'yellow' ? 'text-yellow-400' : 'text-red-400';
  const strokeClass = statusColor === 'emerald' ? 'stroke-emerald-400' : statusColor === 'yellow' ? 'stroke-yellow-400' : 'stroke-red-400';
  const StatusIcon = statusIcon;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-md animate-fade-in p-4">
      <div className="glass-panel border border-white/15 rounded-3xl max-w-sm w-full shadow-2xl flex flex-col max-h-[85vh] overflow-hidden animate-in zoom-in-95 duration-200">

        {/* Header con estado */}
        <div className={`flex-none px-5 py-4 ${bgClass} border-b border-white/10`}>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-2xl bg-black/40 border border-white/10 shadow-inner">
                <StatusIcon className={`w-5 h-5 ${textClass}`} />
              </div>
              <div>
                <h3 className="text-white text-sm font-bold font-heading tracking-wide">
                  {validationVerdict && !validationVerdict.accepted ? 'SESIÓN NO VÁLIDA' : 'MEDICIÓN COMPLETADA'}
                </h3>
                <p className={`${textClass} text-[10px] font-semibold tracking-wider uppercase font-mono`}>{statusText}</p>
              </div>
            </div>
            <button
              onClick={onClose}
              className="p-2 rounded-xl bg-white/5 hover:bg-white/10 text-zinc-400 hover:text-white transition-colors"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Métricas principales */}
        <div className="flex-1 overflow-y-auto p-4 space-y-3">

          {/* BPM y SpO2 en fila */}
          <div className="grid grid-cols-2 gap-2.5">
            <div className="glass-card rounded-2xl p-3 text-center border border-white/5 shadow-lg">
              <Heart className="w-4 h-4 text-rose-400 mx-auto mb-1 animate-cardiac" fill="currentColor" />
              <div className="text-white text-2xl font-extrabold font-mono leading-none tracking-tight">{avgBpm}</div>
              <div className="text-zinc-400 text-[9px] mt-1 font-mono uppercase tracking-wider">BPM PROMEDIO</div>
            </div>
            <div className="glass-card rounded-2xl p-3 text-center border border-white/5 shadow-lg">
              <Activity className="w-4 h-4 text-cyan-400 mx-auto mb-1" />
              <div className="text-white text-2xl font-extrabold font-mono leading-none tracking-tight">
                {vitalSigns.spo2.value != null && vitalSigns.spo2.value > 0 ? Math.round(vitalSigns.spo2.value) : '--'}
                <span className="text-sm text-cyan-300/70 ml-0.5">%</span>
              </div>
              <div className="text-zinc-400 text-[9px] mt-1 font-mono uppercase tracking-wider">SpO₂ · experimental</div>
              <div className="mt-1.5 flex justify-center">
                {vitalSigns.spo2.value != null && vitalSigns.spo2.value > 0 ? (
                  vitalSigns.spo2.calibration?.available ? (
                    <span className="text-[7px] font-bold px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-300 border border-emerald-500/30">CALIBRADO</span>
                  ) : (
                    <span className="text-[7px] font-bold px-2 py-0.5 rounded-full bg-amber-500/20 text-amber-300 border border-amber-500/30">ESTIMADO</span>
                  )
                ) : (
                  <span className="text-[7px] font-bold px-2 py-0.5 rounded-full bg-zinc-500/20 text-zinc-300 border border-zinc-500/30">NO DISPONIBLE</span>
                )}
              </div>
            </div>
          </div>

          {/* Presión arterial */}
          {vitalSigns.bloodPressure.value && vitalSigns.bloodPressure.value.systolic > 0 && (
            <div className="glass-card rounded-2xl p-3.5 border border-white/5 flex items-center gap-3 shadow-lg">
              <div className="p-2 rounded-xl bg-indigo-500/10 border border-indigo-500/20">
                <Shield className="w-4 h-4 text-indigo-400" />
              </div>
              <div className="flex-1">
                <div className="flex items-center justify-between mb-0.5">
                  <div className="text-zinc-400 text-[9px] font-mono uppercase tracking-wider">PRESIÓN ARTERIAL</div>
                  {vitalSigns.bloodPressure.calibration?.available ? (
                    <span className="text-[7px] font-bold px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-300 border border-emerald-500/30">CALIBRADO</span>
                  ) : (
                    <span className="text-[7px] font-bold px-2 py-0.5 rounded-full bg-amber-500/20 text-amber-300 border border-amber-500/30">ESTIMADO</span>
                  )}
                </div>
                <div className="text-white text-lg font-bold font-mono">
                  {Math.round(vitalSigns.bloodPressure.value.systolic)}/{Math.round(vitalSigns.bloodPressure.value.diastolic)}
                  <span className="text-xs text-zinc-400 ml-1 font-sans">mmHg</span>
                  {(() => {
                    const unc = vitalSigns.bloodPressure.diagnostics?.uncertainty as { sbpP5?: number; sbpP95?: number } | undefined;
                    return unc && typeof unc.sbpP5 === 'number' && typeof unc.sbpP95 === 'number' ? (
                      <span className="text-xs text-zinc-400 ml-2 font-mono">
                        [{Math.round(unc.sbpP5)}–{Math.round(unc.sbpP95)}]
                      </span>
                    ) : null;
                  })()}
                </div>
                {(() => {
                  const nx = vitalSigns.bloodPressure.diagnostics?.nexus as { tauMs?: number; coherenceLevel?: string } | undefined;
                  return nx && typeof nx.tauMs === 'number' ? (
                    <div className="text-[9px] font-mono text-zinc-500 mt-0.5">
                      τ {Math.round(nx.tauMs)} ms · {nx.coherenceLevel}
                    </div>
                  ) : null;
                })()}
              </div>
            </div>
          )}

          {/* Barras de ritmo */}
          <div className="glass-card rounded-2xl p-3.5 border border-white/5 space-y-2 shadow-lg">
            <div className="flex items-center justify-between mb-1">
              <span className="text-zinc-300 text-[10px] font-bold font-mono tracking-wider uppercase">ANÁLISIS DE RITMO</span>
              <div className="flex items-center gap-1 text-zinc-400 text-[9px] font-mono">
                <Clock className="w-3 h-3 text-zinc-500" />
                <span>60s</span>
              </div>
            </div>

            {/* Latidos normales */}
            <div>
              <div className="flex justify-between items-center mb-1">
                <span className="text-emerald-400 text-[9px] font-mono">■ Latidos Normales</span>
                <span className="text-white text-xs font-bold font-mono">{normalBeats}</span>
              </div>
              <div className="w-full h-2 bg-black/40 rounded-full overflow-hidden p-0.5 border border-white/5">
                <div className="h-full bg-gradient-to-r from-emerald-500 to-teal-400 rounded-full transition-all duration-1000 ease-out"
                  style={{ width: `${totalBeats > 0 ? (normalBeats / totalBeats) * 100 : 0}%` }} />
              </div>
            </div>

            {/* Arritmias */}
            <div>
              <div className="flex justify-between items-center mb-1">
                <span className="text-rose-400 text-[9px] font-mono">■ Arrítmicos / Ectópicos</span>
                <span className="text-white text-xs font-bold font-mono">{arrhythmiaBeats}</span>
              </div>
              <div className="w-full h-2 bg-black/40 rounded-full overflow-hidden p-0.5 border border-white/5">
                <div className={`h-full rounded-full transition-all duration-1000 ease-out ${arrhythmiaBeats > 0 ? 'bg-gradient-to-r from-rose-600 to-red-500' : 'bg-zinc-800'}`}
                  style={{ width: `${totalBeats > 0 ? (arrhythmiaBeats / totalBeats) * 100 : 100}%` }} />
              </div>
            </div>
          </div>

          {/* Poincaré Plot de HRV */}
          {rrIntervals && rrIntervals.length >= 2 && (
            <div className="flex justify-center my-1 animate-in fade-in zoom-in-95 duration-500">
              <PoincarePlot rrIntervals={rrIntervals} width={200} height={200} />
            </div>
          )}

          {/* Porcentaje circular visual */}
          <div className="glass-card rounded-2xl p-3 border border-white/5 flex items-center justify-center gap-4">
            <div className="relative w-14 h-14">
              <svg viewBox="0 0 36 36" className="w-full h-full -rotate-90">
                <path d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831"
                  fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth="3" />
                <path d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831"
                  fill="none"
                  className={strokeClass}
                  strokeWidth="3"
                  strokeDasharray={`${normalPercent}, 100`}
                  strokeLinecap="round" />
              </svg>
              <div className="absolute inset-0 flex items-center justify-center">
                <span className={`text-xs font-bold font-mono ${textClass}`}>
                  {normalPercent}%
                </span>
              </div>
            </div>
            <div>
              <div className="text-white text-xs font-bold font-heading">Regularidad de Ritmo</div>
              <div className="text-zinc-400 text-[9px] font-mono">{totalBeats} latidos registrados</div>
              <div className={`text-[10px] font-bold mt-0.5 font-mono ${textClass}`}>
                {statusText}
              </div>
            </div>
          </div>

          {/* Tarjeta de Validación Clínica (MeasurementWindowValidator) */}
          {validationVerdict && (
            <div className={`glass-card rounded-2xl p-3 border ${validationVerdict.accepted ? 'border-emerald-500/30 bg-emerald-500/5' : 'border-amber-500/30 bg-amber-500/5'} space-y-1.5 shadow-lg`}>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-1.5">
                  {validationVerdict.accepted ? (
                    <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
                  ) : (
                    <AlertTriangle className="w-3.5 h-3.5 text-amber-400" />
                  )}
                  <span className={`text-[10px] font-bold font-mono tracking-wider uppercase ${validationVerdict.accepted ? 'text-emerald-400' : 'text-amber-400'}`}>
                    {validationVerdict.accepted ? 'VENTANA CLÍNICA VALIDADA' : 'CALIDAD DE SEÑAL SUBÓPTIMA'}
                  </span>
                </div>
                <span className="text-[9px] font-mono text-zinc-400">
                  SQI {Math.round(validationVerdict.qualitySummary.sqiMedian)}% · {Math.round(validationVerdict.qualitySummary.fpsMedian)} FPS
                </span>
              </div>
              {!validationVerdict.accepted && validationVerdict.rejectionReasons.length > 0 && (
                <p className="text-[9px] font-mono text-amber-300/80 leading-tight">
                  {validationVerdict.rejectionReasons[0]}
                </p>
              )}
              {!validationVerdict.accepted && avgBpm === '--' && (
                <p className="text-[9px] font-mono text-amber-300/80 leading-tight">
                  Sin pulso válido: no genera fila de historial (BPM en --).
                </p>
              )}
              <p className="text-[8px] font-mono text-zinc-500 leading-tight">
                SpO₂/PA son estimaciones experimentales de bienestar, no mediciones clínicas.
              </p>
            </div>
          )}

          {/* Botón Análisis AI */}
          <button
            onClick={onAnalyze}
            disabled={isAnalyzing}
            className="w-full mt-1 flex items-center justify-center gap-2 py-3 px-4 rounded-2xl bg-gradient-to-r from-purple-600 via-indigo-600 to-purple-700 hover:from-purple-500 hover:to-indigo-500 text-white font-bold text-xs font-mono uppercase tracking-wider transition-all active:scale-[0.98] shadow-xl shadow-purple-950/40 disabled:opacity-50 border border-purple-400/30"
          >
            {isAnalyzing ? (
              <><Loader2 className="w-4 h-4 animate-spin" /> Analizando...</>
            ) : (
              <><Brain className="w-4 h-4 text-purple-200" /> Análisis AI de Salud</>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
