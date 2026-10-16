-- Integridad referencial: `perf_snapshots.user_id` no tenía FK a auth.users
-- (la tabla original se creó sin ella). ON DELETE CASCADE evita huérfanos al
-- borrar cuentas. Idempotente vía pg_constraint. Falla con aviso claro si
-- existieran filas huérfanas previas (habría que depurarlas antes).

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'public.perf_snapshots'::regclass
      AND contype = 'f'
      AND conname = 'perf_snapshots_user_id_fkey'
  ) THEN
    ALTER TABLE public.perf_snapshots
      ADD CONSTRAINT perf_snapshots_user_id_fkey
      FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
  END IF;
END
$$;
