import React from 'react';
import { Activity, X } from 'lucide-react';
import { WebrtcCallWidget } from './WebrtcCallWidget';

interface TelemedicineModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export function TelemedicineModal({ isOpen, onClose }: TelemedicineModalProps) {
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm animate-fade-in">
      <div className="bg-black/95 border border-zinc-900/80 rounded-2xl max-w-sm w-[92%] shadow-2xl flex flex-col max-h-[80vh] animate-in zoom-in-95 duration-200">
        <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-900">
          <div className="flex items-center gap-2">
            <Activity className="w-5 h-5 text-emerald-400" />
            <h3 className="text-white text-sm font-bold">Telemedicina WebRTC</h3>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-full bg-zinc-950 hover:bg-zinc-900 text-zinc-400 hover:text-white transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-4 space-y-3">
          <p className="text-zinc-500 text-[10px] leading-relaxed">
            Conexión P2P directa mediante STUN. Comparte tu descripción SDP con el profesional médico o receptor para sincronizar métricas en tiempo real.
          </p>
          <WebrtcCallWidget />
        </div>
      </div>
    </div>
  );
}

