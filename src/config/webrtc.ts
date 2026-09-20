/**
 * Servidores ICE para la telemetría P2P (WebrtcCallWidget).
 * Única fuente de verdad: si en el futuro se añade TURN propio,
 * debe declararse aquí y NO inline en el componente.
 */
export const ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun2.l.google.com:19302' },
];
