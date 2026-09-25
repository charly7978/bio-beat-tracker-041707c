-- Alinea el CHECK de `measurement_attempts.outcome` con los resultados que
-- emite la app (`src/lib/measurements/savePolicy.ts`):
--   valid_saved | rejected_low_quality | rejected_incomplete (legado) |
--   rejected_status | rejected_artifact | rejected_auth
-- Sin esto, los intentos `rejected_artifact` se rechazaban en BD y solo se
-- registraba un `log.warn` en cliente (auditoría silenciosamente perdida).
-- Idempotente y sin tocar datos existentes ni tablas ajenas.

DO $$
DECLARE
  c RECORD;
BEGIN
  FOR c IN
    SELECT conname
    FROM pg_constraint
    WHERE conrelid = 'public.measurement_attempts'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) LIKE '%outcome%'
  LOOP
    EXECUTE format('ALTER TABLE public.measurement_attempts DROP CONSTRAINT %I', c.conname);
  END LOOP;
END
$$;

ALTER TABLE public.measurement_attempts
  ADD CONSTRAINT measurement_attempts_outcome_check
  CHECK (
    outcome IN (
      'valid_saved',
      'rejected_low_quality',
      'rejected_incomplete',
      'rejected_status',
      'rejected_artifact',
      'rejected_auth'
    )
  );
