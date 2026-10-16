# Dependency Audit — Anti-Simulation

**Date:** 2026-05-09
**Scope:** All runtime and dev dependencies in `package.json`.
**Question:** ¿Alguna librería puede inyectar señales sintéticas, valores aleatorios "plausibles" o datos por defecto en el pipeline PPG?
**Result:** ✅ **Ninguna dependencia genera señales sintéticas en el pipeline médico.**

## Metodología

1. Inventario completo de `dependencies` y `devDependencies`.
2. Clasificación por categoría (UI, routing, backend client, build).
3. Verificación de que ninguna toca el camino crítico cámara → PPG → vitales.
4. Búsqueda en `src/` de `Math.random`, `mock`, `fake`, `dummy`, `synthetic`, `simulate` (resultado: 0 coincidencias en código de producción — ver `scripts/check-no-simulation.mjs`).

## Inventario y veredicto

### Runtime (`dependencies`)

| Paquete | Categoría | Toca pipeline PPG | Riesgo de simulación | Notas |
|---|---|---|---|---|
| `react`, `react-dom` | UI runtime | No | ✅ Ninguno | Solo render. |
| `react-router-dom` | Routing | No | ✅ Ninguno | |
| `@capacitor/android`, `@capacitor/camera`, `@capacitor/core`, `@capacitor/haptics` | Capacitor runtime | No | ✅ Ninguno | Solo hardware access. |
| `@capgo/capacitor-health` | Health bridge | No | ✅ Ninguno | Reads native health stores. |
| `@radix-ui/react-toast` | UI primitives | No | ✅ Ninguno | Único primitivo Radix del proyecto (react-slot eliminado 2026-10-16: 0 usos). |
| `@supabase/supabase-js` | Backend client | Solo persistencia post-medicion | ✅ Ninguno | No fabrica vitales; solo lee/escribe. |
| `class-variance-authority`, `clsx`, `tailwind-merge`, `tailwindcss-animate` | Styling | No | ✅ Ninguno | |
| `lucide-react` | Iconos SVG | No | ✅ Ninguno | Estatico. |
| `zustand` | State management | No | ✅ Ninguno | Solo stores numericos. |

### Build / dev (`devDependencies`)

| Paquete | Categoría | Riesgo |
|---|---|---|
| `vite`, `@vitejs/plugin-react-swc`, `lovable-tagger` | Build tooling | ✅ Ninguno (no entra al bundle de runtime médico). |
| `typescript`, `@types/*`, `eslint*`, `globals`, `typescript-eslint` | Tipado / lint | ✅ Ninguno. |
| `tailwindcss`, `postcss`, `autoprefixer` | CSS | ✅ Ninguno. |
| `vitest`, `@vitest/ui`, `jsdom` | Testing | ✅ Ninguno (excluido por el guardrail). |
| `@types/node` | Tipos | ✅ Ninguno. |

## Lo que **NO** está instalado (intencional)

Para mantener el pipeline puramente determinista a partir de píxeles reales, el proyecto **rechaza** las siguientes categorías:

- ❌ Generadores de datos: `faker`, `@faker-js/faker`, `chance`, `casual`.
- ❌ Mocks de red/datos: `msw`, `nock`, `sinon`, `jest-mock-extended`.
- ❌ Síntesis de señal/audio: `tone`, `osc-js`, `wavefile` (lectura sintetizada).
- ❌ Pseudo-random "seguros para UI": `nanoid` con seed sintético, `seedrandom`.
- ❌ Charting con sampling sintético por defecto (Recharts/Chart.js no se usan en la onda PPG; el monitor renderiza con `<canvas>` directamente).

Si en el futuro se necesita alguno (ej. `faker` para tests), debe quedar en `devDependencies` y nunca importarse desde `src/modules/**` ni desde `src/hooks/use{Signal,VitalSigns,HeartBeat}*`.

## Garantías automatizadas

1. **`scripts/check-no-simulation.mjs`** — escanea `src/` (excluyendo tests) y falla si encuentra `Math.random`, `mock`, `fake`, `dummy`, `synthetic`, `simulate`. Excepciones explícitas vía marcador `// anti-sim-allow: <razón>`.
2. **CI (`.github/workflows/ci.yml`)** — ejecuta `npm run check:no-sim` en cada push/PR. Build rojo si falla.
3. **Pre-commit hook (`.githooks/pre-commit`)** — bloquea commits con `Math.random` y keywords de simulación.
4. **Política de PR** — cualquier nueva dependencia debe agregarse a este informe con su categoría y justificación.

## Procedimiento para agregar una nueva dependencia

1. Justificar en el PR por qué es necesaria.
2. Confirmar que no toca `src/modules/signal-processing/**`, `src/modules/vital-signs/**` ni `src/components/CameraView.tsx`.
3. Actualizar la tabla de inventario en este documento.
4. Verificar que `npm run check:no-sim` y los tests pasan.

## Conclusión

El árbol de dependencias actual es **mínimo y auditado**. Ninguna librería puede contaminar el pipeline médico con valores sintéticos. El guardrail de CI bloquea automáticamente cualquier regresión.
## Updated 2026-09-20 - Dependency pruning

Reference audit (0 imports in src/ and supabase/, including dynamic imports). Removed from package.json:

- @capacitor/network (code uses navigator.onLine / online event)
- @capacitor/preferences (code uses localStorage directly)
- @capacitor/status-bar, @capacitor/filesystem, @capacitor/app (no usages)
- bun.lock removed (duplicate lockfile; npm + package-lock.json are operational)

## Updated 2026-10-16 - Audit deep (F6)

- `@radix-ui/react-slot` eliminado (0 usos en `src/`; verificado con rg). Queda solo `@radix-ui/react-toast`.
- `eslint-plugin-react-hooks` `5.1.0-rc.0` → `^5.2.0` (release estable; elimina dependencia de un pre-release).
- CI dejó de usar Bun: `.github/workflows/ci.yml` ahora usa Node 20 + `npm ci` (consistente con `package-lock.json`, que es el único lockfile).
- `tailwind.config.ts` sin `require()` (ESM puro: `import tailwindcssAnimate`).
- `lovable-tagger` se conserva: lo usa `vite.config.ts` (`componentTagger()` solo en modo development). El edge `analyze-vitals` depende del gateway de Lovable (`LOVABLE_API_KEY`); fuera de ese hosting requiere un proveedor alternativo — ver `docs/audit-2026-10-15.md`.
