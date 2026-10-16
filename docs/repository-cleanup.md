# Auditoría de Depuración del Repositorio

**Fecha:** 2026-05-09
**Objetivo:** repositorio sin archivos huérfanos, código duplicado ni APIs obsoletas.

## Archivos eliminados

| Archivo | Motivo |
|---|---|
| `src/components/CameraPreview.tsx` | Componente obsoleto, reemplazado por `CameraView.tsx`. Cero importadores. |
| `src/components/MonitorButton.tsx` | Botón legacy no usado en ningún lado. |
| `src/utils/qualityUtils.ts` | Utilidad sin importadores; lógica de calidad vive en `PPGSignalProcessor`. |
| `src/lib/ppg/**` (12 archivos) | Librería duplicada de la lógica ya implementada en `PPGSignalProcessor` / `BandpassFilter`. Sin cablear. |
| API `setArrhythmiaState` (no-op) en `useHeartBeatProcessor` | Era función vacía; las arritmias se gestionan en `ArrhythmiaProcessor`. Eliminadas también las 3 llamadas en `Index.tsx`. |

## Mapa de dependencias actual (limpio)

```
CameraView (MediaStream + torch)
   │ requestVideoFrameCallback
   ▼
useSignalProcessor → PPGSignalProcessor
   │   • extractROI (5×5 tiles, exclusión de saturados)
   │   • multi-source (R / G / RG)
   │   • BandpassFilter (Butterworth 0.3–5 Hz IIR)
   │   • SQI unificado, perfusion index, contact state
   ▼
ProcessedSignal
   │
   ├─► useHeartBeatProcessor → HeartBeatProcessor (peak detection, BPM)
   │
   └─► useVitalSignsProcessor → VitalSignsProcessor
           ├─ SpO2 (R/G ratio)
           ├─ BloodPressureProcessor (PWA + 74 features)
           ├─ PPGFeatureExtractor (cycles, RR variability)
           └─ ArrhythmiaProcessor (RR intervals)
   ▼
Index.tsx (UI)
   ├─► PPGSignalMeter (oscilloscope canvas, full-screen)
   ├─► VitalSign × N (con `--` cuando valor = 0)
   └─► useSaveMeasurement (Supabase persist al finalizar 60s)
```

## Verificación tras limpieza

- `rg "CameraPreview|MonitorButton|qualityUtils|lib/ppg|setArrhythmiaState"` → **0 referencias** en `src/`.
- Build TypeScript sin errores.
- Cada archivo restante en `src/` está importado por al menos otro archivo (excepto `App.tsx` y `main.tsx` que son entry-points, y los `.d.ts` que son ambient types).

## Inventario final (38 archivos `.ts/.tsx`)

- **Páginas:** `Index.tsx`, `Auth.tsx`, `NotFound.tsx`
- **Componentes:** `CameraView`, `PPGSignalMeter`, `VitalSign` + UI primitives (button, card, input, toast, sonner, toaster)
- **Hooks:** `useSignalProcessor`, `useHeartBeatProcessor`, `useVitalSignsProcessor`, `useHealthAnalysis`, `useSaveMeasurement`, `use-toast`
- **Módulos signal-processing:** `PPGSignalProcessor`, `BandpassFilter`
- **Módulos vital-signs:** `VitalSignsProcessor`, `BloodPressureProcessor`, `PPGFeatureExtractor`, `arrhythmia-processor`
- **Módulos:** `HeartBeatProcessor`
- **Utils:** `arrhythmiaUtils`, `soundUtils`, `CircularBuffer`, `lib/utils`
- **Tipos:** `signal.d.ts`, `media-stream.d.ts`, `screen-orientation.d.ts`, `vite-env.d.ts`
- **Integración:** `supabase/client.ts`, `supabase/types.ts`

No queda código duplicado, obsoleto, ni APIs no-op. El cableado es lineal y unidireccional.

## Updated 2026-10-16 — Auditoría profunda (F3/F5/F7)

### Código muerto eliminado (F3)

Referencia completa en `docs/audit-2026-10-15.md`. Resumen: módulos completos sin
importadores (`lib/ppg/**` ya no existía; se eliminaron restos en `signal-processing/shared`,
`signal-quality`, `dsp`, `CircularBuffer`, `stats`, `AcquisitionStabilizer`, hooks y
archivos de configuración), 32 claves muertas de `vitalThresholds`, 2 métodos muertos de
`VitalSignsProcessor`, y el probe GPU de `usePerfTelemetry`. Guardrails permanentes:
`check:orphans` (0 huérfanos, 168 archivos) y `check:architecture` (10 módulos canónicos).

### Refactor estructural (F5)

`Index.tsx` (~1.7k líneas) → orquestador con 3 componentes extraídos:
`SplashScreen.tsx`, `measurement/MeasurementSummaryModal.tsx`, `SettingsPanel.tsx`.
`NotFound.tsx` traducido a español y usando `<Link>` de react-router (antes `<a href>`
recargaba la SPA completa). Duración límite de toasts movida a `src/config/ui.ts`.

### Limpieza de directorios de herramientas (F7)

Eliminados del repo: `.lovable/`, `.run/`, `.kilo/`, `.opencode/`, `.playwright-mcp/`,
`.qodo/` (configs de herramientas locales; conservados `.Codex/` con skills del proyecto).
`.claude/launch.json` corregido a puerto 8080 (el dev server real de Vite).
`.gitignore` ahora ignora esos directorios y `*.jks`/`*.keystore`.

### Android: generados fuera del control de versiones

`git rm --cached` de archivos regenerables por `npx cap sync` (que CI ejecuta):
`android/app/src/main/assets/public/**`, `capacitor.config.json`,
`capacitor.plugins.json`, `res/xml/config.xml`, `android/capacitor-cordova-android-plugins/**`.
`AndroidManifest.xml`: `allowBackup` a `false` (datos de salud no salen en backups de nube).
