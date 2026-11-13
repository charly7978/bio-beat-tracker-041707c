import React from 'react';
import { Brain, X, Loader2 } from 'lucide-react';

interface AIAnalysisModalProps {
  isOpen: boolean;
  isAnalyzing: boolean;
  analysis: string | null;
  onClose: () => void;
}

export function AIAnalysisModal({
  isOpen,
  isAnalyzing,
  analysis,
  onClose,
}: AIAnalysisModalProps) {
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/85 backdrop-blur-sm animate-fade-in">
      <div className="bg-black border border-slate-700/50 rounded-2xl max-w-sm w-[92%] max-h-[80vh] shadow-2xl overflow-hidden flex flex-col">
        <div className="px-4 py-3 bg-purple-500/10 border-b border-zinc-900 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Brain className="w-5 h-5 text-purple-400" />
            <h3 className="text-white text-sm font-bold">Análisis AI de Salud</h3>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-full bg-zinc-900 hover:bg-slate-700 transition-colors"
          >
            <X className="w-4 h-4 text-zinc-400" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-4">
          {isAnalyzing ? (
            <div className="flex flex-col items-center justify-center py-12 gap-3">
              <Loader2 className="w-8 h-8 text-purple-400 animate-spin" />
              <p className="text-zinc-400 text-sm">Analizando tus signos vitales...</p>
            </div>
          ) : analysis ? (
            <div className="text-slate-300 text-xs leading-relaxed whitespace-pre-wrap">
              {analysis}
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center py-12 gap-3">
              <p className="text-zinc-500 text-sm">No se pudo generar el análisis.</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

