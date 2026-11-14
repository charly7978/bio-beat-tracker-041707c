import { useEffect, useRef } from 'react';
import { X, ExternalLink } from 'lucide-react';
import card from '@/lib/models/ppgToEcg.card.json';

export function EcgModelInfo({ onClose }: { onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => { if (element?.open) element.close(); };
  }, []);

  return <dialog ref={dialog} className="model-dialog" aria-labelledby="ecg-model-title" onCancel={onClose} onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="model-dialog-content">
      <div className="model-dialog-top"><span className="model-badge">MODELO ENTRENADO · INVESTIGACIÓN</span><button type="button" aria-label="Cerrar información del modelo" onClick={onClose}><X size={20}/></button></div>
      <h2 id="ecg-model-title">Lo que el modelo aprendió.<br/><span>Y lo que aún no resolvió.</span></h2>
      <p>Entrenamiento con PPG y ECG reales, registrados simultáneamente. La prueba en personas separadas mostró una concordancia insuficiente para interpretar el ECG individual.</p>
      <dl className="model-report-metrics">
        <div><dt>Correlación con ECG</dt><dd>{card.test.pearson.toFixed(3)}</dd></div>
        <div><dt>Error relativo · RMSE</dt><dd>{card.test.rmse.toFixed(3)}</dd></div>
        <div><dt>Mejora sobre referencia</dt><dd>{card.test.improvementPercent.toFixed(2)}<small> %</small></dd></div>
      </dl>
      <p className="model-report-baseline">Referencia: predecir la media del ECG normalizado. RMSE de referencia {card.test.baselineRmse.toFixed(3)}. Una mejora pequeña no demuestra utilidad clínica.</p>
      <dl className="model-report-details">
        <div><dt>Datos</dt><dd>{card.dataset}</dd></div>
        <div><dt>Personas por conjunto</dt><dd>{card.subjects.train} entrenamiento · {card.subjects.validation} validación · {card.subjects.test} prueba</dd></div>
        <div><dt>Muestreo / contexto</dt><dd>{card.sampleRate} Hz · {card.inputLength / card.sampleRate} s · amplitud relativa</dd></div>
      </dl>
      <p className="model-report-limit">La fuente de entrenamiento es un pulsioxímetro hospitalario. Todavía no se evaluó este modelo con registros pareados de cámara y ECG. Su salida no alimenta métricas, diagnósticos ni alertas.</p>
      <a href={card.sourceUrl} target="_blank" rel="noreferrer">Consultar el dataset y su licencia <ExternalLink size={14}/></a>
      <code>{card.modelId}</code>
    </div>
  </dialog>;
}
