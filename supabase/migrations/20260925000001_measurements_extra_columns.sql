-- Alinea la tabla `measurements` de instalaciones frescas con el esquema
-- desplegado (reflejado en src/integrations/supabase/types.ts): columnas de
-- trazabilidad del algoritmo y de métricas que la app ya calcula o deja NULL.
-- Idempotente: ADD COLUMN IF NOT EXISTS, sin tocar datos existentes.

ALTER TABLE public.measurements
  ADD COLUMN IF NOT EXISTS algorithm_version TEXT,
  ADD COLUMN IF NOT EXISTS measurement_confidence TEXT,
  ADD COLUMN IF NOT EXISTS measurement_window_seconds NUMERIC,
  ADD COLUMN IF NOT EXISTS signal_quality_index NUMERIC,
  ADD COLUMN IF NOT EXISTS calibration_id UUID,
  ADD COLUMN IF NOT EXISTS rmssd NUMERIC,
  ADD COLUMN IF NOT EXISTS sdnn NUMERIC,
  ADD COLUMN IF NOT EXISTS pnn50 NUMERIC,
  ADD COLUMN IF NOT EXISTS lf_power NUMERIC,
  ADD COLUMN IF NOT EXISTS hf_power NUMERIC,
  ADD COLUMN IF NOT EXISTS lf_hf_ratio NUMERIC,
  ADD COLUMN IF NOT EXISTS glucose INTEGER,
  ADD COLUMN IF NOT EXISTS hemoglobin INTEGER,
  ADD COLUMN IF NOT EXISTS total_cholesterol INTEGER,
  ADD COLUMN IF NOT EXISTS triglycerides INTEGER;
