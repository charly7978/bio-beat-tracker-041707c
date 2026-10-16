-- NOTA: la tabla `measurement_attempts` ya existe desde
-- `20260516203000_measurement_attempts.sql`. Este archivo se mantiene
-- idempotente para no romper aplicaciones frescas ni bases donde ya se
-- aplicó: solo garantiza grants de API, índice y políticas RLS.
-- (Antes fallaba con «relation already exists» en cualquier instalación nueva.)

CREATE TABLE IF NOT EXISTS public.measurement_attempts (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  outcome TEXT NOT NULL,
  signal_quality INTEGER NOT NULL DEFAULT 0,
  diagnostics JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT ON public.measurement_attempts TO authenticated;
GRANT ALL ON public.measurement_attempts TO service_role;
ALTER TABLE public.measurement_attempts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users can insert own attempts" ON public.measurement_attempts;
CREATE POLICY "Users can insert own attempts" ON public.measurement_attempts FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
DROP POLICY IF EXISTS "Users can read own attempts" ON public.measurement_attempts;
CREATE POLICY "Users can read own attempts" ON public.measurement_attempts FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE INDEX IF NOT EXISTS measurement_attempts_user_idx ON public.measurement_attempts(user_id, created_at DESC);
