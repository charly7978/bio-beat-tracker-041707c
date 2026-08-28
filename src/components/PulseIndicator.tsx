import { Heart } from 'lucide-react';

interface PulseIndicatorProps {
  showPulse: boolean;
}

export function PulseIndicator({ showPulse }: PulseIndicatorProps) {
  return (
    <div className="absolute z-20 flex items-center gap-2 pointer-events-none" style={{ top: '10px', left: '124px' }}>
      <div className="relative flex items-center justify-center">
        {showPulse && (
          <>
            <div className="absolute w-7 h-7 rounded-full bg-rose-500/30 animate-ripple pointer-events-none" />
            <div className="absolute w-5 h-5 rounded-full bg-rose-500/50 animate-ping pointer-events-none duration-700" />
          </>
        )}
        <div
          className={`relative p-1.5 rounded-full backdrop-blur-md transition-all duration-150 ${
            showPulse
              ? 'bg-rose-500/30 scale-125 shadow-lg shadow-rose-500/50 border border-rose-400/50'
              : 'bg-emerald-500/10 scale-100 border border-emerald-500/20'
          }`}
        >
          <Heart
            className={`w-3.5 h-3.5 transition-all duration-150 ${
              showPulse ? 'text-rose-400 drop-shadow-[0_0_8px_rgba(244,63,94,0.8)]' : 'text-emerald-500/40'
            }`}
            fill={showPulse ? 'currentColor' : 'none'}
          />
        </div>
      </div>
    </div>
  );
}
