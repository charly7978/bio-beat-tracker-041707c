-- NEXUS BP columns on measurements (F3)
-- Idempotent: safe to re-run. All columns nullable to keep backwards compat.

alter table public.measurements
  add column if not exists nexus_sources jsonb,
  add column if not exists tau_ms double precision,
  add column if not exists sbp_p5 double precision,
  add column if not exists sbp_p95 double precision,
  add column if not exists dbp_p5 double precision,
  add column if not exists dbp_p95 double precision,
  add column if not exists coherence_level text,
  add column if not exists coherence_score double precision;

comment on column public.measurements.nexus_sources is 'Fuentes fusionadas en la estimación BP NEXUS (ej. PWA_WINDKESSEL, CROSS_SITE_PTT).';
comment on column public.measurements.tau_ms is 'Tránsito cara->dedo observado (ms) usado en la fusión NEXUS.';
comment on column public.measurements.sbp_p5 is 'Percentil 5 de la banda de incertidumbre SBP (mmHg).';
comment on column public.measurements.sbp_p95 is 'Percentil 95 de la banda de incertidumbre SBP (mmHg).';
comment on column public.measurements.dbp_p5 is 'Percentil 5 de la banda de incertidumbre DBP (mmHg).';
comment on column public.measurements.dbp_p95 is 'Percentil 95 de la banda de incertidumbre DBP (mmHg).';
comment on column public.measurements.coherence_level is 'Nivel de coherencia espectral del par cara/dedo (CONGRUENT/PARTIAL/DISCORDANT).';
comment on column public.measurements.coherence_score is 'Puntuación 0-100 de coherencia espectral del par cara/dedo.';