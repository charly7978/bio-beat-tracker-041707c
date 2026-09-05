---
name: bio-beat-audit-guard
description: Auditoría integral anti-simulación, anti-duplicidad y de arquitectura para bio-beat-tracker con verificación research-first. Usar cuando se pida auditar, detectar fallas/duplicidad/simulación, verificar gates sagrados o endurecer pipeline PPG/rPPG sin regresiones.
---

# Bio-Beat Audit Guard

Skill de auditoría y endurecimiento para `bio-beat-tracker` (PPG por cámara + rPPG POS frontal). Viaja con el repo en `.Codex/skills/bio-beat-audit-guard/` y aplica el estándar research-first: nada se toca sin evidencia citada.

## Paso 1: Definir objetivo medible

Antes de auditar, fija por escrito:

- **Frase de éxito**: "Pipeline PPG/rPPG 100% derivado de píxeles reales, 0 simulación, 0 duplicidad canónica, `npm run check:all` verde, sin regresión de BPM/SpO2/BP/arritmia."
- **Criterios innegociables**:
  - `check:no-sim` 0 violaciones (ver `scripts/anti-sim-allowlist.json` auditada)
  - `check:architecture` 0 errores (módulos canónicos únicos)
  - `check:orphans` 0 huérfanos
  - `lint` + `typecheck` 0 errores
  - `test` 299+ en verde
  - `build` + `check:no-sim:dist` verde
  - Medical Philosophy: sin contacto/calidad insuficiente → `value null`/`--`, jamás número inventado

Si el objetivo es vago, reformular hasta medible. Sin esto no se avanza.

## Paso 2: Investigación profunda (antes de tocar código)

Consultar fuentes autorizadas **recientes** para cada dominio tocado y registrar hallazgos:

- **PPG peak detection**: Elgendi 2013 (MApeak/MAbeat) vs Sun TAOC 2022 vs MSPTDfast 2024; CinC 2025 — interpolación polinomial orden 3 mejora precisión/recall vs Elgendi/HeartPy; MDPI Sensors 2022 — SWEPD reduce 30–66% error IBI vs 7 detectores tradicionales incluso en AF con RVR y PAC/PVC.
- **rPPG POS**: Wang 2017 IEEE TBME 64(7):1479 (plane orthogonal to skin-tone); Wang 2026 JAIT 17(4):788 POS-SSA (MAE 4.99 PFF / 4.11 UBFC-Phys); Nagar 2024 R2I-rPPG (ROI 3D landmarks + yaw).
- **SQI**: Elgendi 2016 Bioengineering 3(4):21 — 8 SQIs comparados por LDA/QDA/SVM LOO: skewness SQI óptimo (F1 86% G1 vs G2, 87.2% G1 vs G2+G3) superior a perfusión (gold standard Philips/Nellcor/Masimo) y a kurtosis/perfusion/power/non-stationarity/zero-cross/entropy/matching. Validación 2026 Sensors 26(10):2986 confirma skewness+PI más informativos, dedo mejor que muñeca.
- **DSP**: Proakis & Manolakis 4th ed + biquad cookbook (tomroelandts) para Butterworth/Bessel 4º orden (2 biquads, bilinear `tan(π·fc/fs)`); Bessel ζ 1.044/1.611 (Abramowitz & Stegun §19.6, Zverev) preserva fiduciales (onset/sístole/dicrotic).
- **Fusión respiratoria**: Karlen 2013 IEEE TBME multiparameter (RIAV+RIIV+RIFV) — solo fusionar si concuerdan (std <4 rpm).
- **TypeScript/React**: `strict:true` + `noUncheckedIndexedAccess` + `verbatimModuleSyntax` + `isolatedModules` + `skipLibCheck` + ESLint `strict/type-checked` (estado 2025-2026). Performance: React Compiler/code-splitting 60–80% impacto, RingF32 sin `Array.shift` O(n).

> Registrar cada decisión con cita. Sin fuente, volver a investigar.

## Paso 3: Ejecutar barrido de auditoría (4 ejes)

Ejecuta en paralelo; todo con evidencia `file:line`.

1. **Anti-simulación** — `rg "Math\.random" src/` debe ser 0 en `src/`; `rg -i "synthet|sine.*wave|generate.*signal|seed"` 0; `Math.(sin|cos|tan)` solo en `BandpassFilter.ts`/`BesselFilter.ts` (coefs) y `ica.ts` `Math.tanh` (FastICA); nunca `120/80`/`return.*spo2.*9[0-9]` hardcodeado salvo comentario "SIN BASE FIJA". Verificar `scripts/check-no-simulation.mjs` + allowlist con `reason+ref`.
2. **Arquitectura/ duplicidad** — `npm run check:architecture` + `check:orphans`; canónicos únicos (`VitalMeasurement`, `vitalThresholds`, `signalProcessing`, `dsp.ts`, `SignalQualityIndex`, `CalibrationManager`, `PeakDetectionEnsemble`/`ElgendiPeakDetector`); prohibidos `*V2`/`FinalProcessor`; un solo `RingF32` para DSP numérico y `CircularBuffer` para `PPGDataPoint` (isArrhythmia) — no consolidar a la fuerza.
3. **Performance** — revisar `PPGSignalProcessor.ts` hot path (stride, LUT teselado, `statScratch`/`periodicityScratch` reusables, periodicidad cada 4 frames, SQI cada 8, throttle tileFusion); `HeartBeatProcessor.ts` Float32/Float64 circular + `robustBounds`; `useSignalRouter` throttles (HR 80 ms, vitals 300 ms). Worker `ppgSignal.worker.ts` debe tener fallback main-thread.
4. **Honestidad clínica/UI** — `waveHonesty.ts` `perf*per` AND (<0.1 para movimiento sin periodicidad, test `objeto MOVIDO`); `SignalQualityIndex.isClinicallyValid/isAdequateForLiveVitals` gating; UI `--` si `value null/0`; EMA doble solo visual; calibración `REQUIRES_CALIBRATION` sin perfil vigente; `arrhythmia-processor` con quiet 8 s + learning 10 s + confirm 2.5 s + deadband aprendido.

Documenta hallazgos por severidad; si 1 load-bearing issue → reportar y no cerrar.

## Paso 4: Decidir reemplazos (síntesis citada)

Para cada hallazgo, explicita opciones descartadas y por qué:

- Conservar vs consolidar filtros: Butterworth (HR 0.5–4.5 Hz, roll-off 24 dB/oct) vs Bessel (morfo 0.5–12 Hz, fase lineal) — mantener ambos (Splitter los aísla por canal vital), fuente Bessel en `references/`.
- Honestidad de onda: producto AND (especificidad, evita FP tipo showcase) vs lineal 0.6/0.4 (sensibilidad débil pero deja pasar movimiento) — elegir producto; sensibilidad débil se compensa aguas arriba (`TILE_FUSION BOOST_GAIN 3.5`, `pulseAgc`, `ACQUISITION` gates), cita `waveHonesty.test.ts`.
- Worker vs main: worker off-main reduce jank pero requiere `ImageData` transfer + `applyConstraints` → mantener ambos con feature-detect.

Sin evidencia suficiente, volver a Fase 1.

## Paso 5: Implementar con rigor (research-first)

- Tipado explícito, sin `any`; funciones pequeñas, 1 responsabilidad; tests para lógica de negocio.
- Cambio enfocado, verifica antes de seguir. Nunca `try/catch` vacío — corregir causa raíz.
- Respetar contratos: `MEASUREMENT_STATUS`, `VITAL_THRESHOLDS` única fuente, `PEAK_DETECTION_DEFAULTS` única fuente, publicación BPM solo vía pico validado.
- Documentar gates en código: ` // Gate: perf*per AND — Elgendi 2016, Wang 2017, ver waveHonesty.ts ` con cita.

## Paso 6: Verificación innegociable

Ejecutar en orden y corregir hasta verde:

```bash
npm run lint
npm run typecheck
npm run check:orphans
npm run check:architecture
npm run check:no-sim
npm run test
npm run build
npm run check:no-sim:dist
# o atajo
npm run check:all
```

Además:
- Abrir `npm run dev` en desktop y móvil (ancho 360 px): probar dedo sin contacto → onda plana, SQI 0, `--`; dedo estable → onda + BPM; perder contacto → BPM a 0 sin extrapolación; gym frontal → POS estable.
- Probar caminos de fallo: `TORCH_UNAVAILABLE`, `LOW_FPS`, `MOTION_ARTIFACT`, `UNDEREXPOSED` → status correcto, nunca 500 ciego.
- Validar que `dist/` no introduce `Math.random` en ruta de señal (`check:no-sim:dist`).

Prohibido entregar con tests/build/typecheck rojos o verificación no ejecutada.

## Paso 7: Cierre y trazabilidad

Al cerrar, reportar bloque obligatorio:

```
### Cumplimiento del mensaje
- Solicitado: <lo pedido>
- Hecho: <implementado/verificado con evidencia file:line + fuentes>
- Pendiente/No hecho: <lo que falte, sin excusas>
```

Incluir literatura decisiva y aprendizajes. Si "Pendiente/No hecho" no vacío, tarea NO terminada.

## Referencias del proyecto (verificar contra código)

- `src/lib/ui/waveHonesty.ts:22` — `perf*per` AND gate
- `src/modules/signal-quality/SignalQualityIndex.ts` — skewness SQI + PI
- `src/modules/signal-processing/PPGSignalSplitter.ts` — 5 canales vital-specific (Bessel vs Butterworth)
- `src/workers/ppgSignal.worker.ts` — off-main con fallback
- `docs/no-simulation-audit.md` — auditoría viva
- `docs/ARCHITECTURE.md` — pipeline end-to-end (actualizado para incluir worker, gym POS, Splitter)
- `scripts/check-no-simulation.mjs` / `check-architecture.mjs` / `check-orphan-imports.mjs`

## Uso

Activadores: "auditar", "detectar falla/duplicidad/simulación", "revisar arquitectura", "endurecer PPG", "verificar gates sagrados", "research-first audit", "check:all".

Nunca sustituir lo solicitado por enfoque alternativo sin documentarlo como propuesta explícita.
