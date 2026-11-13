import React from 'react';
import { Heart } from 'lucide-react';

interface PulseIndicatorProps {
  showPulse: boolean;
}

export function PulseIndicator({ showPulse }: PulseIndicatorProps) {
  if (!showPulse) return null;

  return <span className="monitor-beat-event" aria-hidden="true"><Heart size={12}/><span>LATIDO</span></span>;
}
