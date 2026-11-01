import { describe, it, expect } from 'vitest';
import {
  negotiateProximalCapture,
  releaseProximalStream,
  proximalConstraints,
  readProximalEnv,
  PROXIMAL_REASONS,
  type ProximalCaptureEnv,
} from '../dualCameraBridge';

/** Objeto MediaStream forjado por el test (gente de __tests__, no de producción). */
function streamFanged(tracksRef: { count: number }): MediaStream {
  return {
    getTracks: () => {
      tracksRef.count += 1;
      return [
        { stop: () => { tracksRef.count += 100; } },
      ] as unknown as MediaStreamTrack[];
    },
  } as unknown as MediaStream;
}

function envThat(resolves: 'ok' | 'denied' | 'missing' | 'crash'): { env: ProximalCaptureEnv; tracksRef: { count: number } } {
  const tracksRef = { count: 0 };
  const getUserMedia = async (): Promise<MediaStream> => {
    if (resolves === 'ok') return streamFanged(tracksRef);
    if (resolves === 'denied') throw Object.assign(new Error('denegado'), { name: 'NotAllowedError' });
    if (resolves === 'missing') throw Object.assign(new Error('no device'), { name: 'NotFoundError' });
    throw new Error('fallo genérico');
  };
  return { env: { getUserMedia }, tracksRef };
}

describe('dualCameraBridge — negociación del sitio proximal (L2 web)', () => {
  it('apertura feliz → L2 + stream + motivo PROXIMAL_ABIERTO y constraints correctos', async () => {
    const { env, tracksRef } = envThat('ok');
    const c = proximalConstraints();
    expect(c.audio).toBe(false);
    expect(((c.video as MediaTrackConstraints).facingMode as string)).toBe('user');

    const r = await negotiateProximalCapture(env);
    expect(r.level).toBe('L2');
    expect(r.proximalStream).not.toBeNull();
    expect(r.reason).toBe(PROXIMAL_REASONS.OPEN);
    expect(tracksRef.count).toBe(0); // aún sin liberar

    releaseProximalStream(r.proximalStream);
    expect(tracksRef.count).toBeGreaterThanOrEqual(100); // stop() invocado en tracks
  });

  it('permiso denegado → L0 sin stream y motivo explícito', async () => {
    const { env } = envThat('denied');
    const r = await negotiateProximalCapture(env);
    expect(r.level).toBe('L0');
    expect(r.proximalStream).toBeNull();
    expect(r.reason).toBe(PROXIMAL_REASONS.PERMISSION_DENIED);
  });

  it('frontal ausente (una sola cámara) → degradación elegante L0 con motivo', async () => {
    const { env } = envThat('missing');
    const r = await negotiateProximalCapture(env);
    expect(r.level).toBe('L0');
    expect(r.proximalStream).toBeNull();
    expect(r.reason).toBe(PROXIMAL_REASONS.DEVICE_MISSING);
  });

  it('API getUserMedia indisponible (contexto no seguro) → motivo técnico específico', async () => {
    const r = await negotiateProximalCapture({});
    expect(r.level).toBe('L0');
    expect(r.reason).toBe(PROXIMAL_REASONS.API_MISSING);
  });

  it('fallo genérico de apertura → APERTURA_FALLIDA sin stream', async () => {
    const { env } = envThat('crash');
    const r = await negotiateProximalCapture(env);
    expect(r.level).toBe('L0');
    expect(r.proximalStream).toBeNull();
    expect(r.reason).toBe(PROXIMAL_REASONS.OPEN_FAILED);
  });

  it('releaseProximalStream es tolerante a null', () => {
    expect(() => releaseProximalStream(null)).not.toThrow();
  });

  it('readProximalEnv devuelve foto segura del entorno', () => {
    const env = readProximalEnv();
    // En jsdom puede existir o no: el contrato es que NO lanza y es objeto.
    expect(env).toBeTypeOf('object');
  });
});
