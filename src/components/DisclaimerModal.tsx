import React from 'react';
import { AlertTriangle } from 'lucide-react';

interface DisclaimerModalProps {
  isOpen: boolean;
  onAccept: () => void;
}

export function DisclaimerModal({ isOpen, onAccept }: DisclaimerModalProps) {
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-[110] flex items-center justify-center bg-black/95 backdrop-blur-md animate-fade-in p-4 overflow-y-auto">
      <div className="bg-black border border-zinc-900/80 rounded-2xl max-w-sm w-full shadow-2xl p-5 space-y-5 animate-in zoom-in-95 duration-300 max-h-[90vh] flex flex-col">
        <div className="text-center space-y-2">
          <div className="w-12 h-12 rounded-full bg-red-500/10 border border-red-500/20 flex items-center justify-center mx-auto">
            <AlertTriangle className="w-6 h-6 text-red-500" />
          </div>
          <h3 className="text-white text-base font-bold tracking-wide uppercase">
            Descargo de Responsabilidad Médica
          </h3>
          <p className="text-red-400 text-[10px] font-bold tracking-wider uppercase">
            Aviso Importante
          </p>
        </div>

        <div className="flex-1 overflow-y-auto text-zinc-400 text-[11px] leading-relaxed space-y-3.5 pr-1 border-y border-zinc-950 py-4">
          <p>
            Esta aplicación utiliza fotopletismografía (PPG) a través de la cámara y el flash de su smartphone para estimar el pulso, la variabilidad de la frecuencia cardíaca, la saturación de oxígeno (SpO₂) y la presión arterial.
          </p>
          <p className="font-semibold text-white">
            Esta aplicación NO es un dispositivo médico y NO ha sido certificada por la FDA, EMA ni ninguna entidad reguladora de salud.
          </p>
          <p>
            Los resultados mostrados son aproximaciones con fines informativos y de bienestar personal. No deben utilizarse para autodiagnóstico, prevención o tratamiento de ninguna condición médica.
          </p>
          <p>
            Si usted tiene antecedentes de hipertensión, arritmia u otras afecciones cardiovasculares, debe utilizar dispositivos clínicos de grado médico validados y consultar con su médico antes de tomar cualquier decisión clínica.
          </p>
          <p>
            Al hacer clic en &quot;Aceptar y Continuar&quot;, usted confirma que comprende y acepta que el uso de esta app es bajo su propio riesgo y discreción.
          </p>
        </div>

        <button
          onClick={onAccept}
          className="w-full py-3 rounded-xl bg-gradient-to-r from-emerald-600 to-indigo-600 hover:from-emerald-500 hover:to-indigo-500 text-white font-bold text-xs tracking-wider transition-all hover:scale-[1.02] active:scale-[0.98]"
        >
          ACEPTAR Y CONTINUAR
        </button>
      </div>
    </div>
  );
}

