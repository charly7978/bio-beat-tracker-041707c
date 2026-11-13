# Captación universal y previsualización bajo el piso

## Cambios y límites

La selección de muestras usa identidad de vídeo y tiempos de captura, sin eliminar cuadros nuevos porque coincidan sus píxeles. El detector calibra su cadencia desde la primera ventana disponible y descarta continuidad a través de pausas mayores de 250 ms. La recuperación posterior a movimiento dura 650 ms independientemente de los fps. El pasabanda mantiene su corte superior por debajo de Nyquist, también en el canal de morfología.

El recorte de rojo permanece rechazado para medición. La fotometría independiente permite intentar compensación EV negativa mientras AE sigue automático, antes de que exista contacto estable. No se presupone soporte en Safari/Firefox u otros navegadores: si faltan controles verificables, la recuperación no manda constraints. El ajuste final se serializa detrás de cualquier compensación pendiente y se invalida al cerrar la cámara.

Todas las marcas usan la política de contacto común; sólo FPS y jitter observados ajustan su tolerancia temporal. Los umbrales fisiológicos centrales no cambian.

Se conserva la composición de `main`: fondo → previsualización → líneas de grilla → onda, con el mismo proyector del piso. Se reducen tinte, velo de profundidad, reflejos y brillo del borde; la opacidad del vídeo se mantiene en 0.62.

## Evidencia reproducible

- `acquisitionRobustness.test.ts` recorre RGB → ROI → filtros → **salida real del procesador** → detector de latidos, sin insertar una onda entre etapas. Cubre 15/24/30/60 fps, pulso de referencia de 72 BPM, cambio de iluminación, imagen estática y recorte; además comprueba 48 y 120 BPM a 15/30 fps. Son entradas deterministas de software, no registros clínicos.
- El error admitido en las pruebas de 48/120 BPM está limitado a un cuadro en RR. A 15 fps un cuadro dura 66.7 ms; no se declara precisión temporal menor que esa resolución.
- La regresión de 72 BPM a 15 fps tras un escalón de iluminación daba mediana de 90 BPM al elegir POS; con R/G/R–G da aproximadamente 69.2 BPM. Esto demuestra corrección de ese caso, no precisión en todas las escenas.
- Pruebas adicionales: cuadros con píxeles idénticos, callbacks antiguos tras reiniciar, timestamps no válidos, pérdida de continuidad, filtro acotado, capacidades EV ausentes, constraints ignoradas, cooldown y carrera con el lock final.
- Chromium ejecutó el componente `PPGSignalMeter` con vídeo controlado: opacidad efectiva 0.62, trazos de grilla posteriores a las franjas de vídeo y ningún error de página. Las pruebas de geometría existentes mantienen el trapecio y el punto de fuga compartidos.

## Validación pendiente en dispositivos

Las pruebas anteriores no reemplazan capturas con dedo real. Falta comparar tiempo hasta señal útil, frecuencia de pérdidas, clipping y RR frente a referencia externa en Android de varias gamas e iOS/Safari. La recuperación EV sólo puede ayudar cuando el navegador expone el control y el sensor responde; Vercel no cambia esas capacidades del dispositivo.
