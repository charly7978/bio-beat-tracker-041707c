import { Focus, Minus, Plus, ScanLine, ArrowLeft, ArrowRight, Radio, Minimize2, Tags } from 'lucide-react';
import type { useMonitorViewport } from '@/hooks/useMonitorViewport';
import type { PpgLayout } from '@/lib/ui/ppgCanvasRenderer';
import { Ppg3DToggle } from './Ppg3DToggle';
import { hasInlineMonitorControls, splitMorphologyPlot } from '@/lib/ui/monitorLayout';

type Props = { viewport: ReturnType<typeof useMonitorViewport>; layout: PpgLayout; quality: number; isMonitoring: boolean; hasSamples: boolean; hybrid: boolean; onToggleHybrid: () => void; analysisMode: 'ecg' | 'derivatives'; onToggleAnalysisMode: () => void };

export function MonitorControls({ viewport: v, layout, quality, isMonitoring, hasSamples, hybrid, onToggleHybrid, analysisMode, onToggleAnalysisMode }: Props) {
  const wide = layout.width >= 1024 && layout.height >= 600;
  const inline = hasInlineMonitorControls(layout.width, layout.height);
  const hybridAvailable = splitMorphologyPlot(layout.plot, true).morphology.h > 0;
  const showHybrid = hybrid && hybridAvailable;
  const controlWidth = inline ? layout.width - layout.plot.x * 2 : layout.plot.w;
  const toolbarTop = wide ? layout.header.h : layout.metrics.y + layout.metrics.h;
  const toolbarStyle = { top: toolbarTop, left: layout.plot.x, right: 'auto', width: controlWidth * (inline ? .55 : 1) };
  return <>
    <div className="monitor-toolbar" style={toolbarStyle}>
      <div className="monitor-channel"><span className={isMonitoring ? 'signal-dot active' : 'signal-dot'} />
        <span>SEÑAL <strong>PPG</strong></span>
        <span className="monitor-quality">SQI {Math.round(quality)}%</span>
      </div>
      <div className="monitor-modes">
        <button type="button" className="monitor-hybrid-toggle" disabled={!hybridAvailable} aria-pressed={showHybrid} onClick={onToggleHybrid} title={hybridAvailable ? 'Combinar PPG con el modelo entrenado o las derivadas ópticas' : 'La vista híbrida necesita más altura; gira el dispositivo'}>
          <span className={!showHybrid ? 'active' : ''}>PPG</span><span className={showHybrid ? 'active' : ''}>HÍBRIDO</span>
        </button>
        <Ppg3DToggle disabled={v.inspecting} />
      </div>
    </div>
    <div className="monitor-view-controls" style={{ top: inline ? toolbarTop + 2 : layout.plot.y + layout.plot.h + 8, left: layout.plot.x + (inline ? controlWidth * .56 : 0), right: 'auto', width: controlWidth * (inline ? .44 : 1) }}>
      <div className="monitor-control-group" aria-label="Escala temporal">
        <button className="monitor-icon-button" aria-label="Alejar señal" disabled={v.windowMs >= 8000} onClick={() => v.changeWindow(v.windowMs * 1.5)}><Minus size={16} /></button>
        <output aria-label="Ventana temporal" className="monitor-scale">{(v.windowMs / 1000).toFixed(1)}<small> s</small></output>
        <button className="monitor-icon-button" aria-label="Acercar señal" disabled={v.windowMs <= 1000} onClick={() => v.changeWindow(v.windowMs / 1.5)}><Plus size={16} /></button>
      </div>
      <div className="monitor-control-group">
        {showHybrid ? <button className="monitor-analysis-mode" aria-label={analysisMode === 'ecg' ? 'Mostrar derivadas ópticas VPG y APG' : 'Mostrar ECG estimado por modelo entrenado'} onClick={onToggleAnalysisMode} title="Alternar ECG estimado y derivadas ópticas">{analysisMode === 'ecg' ? 'ECG IA' : 'VPG/APG'}</button> : <button className={`monitor-icon-button ${v.annotations ? 'selected' : ''}`} aria-label="Mostrar u ocultar anotaciones de onda" aria-pressed={v.annotations} onClick={v.toggleAnnotations}><Tags size={16}/></button>}
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
