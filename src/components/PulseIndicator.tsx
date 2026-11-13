import React from 'react';
import { Heart } from 'lucide-react';

interface PulseIndicatorProps {
  showPulse: boolean;
}

export function PulseIndicator({ showPulse }: PulseIndicatorProps) {
  if (!showPulse) return null;

  return (
    <div
      className="absolute z-20 pointer-events-none flex items-center justify-center transition-all duration-150 animate-in fade-in zoom-in-75"
      style={{ top: '8px', right: '110px' }}
    >
      <div className="relative flex items-center justify-center">
        <span className="absolute w-5 h-5 rounded-full bg-red-500/30 animate-ping" />
        <div className="p-1 rounded-full bg-red-500/20 border border-red-500/40">
          <Heart
            className="w-3.5 h-3.5 text-red-400"
            fill="currentColor"
          />
        </div>
      </div>
    </div>
  );
}
