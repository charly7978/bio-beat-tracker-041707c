# AGENTS.md — Bio Beat Tracker

PPG por contacto (dedo sobre cámara trasera + flash) en Vite + React 18 + TS, con Capacitor (APK Android) y Supabase. El mapa técnico real es `docs/ARCHITECTURE.md`; `README.md` es boilerplate de Lovable: ignóralo. `.refact/`, `.kilo/`, `.agent-cache/` son estado de herramientas externas: no los edites ni los incluyas en commits.

## Comandos
- Verificación completa (este orden exacto): `npm run check:all` = lint → typecheck → check:orphans → check:architecture → check:no-sim → test → build → check:no-sim:dist.
- CI (`.github/workflows/ci.yml`) instala con **bun** (`bun install` / `bun run …`); en local usa npm. `bun.lock` y `package-lock.json` coexisten: no mezcles gestores en el mismo cambio.
- Un solo test: `npx vitest run src/.../X.test.ts`. Vitest: jsdom, pool `threads` (por timeouts de forks en Windows — no cambiar a `forks` sin medir), timeout 30 s, alias `@` → `src/`.
- APK: solo por workflow manual (`apk.yml`, `workflow_dispatch`), que aplica los `*.patch` de la raíz antes de compilar. No construyas el APK local sin pedido explícito.

## Guardarraíles que impone CI (romperlos = build rojo)
- `check:architecture` exige módulos canónicos únicos: prohibido crear procesadores "V2/Final/Advanced/New", la carpeta `src/lib/ppg/` o `CameraPreview.tsx`. Ante una mejora, REEMPLAZA el módulo canónico; nunca dupliques uno paralelo.
- `check:no-sim`: prohibido `Math.random` y las palabras mock/fake/dummy/synthetic/simulate en `src/**` (tests excluidos). Filosofía: "priorizar 'no reading' sobre false reading" — si la señal no alcanza, `0` / `--` / `INSUFFICIENT`, nunca un número inventado (`docs/no-simulation-audit.md`).
- Fuentes de verdad únicas: umbrales fisiológicos y firma de dedo → `src/config/vitalThresholds.ts`; DSP/ventanas → `src/config/signalProcessing.ts`; contrato de medición → `src/types/measurements.ts`.

## Arquitectura (lo que no se deduce de los nombres)
- Cadena: `CameraView` → `useFrameLoop` (rVFC) → `useSignalProcessor` → Worker `src/workers/ppgSignal.worker.ts` (`PPGSignalProcessor`) → `ProcessedSignal` → `useSignalRouter` → `useHeartBeatProcessor` (BPM/RR) y `useVitalSignsProcessor` (SpO₂/PA/respiración/arritmias). El DSP corre en Worker; React solo enruta y muestra.
- `Index.tsx` llama `cameraRef.optimizeForFinger(redLevel)` UNA vez al entrar en `STABLE_CONTACT`; el pipeline de colocación de dedo vive en `PPGSignalProcessor` (firma RGB + pulsátil), no en la cámara.

## Fotometría de cámara (reglas duras)
- **ISP lock diferido**: AE/AWB van en `continuous` mientras se coloca el dedo y se fijan en `manual` una sola vez en `STABLE_CONTACT` (`CameraView.optimizeForFinger`). No "arregles" esto bloqueando manual al abrir la cámara: congelar la escena vacía retrasaba la convergencia ~25–30 s.
- **Orden de `applyConstraints`**: en `advanced`, un entry que falla impide aplicar los siguientes, y Chrome ignora el valor de exposición (iso/exposureTime/EC) enviado en la misma llamada que el cambio a `exposureMode: 'manual'`. Modo primero, valor después, en llamadas separadas; verifica el lock leyendo `getSettings()` tras aplicar (ya expuesto en `getDiagnostics`).
- **Timestamps de sub-frame**: el timestamp de muestra es `metadata.presentationTime` de rVFC (misma base monótona que `performance.now()`, precisión µs); `now` es hora de event loop y arrastra jitter a la fs estimada y a los RR. `mediaTime` puede ser 0 en streams en vivo: úsalo solo como identificador de frame (frames perdidos en `ppgPerf`), nunca como reloj de muestra. No mezcles bases de tiempo en un mismo buffer.
- **Lente ↔ flash**: `facingMode: environment` NO garantiza la lente principal en Android multi-lente (Chrome puede abrir gran angular/tele en Samsung/Huawei) y las labels de `enumerateDevices` dependen de vendor/locale — no filtres cámaras por string de label. Proxy web fiable de "lente junto al flash": `getCapabilities().torch` de la track elegida. El escaneo de co-ubicación (`src/lib/device/lensCoLocation.ts`, ~500 ms con torch) es SOLO diagnóstico de colocación: alerta si la lente activa queda oscura con torch confirmado, pero NO debe usarse como gate de medición ni avanzar filtros de estado dentro de React.
- Todo control ISP va capability-gated y best-effort (`advanced`, nunca `exact`): iOS Safari no implementa modos manuales ni `getCapabilities` completo (Firefox tampoco), el torch iOS <17.5 no existe y Safari 18 devuelve `getSettings().torch` stale. `CameraView` ya prueba 4 sintaxis de torch y verifica con settings — no simplificar.

## Reglas del pipeline (heredadas y vigentes)
- Mantén estimadores y publicación de RR libres de EMAs de presentación: un solo filtro de display, dueño por ref, vive en el signal router y suaviza las muestras aceptadas, para que la latencia de display nunca se apile.
- Mantén snapshots crudos de vitales separados de los valores renderizados; nunca avances un filtro con estado dentro de un updater de React ni en un loop de animación de canvas (la cadencia de replay/render no debe afectar las mediciones).
- Preserva los gates de señal, la aceptación fisiológica de RR y las funciones de límites clínicos al cambiar el suavizado de display; los tests A/B deterministas miden retardo de software, no exactitud clínica.

## Riesgos y limitaciones
- SpO₂ y PA no tienen validación clínica: la PA usa un MLP con etiquetas sintéticas generadas en `training/` (Python); nunca presentes estados `VALID` como exactitud clínica.
- `docs/medical-validation.md` NO existe en este repo; si un protocolo lo cita como referencia, es aspiracional, no una fuente real.
