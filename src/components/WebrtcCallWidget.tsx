import { useState, useRef, useCallback, useEffect } from 'react';
import { Phone, PhoneOff, Copy, Check, Radio, Activity, AlertCircle } from 'lucide-react';
import type { VitalSignsResult } from '@/modules/vital-signs/VitalSignsProcessor';
import { createLogger } from '@/utils/logger';
import { ICE_SERVERS } from '@/config/webrtc';

const log = createLogger('WebrtcCallWidget');

export interface VitalsTelemetryPacket {
  type: 'vitals_packet' | 'ping' | 'pong';
  timestamp: number;
  data?: {
    heartRate?: number | null;
    spo2?: number | null;
    systolic?: number | null;
    diastolic?: number | null;
    arrhythmiaStatus?: string;
    signalQuality?: number;
  };
}

interface WebrtcCallWidgetProps {
  vitals?: VitalSignsResult | null;
}

export function WebrtcCallWidget({ vitals }: WebrtcCallWidgetProps) {
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const dataChannelRef = useRef<RTCDataChannel | null>(null);
  const gatheringTimerRef = useRef<number | null>(null);
  const pingIntervalRef = useRef<number | null>(null);

  const [connectionState, setConnectionState] = useState<RTCPeerConnectionState>('new');
  const [dataChannelState, setDataChannelState] = useState<RTCDataChannelState>('closed');
  const [localSdp, setLocalSdp] = useState('');
  const [remoteInput, setRemoteInput] = useState('');
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const [latencyMs, setLatencyMs] = useState<number | null>(null);
  const [remoteVitals, setRemoteVitals] = useState<VitalsTelemetryPacket['data'] | null>(null);

  const cleanup = useCallback(() => {
    if (gatheringTimerRef.current) {
      window.clearTimeout(gatheringTimerRef.current);
      gatheringTimerRef.current = null;
    }
    if (pingIntervalRef.current) {
      window.clearInterval(pingIntervalRef.current);
      pingIntervalRef.current = null;
    }
    if (dataChannelRef.current) {
      dataChannelRef.current.close();
      dataChannelRef.current = null;
    }
    if (pcRef.current) {
      pcRef.current.close();
      pcRef.current = null;
    }
    setConnectionState('new');
    setDataChannelState('closed');
    setLocalSdp('');
    setError('');
    setLatencyMs(null);
    setRemoteVitals(null);
  }, []);

  useEffect(() => {
    return () => {
      cleanup();
    };
  }, [cleanup]);

  const setupDataChannel = useCallback((channel: RTCDataChannel) => {
    dataChannelRef.current = channel;
    channel.onopen = () => {
      setDataChannelState('open');
      log.info('DataChannel vitals opened');

      // Start ping loop
      pingIntervalRef.current = window.setInterval(() => {
        if (channel.readyState === 'open') {
          const pingPacket: VitalsTelemetryPacket = {
            type: 'ping',
            timestamp: performance.now(),
          };
          try {
            channel.send(JSON.stringify(pingPacket));
          } catch (e) {
            log.debug('DataChannel ping failed:', e);
          }
        }
      }, 3000);
    };

    channel.onclose = () => {
      setDataChannelState('closed');
      if (pingIntervalRef.current) {
        window.clearInterval(pingIntervalRef.current);
        pingIntervalRef.current = null;
      }
    };

    channel.onerror = (e) => {
      log.warn('DataChannel error:', e);
    };

    channel.onmessage = (event) => {
      try {
        const packet = JSON.parse(event.data) as VitalsTelemetryPacket;
        if (packet.type === 'ping') {
          const pongPacket: VitalsTelemetryPacket = {
            type: 'pong',
            timestamp: packet.timestamp,
          };
          if (channel.readyState === 'open') channel.send(JSON.stringify(pongPacket));
        } else if (packet.type === 'pong') {
          const rtt = Math.round(performance.now() - packet.timestamp);
          setLatencyMs(rtt);
        } else if (packet.type === 'vitals_packet' && packet.data) {
          setRemoteVitals(packet.data);
        }
      } catch (err) {
        log.debug('Invalid DataChannel message received:', err);
      }
    };
  }, []);

  // Broadcast local vitals over DataChannel when available
  useEffect(() => {
    if (vitals && dataChannelRef.current?.readyState === 'open') {
      const packet: VitalsTelemetryPacket = {
        type: 'vitals_packet',
        timestamp: Date.now(),
        data: {
          heartRate: vitals.heartRate.value,
          spo2: vitals.spo2.value,
          systolic: vitals.bloodPressure.value?.systolic,
          diastolic: vitals.bloodPressure.value?.diastolic,
          arrhythmiaStatus: vitals.arrhythmia.value?.status,
          signalQuality: vitals.signalQuality,
        },
      };
      try {
        dataChannelRef.current.send(JSON.stringify(packet));
      } catch (e) {
        log.debug('DataChannel send failed:', e);
      }
    }
  }, [vitals]);

  const startCall = useCallback(async () => {
    cleanup();
    setError('');
    try {
      const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
      pcRef.current = pc;

      pc.onconnectionstatechange = () => setConnectionState(pc.connectionState);
      pc.oniceconnectionstatechange = () => setConnectionState(pc.connectionState);

      pc.onicegatheringstatechange = () => {
        if (pc.iceGatheringState === 'complete' && pc.localDescription) {
          setLocalSdp(JSON.stringify(pc.localDescription));
        }
      };

      pc.ondatachannel = (e) => {
        setupDataChannel(e.channel);
      };

      const dc = pc.createDataChannel('vitals', { ordered: true });
      setupDataChannel(dc);

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      // Safety timeout: if gathering takes > 1500ms, use available description immediately
      gatheringTimerRef.current = window.setTimeout(() => {
        if (pc.localDescription) {
          setLocalSdp(JSON.stringify(pc.localDescription));
        }
      }, 1500);
    } catch (err) {
      setError(String(err));
      log.error('Failed to create WebRTC offer:', err);
    }
  }, [cleanup, setupDataChannel]);

  const acceptCall = useCallback(async () => {
    if (!remoteInput.trim()) return;
    setError('');
    try {
      const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
      pcRef.current = pc;

      pc.onconnectionstatechange = () => setConnectionState(pc.connectionState);
      pc.oniceconnectionstatechange = () => setConnectionState(pc.connectionState);

      pc.ondatachannel = (e) => {
        setupDataChannel(e.channel);
      };

      const desc = JSON.parse(remoteInput.trim()) as RTCSessionDescriptionInit;
      await pc.setRemoteDescription(desc);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);

      pc.onicegatheringstatechange = () => {
        if (pc.iceGatheringState === 'complete' && pc.localDescription) {
          setLocalSdp(JSON.stringify(pc.localDescription));
        }
      };

      gatheringTimerRef.current = window.setTimeout(() => {
        if (pc.localDescription) {
          setLocalSdp(JSON.stringify(pc.localDescription));
        }
      }, 1500);
    } catch (err) {
      setError(`Error al procesar SDP remoto: ${String(err)}`);
      log.error('Failed to accept WebRTC call:', err);
    }
  }, [remoteInput, setupDataChannel]);

  const copySdp = useCallback(() => {
    navigator.clipboard.writeText(localSdp).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }).catch((err) => {
      setError(`No se pudo copiar al portapapeles: ${String(err)}`);
    });
  }, [localSdp]);

  const isIdle = connectionState === 'new' || connectionState === 'closed' || connectionState === 'failed';
  const isConnected = connectionState === 'connected';

  return (
    <div className="space-y-2.5 p-3 rounded-xl bg-black/40 border border-zinc-800/80">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5">
          <Radio className={`w-3.5 h-3.5 ${isConnected ? 'text-emerald-400 animate-pulse' : 'text-zinc-500'}`} />
          <span className="text-[10px] font-semibold text-zinc-300">Telemedicina P2P</span>
        </div>
        <div className="flex items-center gap-2">
          {latencyMs !== null && (
            <span className="text-[8px] font-mono text-zinc-400">
              {latencyMs} ms
            </span>
          )}
          <span className={`px-1.5 py-0.5 rounded text-[8px] font-bold uppercase tracking-wider ${
            isConnected
              ? 'bg-emerald-950/80 text-emerald-400 border border-emerald-800/60'
              : connectionState === 'connecting'
              ? 'bg-amber-950/80 text-amber-400 border border-amber-800/60'
              : connectionState === 'failed'
              ? 'bg-rose-950/80 text-rose-400 border border-rose-800/60'
              : 'bg-zinc-900 text-zinc-500 border border-zinc-800'
          }`}>
            {connectionState}
          </span>
        </div>
      </div>

      {!isConnected && connectionState !== 'connecting' && (
        <button
          onClick={startCall}
          disabled={!isIdle}
          className="w-full py-2 rounded-lg bg-emerald-600/20 border border-emerald-900/50 text-emerald-400 hover:bg-emerald-600/30 active:scale-[0.99] font-bold text-[10px] transition-all flex items-center justify-center gap-1.5 disabled:opacity-50"
        >
          <Phone className="w-3.5 h-3.5" />
          {isIdle ? 'CREAR OFERTA P2P (Iniciador)' : 'RECONECTAR'}
        </button>
      )}

      {localSdp && (
        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <span className="text-[9px] text-zinc-400">SDP Local (copiar y enviar):</span>
            <button
              onClick={copySdp}
              className="flex items-center gap-1 text-[9px] text-emerald-400 hover:text-emerald-300 font-semibold px-2 py-0.5 rounded bg-emerald-950/50 border border-emerald-900/40"
            >
              {copied ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
              {copied ? 'Copiado' : 'Copiar'}
            </button>
          </div>
          <pre className="text-[7px] text-zinc-400 bg-zinc-950 rounded-lg p-2 max-h-16 overflow-hidden break-all select-all font-mono border border-zinc-800/60">
            {localSdp.slice(0, 200)}...
          </pre>
        </div>
      )}

      {isIdle && !localSdp && (
        <div className="space-y-1.5">
          <textarea
            value={remoteInput}
            onChange={(e) => setRemoteInput(e.target.value)}
            placeholder="Pega el SDP remoto del médico/paciente aquí..."
            className="w-full bg-zinc-950 border border-zinc-800 rounded-lg p-2 text-[9px] text-zinc-300 font-mono h-14 resize-none focus:outline-none focus:border-emerald-500 placeholder:text-zinc-600"
          />
          <button
            onClick={acceptCall}
            disabled={!remoteInput.trim()}
            className="w-full py-1.5 rounded-lg bg-emerald-600/10 border border-emerald-900/40 text-emerald-400 hover:bg-emerald-600/20 active:scale-[0.99] font-bold text-[9px] transition-all disabled:opacity-30 flex items-center justify-center gap-1"
          >
            <Activity className="w-3 h-3" />
            RESPONDER (Crear Answer)
          </button>
        </div>
      )}

      {isConnected && (
        <div className="p-2.5 rounded-lg bg-emerald-950/20 border border-emerald-900/30 space-y-2">
          <div className="flex items-center justify-between text-[9px]">
            <span className="text-emerald-400 font-semibold flex items-center gap-1">
              <Activity className="w-3 h-3" />
              Canal de telemetría activo ({dataChannelState})
            </span>
            <button
              onClick={cleanup}
              className="text-rose-400 hover:text-rose-300 flex items-center gap-1 px-2 py-0.5 rounded bg-rose-950/40 border border-rose-900/40"
            >
              <PhoneOff className="w-3 h-3" />
              Finalizar
            </button>
          </div>

          {remoteVitals && (
            <div className="grid grid-cols-3 gap-1.5 pt-1">
              <div className="bg-black/40 p-1.5 rounded border border-zinc-800 text-center">
                <div className="text-[7px] text-zinc-500 uppercase">FC Remota</div>
                <div className="text-[11px] font-bold text-emerald-400 font-mono">
                  {remoteVitals.heartRate ?? '--'} BPM
                </div>
              </div>
              <div className="bg-black/40 p-1.5 rounded border border-zinc-800 text-center">
                <div className="text-[7px] text-zinc-500 uppercase">SpO₂ Remoto</div>
                <div className="text-[11px] font-bold text-cyan-400 font-mono">
                  {remoteVitals.spo2 ?? '--'}%
                </div>
              </div>
              <div className="bg-black/40 p-1.5 rounded border border-zinc-800 text-center">
                <div className="text-[7px] text-zinc-500 uppercase">PA Remota</div>
                <div className="text-[11px] font-bold text-indigo-400 font-mono">
                  {remoteVitals.systolic ? `${remoteVitals.systolic}/${remoteVitals.diastolic}` : '--'}
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {error && (
        <div className="flex items-center gap-1.5 p-2 rounded bg-rose-950/40 border border-rose-900/50 text-rose-400 text-[8px]">
          <AlertCircle className="w-3 h-3 shrink-0" />
          <span>{error}</span>
        </div>
      )}
    </div>
  );
}
