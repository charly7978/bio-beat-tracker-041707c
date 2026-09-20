# Implementation Plan — Auditoría y limpieza integral Bio-Beat Tracker

## [Overview]

Unificar, depurar y elevar la calidad del repositorio **sin romper ninguna función**: eliminar código muerto/obsoleto, dependencias sin uso, artefactos basura y duplicación real, centralizando valores hardcodeados y consolidando la lógica EMA adaptativa duplicada en un módulo compartido.

**Contexto verificado en la investigación previa:**
- Estado base **verde**: `lint` ✅, `typecheck` ✅, 314 tests en 50 archivos ✅, `check:orphans` ✅ (155 archivos, sin huérfanos ni imports rotos).
- Existen guardrails de CI (`scripts/check-architecture.mjs`, `check-no-simulation*.mjs`, `check-orphan-imports.mjs`) que se usarán como red de seguridad tras cada cambio.
- El mapa de módulos canónicos está en `docs/ARCHITECTURE.md`; el plan respeta y amplía ese mapa.
- **No son duplicados** (verificado, se conservan): `CircularBuffer` (PPGDataPoint temporal, usado por `PPGSignalMeter`/`ppgCanvasRenderer`) vs `RingF32` (Float32 DSP, usado por `PPGSignalProcessor`/`VitalSignsProcessor`/`gymMotionCancellation`); y `use-toast.ts` + `components/ui/toast.tsx` (sistema radix activo — `sonner` es el que está sin uso).

## [Types]

Sin cambios en el contrato de dominio (`src/types/measurements.ts`, `src/types/signal.d.ts` intactos). Nuevos tipos de apoyo:

```ts
// src/lib/measurement/adaptiveEma.ts
export interface EmaTier {
  /** Umbral de cambio relativo |next-prev|/|prev| que activa el multiplicador. */
  readonly relativeChange: number;
  /** Multiplicador sobre baseAlpha cuando el cambio supera el umbral. */
  readonly multiplier: number;
}

export interface AdaptiveEmaParams {
  readonly baseAlpha: number;
  /** Tiers de aceleración, evaluados en orden descendente de relativeChange. */
  readonly speedTiers: readonly EmaTier[];
  /** Tier opcional de frenado para cambios muy pequeños. */
  readonly slowTier?: EmaTier;
  readonly alphaMin: number;
  readonly alphaMax: number;
}
```

Constantes exportadas (mismos valores numéricos que hoy, garantiza equivalencia):

```ts
// UI (hoy inline en src/lib/measurement/displaySmoothing.ts)
export const UI_EMA_PARAMS: AdaptiveEmaParams = {
  baseAlpha: 0.18,
  speedTiers: [
    { relativeChange: 0.12, multiplier: 2.8 },
    { relativeChange: 0.05, multiplier: 1.75 },
  ],
  alphaMin: 0.06,
  alphaMax: 0.72,
};

// Procesador (hoy en src/modules/vital-signs/DisplaySmoothing.ts)
export const PROCESSOR_EMA_PARAMS: AdaptiveEmaParams = {
  baseAlpha: 0.20, // 'stable'; 'dynamic' usa 0.35 como baseAlpha
  speedTiers: [
    { relativeChange: 0.5, multiplier: 2.0 },
    { relativeChange: 0.3, multiplier: 1.5 },
  ],
  slowTier: { relativeChange: 0.05, multiplier: 0.5 },
  alphaMin: 0.05,
  alphaMax: 0.5,
};
```

```ts
// src/config/webrtc.ts
export const ICE_SERVERS: RTCIceServer[];
```

```ts
// src/components/error-boundaries/RootErrorBoundary.tsx
interface RootErrorBoundaryProps { children: React.ReactNode }
interface RootErrorBoundaryState { hasError: boolean }
```


## [Files]

**Nuevos:**
| Archivo | Propósito |
|---|---|
| `src/lib/measurement/adaptiveEma.ts` | Núcleo único de EMA adaptativo (`computeAdaptiveAlpha`, `adaptiveEma`, `adaptiveEmaWeighted`) + `UI_EMA_PARAMS`/`PROCESSOR_EMA_PARAMS`. |
| `src/lib/measurement/__tests__/adaptiveEma.test.ts` | Tests de equivalencia numérica contra las fórmulas antiguas (oráculo) + casos borde (NaN, 0, Infinity). |
| `src/config/webrtc.ts` | Servidores ICE (STUN Google) extraídos de `WebrtcCallWidget.tsx`. |
| `src/components/error-boundaries/RootErrorBoundary.tsx` | Boundary raíz extraído de `App.tsx` (mismo render exacto: pantalla negra, "Error de renderizado", botón "Recargar App", estilos inline preservados). Re-exportado desde `src/components/error-boundaries/index.ts`. |

**Modificados:**
| Archivo | Cambio |
|---|---|
| `package.json` | Eliminar dependencias sin uso: `sonner`, `@huggingface/transformers`, `@capacitor/network`, `@capacitor/preferences`, `@capacitor/status-bar`, `@capacitor/filesystem`, `@capacitor/app`. |
| `capacitor.config.ts` | Eliminar entradas `plugins.Filesystem`, `plugins.Preferences`, `plugins.Network`, `plugins.BackgroundTask` (plugins no instalados/huérfanos). Se conservan `Camera` y `Health`. |
| `src/lib/measurement/displaySmoothing.ts` | `smoothDisplayValue`/`lerpDisplayValue` delegan alpha+blend en `adaptiveEma.ts` (clamp base 0.06 y snap `<0.55` se quedan en el wrapper). API pública intacta. |
| `src/modules/vital-signs/DisplaySmoothing.ts` | `smoothValue`/`smoothWeightedValue` delegan en `adaptiveEma.ts` (guardas NaN/0 se quedan en la clase). API pública intacta: `VitalSignsProcessor.ts` no cambia. |
| `src/components/WebrtcCallWidget.tsx` | Importar `ICE_SERVERS` desde `@/config/webrtc` (borra las 3 URLs STUN inline). |
| `src/App.tsx` | Sustituir la clase `ErrorBoundary` inline por `RootErrorBoundary` importada; `App.tsx` queda como composición pura. |
| `src/hooks/usePerfTelemetry.ts` | `APP_VERSION` deja de ser `'1.0.0'` hardcodeado → usa `__APP_VERSION__`. |
| `vite.config.ts` | `define: { __APP_VERSION__: JSON.stringify(pkg.version) }` leyendo `package.json` (con `readFileSync`). |
| `src/vite-env.d.ts` | Declarar `declare const __APP_VERSION__: string;`. |
| `.github/workflows/apk.yml` | Eliminar el step "Aplicar parche con el codigo real" y todo el bloque de parches legacy (`biobeatmejorasyapk.patch`, `ridethroughdedoimpecable.patch`, borrado de `build-apk.yml`). Workflow queda como build puro (checkout → npm install → build → cap sync → gradle). |
| `docs/ARCHITECTURE.md` | Actualizar tabla "Fuentes de verdad": añadir `adaptiveEma.ts` como módulo canónico del suavizado EMA, `config/webrtc.ts`, `RootErrorBoundary`; anotar eliminación de `secure-proxy`. |
| `docs/dependency-audit.md` | Registrar la poda de dependencias. |

**Eliminados:**
| Archivo | Motivo |
|---|---|
| `bun.lock` | Lockfile duplicado; CI y scripts usan npm (`package-lock.json` es el operativo). |
| `supabase/functions/secure-proxy/index.ts` (y carpeta) | Dead code: 0 referencias en `src/` (el cliente solo invoca `analyze-vitals`). |
| `bio-pulse-tracker.apk` (11 MB) | Artefacto de build, ya cubierto por `.gitignore` (`*.apk`); no trackeado. |
| `debug.log`, `tmp_build.log`, `tmp_tsc.log`, `tmp_capgo_install.log` | Logs residuales de desarrollo, no trackeados. |

**Explícitamente NO se toca (riesgo de romper):**
- `Index.tsx` (1734 líneas): monolito pero funcional; dividirlo en componentes es un refactor mayor fuera del alcance de esta limpieza. Se registra como deuda en docs.
- `.env` trackeado en git: intencional — el CI (`apk.yml`) no genera `.env` y el build lo necesita; solo contiene `VITE_SUPABASE_URL`, `PROJECT_ID` y la `PUBLISHABLE_KEY` (pública por diseño, sin service-role). Se documenta, no se elimina.
- `components.json`, `vercel.json`, `.npmrc`, `eslint.config.js`: correctos y en uso.
- `components/ui/toast.tsx` + `hooks/use-toast.ts`: sistema de toasts activo (App.tsx e Index.tsx).

## [Functions]

**Nuevas** (en `src/lib/measurement/adaptiveEma.ts`):
- `computeAdaptiveAlpha(prev: number, next: number, params: AdaptiveEmaParams): number` — calcula el alpha adaptativo: evalúa `speedTiers` en orden descendente, aplica `slowTier` si el cambio relativo es menor que su umbral, clampa a `[alphaMin, alphaMax]`.
- `adaptiveEma(current: number, newVal: number, params: AdaptiveEmaParams): number` — `current*(1-a) + newVal*a`.
- `adaptiveEmaWeighted(current: number, newVal: number, weight: number, params: AdaptiveEmaParams): number` — alpha penalizado por `alpha*(0.15 + 0.85*w)` con clamp `[max(alphaMin, 0.015), alphaMax]` (réplica exacta de `smoothWeightedValue` actual).

**Modificadas:**
- `smoothDisplayValue` (`src/lib/measurement/displaySmoothing.ts`): conserva guardas `next<=0`/`prev<=0` y snap `<0.55`; el cálculo `prev + (next-prev)*a` delega en `adaptiveEma`. Comportamiento numérico idéntico (probado por oráculo).
- `lerpDisplayValue` (`src/lib/measurement/displaySmoothing.ts`): solo cambia su delegación interna.
- `smoothValue`, `smoothWeightedValue` (`src/modules/vital-signs/DisplaySmoothing.ts`): conservan guardas `current===0/NaN/!isFinite`; delegan alpha+blend en `adaptiveEma`/`adaptiveEmaWeighted` con `baseAlpha = type==='stable' ? 0.20 : 0.35`.
- `WebrtcCallWidget` (`src/components/WebrtcCallWidget.tsx`): elimina la constante local `ICE_SERVERS`, importa de config. Sin cambios de comportamiento.
- `App` (`src/App.tsx`): reemplaza clase local por import; árbol JSX idéntico.

**Eliminadas:**
- Clase `ErrorBoundary` inline en `src/App.tsx` → migrada a `RootErrorBoundary.tsx` (mismo código, mismo render). Migración: copiar literal, renombrar, importar, borrar la original.
- Constante `ICE_SERVERS` local en `WebrtcCallWidget.tsx`.
- Constante `APP_VERSION = '1.0.0'` en `usePerfTelemetry.ts` → `__APP_VERSION__`.

## [Classes]

**Nuevas:**
- `RootErrorBoundary` (`src/components/error-boundaries/RootErrorBoundary.tsx`): `React.Component<Props, State>`, métodos `getDerivedStateFromError`, `componentDidCatch` (conserva `console.error` actual), `render`. Exportada también desde `src/components/error-boundaries/index.ts`.

**Modificadas:**
- `DisplaySmoothing` (`src/modules/vital-signs/DisplaySmoothing.ts`): elimina `EMA_ALPHA_STABLE/DYNAMIC` inline en favor de `PROCESSOR_EMA_PARAMS` (stable 0.20 / dynamic 0.35 se pasan como baseAlpha). `updateSpO2Hold`, `updateBPHold`, `reset` intactos.

**Eliminadas:**
- `ErrorBoundary` anónima de `App.tsx` (reemplazada por `RootErrorBoundary`, misma herencia `React.Component`).



## [Dependencies]

**Eliminadas de `dependencies`** (0 referencias en `src/` y `supabase/` — verificado por búsqueda exhaustiva, incluidas importaciones dinámicas):
- `sonner` (el sistema activo es radix `use-toast` + `components/ui/toast.tsx`)
- `@huggingface/transformers` (ninguna importación)
- `@capacitor/network` (el código usa `navigator.onLine` / evento `online`)
- `@capacitor/preferences` (el código usa `localStorage` directamente)
- `@capacitor/status-bar`, `@capacitor/filesystem`, `@capacitor/app` (sin usos)

**Se conservan** (uso real): `@capacitor/haptics` (`utils/haptics.ts`), `@capacitor/camera` (`CameraView.tsx`), `@capgo/capacitor-health` (`lib/capacitor/healthBridge.ts`) y el resto. `lovable-tagger` se conserva (usado por `vite.config.ts` en modo development).

**Integración:** tras editar `package.json` ejecutar `npm install` para regenerar `package-lock.json`; en la siguiente build Android, `npx cap sync android` reflejará la poda de plugins.

## [Testing]

- **Nuevos tests** — `src/lib/measurement/__tests__/adaptiveEma.test.ts`:
  1. *Equivalencia numérica*: para un muestreo de entradas (incluidos bordes rel≈0.12, 0.05, 0.5, 0.3), el resultado de `smoothDisplayValue`/`smoothValue`/`smoothWeightedValue` es idéntico a las fórmulas anteriores (fórmulas viejas reimplementadas inline en el test como oráculo).
  2. Casos borde: `NaN`, `Infinity`, `current=0`, `newVal=0`, `weight` fuera de `[0,1]`.
- **Tests existantes que validan el refactor** (no se modifican): `src/lib/measurement/__tests__/displaySmoothing.test.ts`, `src/modules/vital-signs/__tests__/VitalSignsProcessor.test.ts` (usa `DisplaySmoothing`), suite completa de 314 tests.
- **Validación final obligatoria**: `npm run check:all` (lint + typecheck + check:orphans + check:architecture + check:no-sim + test + build + check:no-sim:dist) — 100% verde.
- **Verificación de bundle**: `npm run build` + confirmar que el tamaño baja (retirada de `@huggingface/transformers` y `sonner` del árbol).
- **CI**: validar sintaxis YAML de `apk.yml` tras simplificarlo.


## [Implementation Order]

1. **Constantes centralizadas (bajo riesgo, independiente):**
   1.1. Crear `src/config/webrtc.ts` + actualizar `WebrtcCallWidget.tsx`.
   1.2. `__APP_VERSION__`: `vite.config.ts` (define con `package.json`) + declaración en `src/vite-env.d.ts` + `usePerfTelemetry.ts`.
2. **Extracción `RootErrorBoundary`**: crear componente, re-exportar en `error-boundaries/index.ts`, reescribir `App.tsx`.
3. **Consolidación EMA (riesgo medio, con oráculo):**
   3.1. Crear `adaptiveEma.ts` + `UI_EMA_PARAMS`/`PROCESSOR_EMA_PARAMS`.
   3.2. Crear `adaptiveEma.test.ts` (oráculo) y verificar contra las implementaciones **aún no refactorizadas**.
   3.3. Refactorizar `displaySmoothing.ts` y `DisplaySmoothing.ts` para delegar; re-ejecutar equivalencia + suites afectadas.
4. **Poda de dependencias y lockfile:** editar `package.json`, `capacitor.config.ts`, `npm install` (regenera `package-lock.json`), borrar `bun.lock`.
5. **Eliminación de código muerto y basura:** borrar `supabase/functions/secure-proxy/`, artefactos raíz (`*.apk`, `*.log`).
6. **Limpieza CI:** simplificar `.github/workflows/apk.yml` (quitar bloque de parches legacy).
7. **Documentación:** actualizar `docs/ARCHITECTURE.md` y `docs/dependency-audit.md`.
8. **Verificación final:** `npm run check:all` completo + revisión del build. Ante cualquier regresión: revertir el paso específico y re-evaluar antes de reintentar.
