import { Focus, Minus, Plus, ScanLine, ArrowLeft, ArrowRight, Radio, Minimize2, Tags } from 'lucide-react';
import type { useMonitorViewport } from '@/hooks/useMonitorViewport';
import type { PpgLayout } from '@/lib/ui/ppgCanvasRenderer';
import { Ppg3DToggle } from './Ppg3DToggle';

type Props = { viewport: ReturnType<typeof useMonitorViewport>; layout: PpgLayout; quality: number; isMonitoring: boolean; hasSamples: boolean };

export function MonitorControls({ viewport: v, layout, quality, isMonitoring, hasSamples }: Props) {
  return <>
    <div className="monitor-toolbar" style={{ top: layout.metrics.y + layout.metrics.h }}>
      <div className="monitor-channel"><span className={isMonitoring ? 'signal-dot active' : 'signal-dot'} />
        <span>SEÑAL <strong>PPG</strong></span>
        <span className="monitor-quality">SQI {Math.round(quality)}%</span>
      </div>
      <Ppg3DToggle disabled={v.inspecting} />
    </div>
    <div className="monitor-view-controls" style={{ top: layout.plot.y + layout.plot.h + 6 }}>
      <div className="monitor-control-group" aria-label="Escala temporal">
        <button className="monitor-icon-button" aria-label="Alejar señal" disabled={v.windowMs >= 8000} onClick={() => v.changeWindow(v.windowMs * 1.5)}><Minus size={16} /></button>
        <output aria-label="Ventana temporal" className="monitor-scale">{(v.windowMs / 1000).toFixed(1)}<small> s</small></output>
        <button className="monitor-icon-button" aria-label="Acercar señal" disabled={v.windowMs <= 1000} onClick={() => v.changeWindow(v.windowMs / 1.5)}><Plus size={16} /></button>
      </div>
      <div className="monitor-control-group">
        <button className={`monitor-icon-button ${v.annotations ? 'selected' : ''}`} aria-label="Mostrar u ocultar anotaciones de onda" aria-pressed={v.annotations} onClick={v.toggleAnnotations}><Tags size={16}/></button>
        <button className={`monitor-icon-button ${v.inspecting ? 'selected' : ''}`} disabled={!hasSamples && !v.inspecting} aria-label={v.inspecting ? 'Volver a señal en vivo' : 'Inspeccionar señal sin detener captura'} aria-pressed={v.inspecting} onClick={v.inspecting ? v.returnLive : v.inspect}>{v.inspecting ? <Radio size={17}/> : <ScanLine size={17}/>}</button>
        <button className="monitor-icon-button" disabled={layout.height < 650} aria-label={v.focus ? 'Restaurar panel completo' : 'Ampliar área del monitor'} aria-pressed={v.focus} onClick={v.toggleFocus}>{v.focus ? <Minimize2 size={17}/> : <Focus size={17}/>}</button>
      </div>
    </div>
    {v.inspecting && <div className="monitor-inspection-nav" style={{ top: layout.plot.y + 8 }}>
      <button className="monitor-icon-button" aria-label="Ver señal anterior" onClick={() => v.pan(-v.windowMs / 4)}><ArrowLeft size={16}/></button>
      <span>INSPECCIÓN 2D<small>{isMonitoring ? 'La captura continúa' : 'Registro de la sesión'}</small></span>
      <button className="monitor-icon-button" aria-label="Ver señal posterior" onClick={() => v.pan(v.windowMs / 4)}><ArrowRight size={16}/></button>
    </div>}
    <p id="monitor-gestures" className="sr-only">Pellizca para cambiar el tiempo visible. Toca para inspeccionar. En inspección, arrastra o usa flechas para explorar; pulsa Escape para volver en vivo. También puedes usar los botones de zoom.</p>
  </>;
}
