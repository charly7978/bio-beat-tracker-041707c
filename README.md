# Bio-Beat Tracker

Estimación de bienestar mediante **fotopletismografía (PPG)** con la cámara del
smartphone: pulso (BPM), SpO₂ experimental, presión arterial experimental (PWA,
requiere calibración), respiración e irregularidad de ritmo.

> **No es un dispositivo médico.** Las estimaciones de SpO₂ y PA son
> exploratorias y no sustituyen a un oxímetro ni a un tensiómetro certificado.
> El pulso (temporización de latidos) es la medición principal; el resto queda
> claramente etiquetado como estimación. Ver `docs/medical-validation.md`.

## Quickstart

```sh
npm i
npm run dev        # Vite en http://localhost:8080
```

Sin variables de entorno la app arranca en **modo local** (mediciones cifradas
en el dispositivo). Para sincronizar con Supabase, ver la sección de variables.

## Verificación

```sh
npm run check:all  # lint + typecheck + orphans + arquitectura + no-sim + tests + build
```

| Script | Qué protege |
|---|---|
| `check:orphans` | 0 archivos huérfanos, imports resolubles |
| `check:architecture` | 10 módulos canónicos, sin procesadores paralelos |
| `check:no-sim` / `:dist` | prohíbe `Math.random`/mock/synthetic en el pipeline PPG |
| `test` | 55 archivos / 344 tests (vitest) |

## Estructura

- `src/modules/signal-processing/` — pipeline PPG (filtros, picos, SQI, ROI)
- `src/modules/vital-signs/` — SpO₂, PA, respiración, arritmia, calibración
- `src/config/` — **fuente única de umbrales y constantes** (vitalThresholds, signalProcessing, ui, webrtc)
- `src/hooks/`, `src/lib/` — orquestación y utilidades (acquisition, measurement, gym, storage)
- `docs/ARCHITECTURE.md` — flujo end-to-end, fuentes de verdad, límites
- `docs/audit-2026-10-15.md` — última auditoría profunda (fases, decisiones, pendientes)

## Medición clínica (dedo) vs modo gym (facial)

- **Clínico (dedo)**: cámara trasera + flash; el dedo solo se acepta con
  evidencia pulsátil real (no por color).
- **Gym (facial)**: cámara frontal, rPPG (POS Wang 2017); más sensible a
  iluminación/movimiento.

## Variables de entorno (nube opcional)

Configurar en el dashboard del deploy (Lovable → Project Settings → Environment
Variables, o el proveedor equivalente). **No** se leen desde `.env` (excluido
del repo):

| Variable | Dónde obtenerla |
|---|---|
| `VITE_SUPABASE_URL` | Supabase → Project Settings → API → Project URL |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | Supabase → claves API → `anon`/publishable (**nunca** `service_role`) |

Además, el edge function `analyze-vitals` (análisis IA) requiere
`LOVABLE_API_KEY` en el entorno de Supabase Functions.

## Deploy

- **Web**: publicar desde Lovable (Share → Publish).
- **APK Android**: GitHub Actions → workflow «Construir APK» (manual);
  genera debug APK con `cap sync` + Gradle. Se requiere Android SDK 36/Java 21
  (ya configurado en el workflow).

## Stack

Vite · React 18 · TypeScript · Tailwind CSS · Capacitor (Android) · Supabase ·
Vitest
