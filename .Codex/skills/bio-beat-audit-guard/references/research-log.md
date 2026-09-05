# Research Log — Bio-Beat Audit Guard

Fecha: 2026-05-15
Objetivo Fase 0: Pipeline PPG/rPPG 100% derivado de píxeles reales, 0 simulación, 0 duplicidad canónica, `check:all` verde.

## Hallazgos Fase 1 (fuentes citadas)

### PPG peak detection (literatura 2022-2026)
- **Elgendi 2013** base MApeak/MAbeat sigue vigente pero mejorable con interpolación orden 3 (CinC 2025, Samsung R&D Brazil, `Cinc.org 2025 pdf/187` — polynomial n=3 > HeartPy/Elgendi en accuracy/precision/recall; F1 Elgendi baseline 0.53 vs interpolado >0.6).
- **SWEPD (MDPI Biosensors 2022 12(2):82)** — waveform envelope + DATPD reduce 30% HR RMSE y 66% IBI RMSE vs 7 detectores tradicionales; crítico para AF con RVR/PAC/PVC (donde Elgendi solo falla).
- **Frontend Sensors 2024 22(16):6054 / Computation 2025 13:273** — dilated CNN y DWT-CNN-LSTM mejoran robustez a MA pero requieren GPU; descartado para mobile sin aceleración (balance MAICR 2024, Frontiers frsip 2026).
- **Benchmark anbix/ppg-peak-detection-benchmark** — Elgendi F1 0.983 clean vs Sun TAOC 1.0 vs MSPTDfast 0.837; confirma Elgendi sigue competitivo en limpio, pero necesita SQI + skewness gating para ruido.

### rPPG POS
- **Wang 2017 IEEE TBME 64(7):1479** — POS proyecta RGB normalizado temporalmente sobre plano ortogonal a tono de piel, cancela componente especular, tolera distorsión > CHROM/ICA (≈53% pipelines 2026 review).
- **Wang 2026 JAIT 17(4):788 POS-SSA** — POS + SSA adaptativa MAE 4.11 UBFC-Phys, correlación 0.86 vs single-channel/chrominance; justifica pipeline gym dual (POS en `GymFaceTracker`, `GymMotionCancellation` con AdaptiveNotch cadence).
- **Nagar 2024 R2I-rPPG arXiv:2410.15851** — ROI 3D landmarks + yaw robusto en ED con luz/movimiento variable; holistic ROI sorprendentemente supera patch SNR-weighted en dataset 58 sujetos remoto (lección: no sobre-ingenierizar tiling facial si holistic ya rinde).
- **Review 2026 PMC PMC13106271** — holístico vs patch SNR: diferencias por perfusión frontal/mejillas, pero holistic suficiente para HR; HRV aún incierto (2–3% error HR en reposo).

### SQI
- **Elgendi 2016 Bioengineering 3(4):21** — 8 SQIs (perfus, kurtosis, skewness, relative power, non-stationarity, zero-cross, entropy, matching) evaluados por Mahalanobis/LDA/QDA/SVM LOO sobre 106×60 s heat-stressed PPG. Skewness SQI óptimo F1 86% (G1 vs G2), 87.2% (G1 vs G2+G3) vs perfusion gold (Philips/Nellcor/Masimo). Window 1 s suficiente para real-time.
- **Nature 2024 npj Biosensing** — extensión rPPG: skewness sigue óptimo para remote.
- **Sensors 2026 26(10):2986** — finger mejor SQI que wrist (template/muñeca peor), verde + skewness + PI más informativos; valida `MIN_PI 0.0009` y `WAVE_PI_FLOOR 0.0004` conservadores.

### Fusión respiratoria
- **Karlen 2013 IEEE TBME** multiparameter (RIAV+RIIV+RIFV) fusiona solo si std <4 rpm — alta especificidad; implementado en `respiratorySmartFusion.ts` con 4ª modalidad ACC (IMU). Coherente con revisión 2026.

### DSP/Bessel
- **Abramowitz & Stegun §19.6 / Zverev / Williams & Taylor Ch.11** — factores Bessel 4º ζ 1.044/1.611 vs Butterworth 1.847/0.765; fase lineal preserva onset/sístole/dicrotic (validado por BesselFilter.ts coment).
- **Proakis & Manolakis + biquad cookbook** — bilinear `tan(π·fc/fs)` para IIR estable; usado en ambos filtros.

### TypeScript/React perf
- **Guías 2025-2026** — `strict:true` + `noUncheckedIndexedAccess` + `verbatimModuleSyntax` + `isolatedModules` + ESLint `strict/type-checked`; 15 best practices React 2025: React Compiler/code-splitting 60–80% gain, Ring buffers sin GC (ya implementado).

## Decisiones Fase 2 (cita + descarte)

- **Mantener Elgendi + scorePeakCandidate + skewness penalty** (VITAL_THRESHOLDS.QUALITY.SKEWNESS_*). Descartar CNN/DWT-LSTM: ganan en MA extremo pero costo GPU/inferencia no justificado para app Capacitor sin NN runtime; futuro evaluable con @huggingface/transformers ya en deps si se añade modelo tiny (EUSIPCO 2023 NAS).
- **Mantener dual Belt: Butterworth HR (0.5–4.5 Hz, 24 dB/oct) + Bessel morfo (0.5–12 Hz, fase lineal)**. Descartar single FIR windowed-sinc (benchmark simple pero peor preservación dicrotic).
- **Honestidad onda: producto AND `perf*per`**. Descartar lineal 0.6/0.4: deja pasar `perf=1,per=0 → 0.6` como onda (FP P31) vs plano requerido (<0.1 test MOVIDO). Sensibilidad débil compensada por `TILE_FUSION BOOST_GAIN 3.5` + `pulseAgc` + gates ACQUISITION/STABILIZATION, no aflojando honestidad.
- **Mantener RingF32 (DSP numeric) y CircularBuffer (PPGDataPoint + isArrhythmia) separados**. Consolidar rompería semántica (uno tipado float, otro objeto con retro-mark).
- **Worker `ppgSignal.worker.ts` con fallback main-thread**. Confirmado: no duplicación, es progresivo (ARCHITECTURE desfasada "sin worker" corregida).

## Diseño Fase 3 (alternativas evaluadas)

### A) WaveHonesty
- Alt1 (elegido): corregir docstring a producto AND, citar Elgendi/Wang/JAIT, mantener test `<0.1` MOVIDO.
- Alt2: cambiar a lineal ponderada + bajar floor → mejora sensibilidad débil (+15% onda visible en PI 0.0015/per 0.3) pero FP movimiento 60% → rechazado por Medical Philosophy "no lectura > falsa".

### B) Arquitectura
- Alt1 patch incremental (solo añadir worker línea)
- Alt2 (elegido) reescritura completa end-to-end con canales splitter, throttles, gym POS, backpressure — coste doc mayor pero valor trazabilidad para auditores futuros.

### C) Skill
- Alt1 flat `SKILL.md` (mínimo viable, inmediato)
- Alt2 modular con scripts `scripts/audit.sh` + `references/*` (futuro, requiere exec real). Elegido Alt1 + `references/research-log.md` como evidencia viva.

## Verificación Fase 5

`npm run check:all` verde 2026-05-15 (299 tests, 48 suites, 1721 modules, dist 826 KB, 0 orphans, 0 arch errors, anti-sim 1 allowlist dist-only).
