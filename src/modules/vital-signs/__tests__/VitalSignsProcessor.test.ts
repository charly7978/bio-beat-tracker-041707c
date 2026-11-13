import { describe, expect, it, vi, afterEach } from 'vitest';
import { VitalSignsProcessor } from '../VitalSignsProcessor';
import { DisplaySmoothing } from '../DisplaySmoothing';
import { SpO2Calculator } from '../SpO2Calculator';
import { BloodPressureProcessor } from '../BloodPressureProcessor';

describe('VitalSignsProcessor', () => {
  afterEach(() => vi.restoreAllMocks());
  it('passes the capture timestamp to SpO2 rather than the display clock', () => {
    const calculate = vi.spyOn(SpO2Calculator.prototype, 'calculate').mockReturnValue(0);
    const proc = new VitalSignsProcessor();
    proc.setRGBData({ redAC: 1, redDC: 100, greenAC: 1, greenDC: 80 });
    proc.processSignal(1, 80, 72, undefined, 0.005, { sqi: 80 }, 1,
      undefined, undefined, undefined, undefined, undefined, [], 12_345);
    expect(calculate).toHaveBeenCalledWith(expect.any(Object), expect.any(Number), 12_345);
  });
  it('se inicializa con valores correctos', () => {
    const proc = new VitalSignsProcessor();
    const result = proc.reset();
    expect(result).toBeDefined();
    expect(result!.heartRate.value).toBeNull();
    expect(result!.spo2.value).toBeNull();
  });

  it('display hold preserves accepted values without an EMA', () => {
    const hold = new DisplaySmoothing();
    expect(hold.updateSpO2Hold(97.25, true)).toBe(97.25);
    expect(hold.updateSpO2Hold(93.75, true)).toBe(93.75);
    expect(hold.updateBPHold(120.4, 76.6, true)).toEqual({ systolic: 120.4, diastolic: 76.6 });
    hold.reset();
    expect(hold.updateSpO2Hold(0, false)).toBe(0);
  });

  it('publishes accepted estimator changes at full precision without either EMA', () => {
    // Controlled estimator outputs isolate presentation from optical/model estimation.
    const spo2 = vi.spyOn(SpO2Calculator.prototype, 'calculate').mockReturnValue(97.25);
    const bp = vi.spyOn(BloodPressureProcessor.prototype, 'estimate').mockReturnValue({
      systolic: 120.4, diastolic: 76.6, map: 91.2, pulsePressure: 43.8,
      confidence: 'HIGH', featureQuality: 90,
    });
    const proc = new VitalSignsProcessor();
    proc.setRGBData({ redAC: 1, redDC: 100, greenAC: 1, greenDC: 80 });
    const input = () => proc.processSignal(1, 80, 72.375,
      { intervals: [830, 835, 829, 834], lastPeakTime: 1000, timestampNow: 1100 }, 0.005);
    expect(input().spo2.value).toBe(97.25);
    spo2.mockReturnValue(94.125);
    bp.mockReturnValue({ systolic: 127.8, diastolic: 78.25, map: 94.7, pulsePressure: 49.55,
      confidence: 'HIGH', featureQuality: 90 });
    const next = input();
    expect(next.spo2.value).toBe(94.125);
    expect(next.bloodPressure.value).toEqual({ systolic: 127.8, diastolic: 78.25 });
    expect(next.heartRate.value).toBe(72.375);
  });

  it('uses the timestamp-derived morphology sample rate for BP features', () => {
    const bp = vi.spyOn(BloodPressureProcessor.prototype, 'estimate').mockReturnValue({
      systolic: 0, diastolic: 0, map: 0, pulsePressure: 0,
      confidence: 'INSUFFICIENT', featureQuality: 0,
    });
    const proc = new VitalSignsProcessor();
    const rr = { intervals: [830, 835, 829, 834], lastPeakTime: 1000, timestampNow: 1100 };
    const morphology30Hz = Array.from({ length: 120 }, (_, i) => ({
      value: Math.sin((2 * Math.PI * 1.2 * i) / 30),
      timestampMs: 10_000 + (i * 1000) / 30,
    }));

    proc.processSignal(
      1, 80, 72, rr, 0.005, { sqi: 80 }, 1,
      undefined, undefined, undefined, undefined, undefined, morphology30Hz,
    );
    expect(bp).toHaveBeenCalled();
    expect(bp.mock.calls[0][2]).toBeCloseTo(30, 0);

    bp.mockClear();
    proc.resetMorphologyWindow();
    const morphology24Hz = Array.from({ length: 100 }, (_, i) => ({
      value: Math.sin((2 * Math.PI * 1.2 * i) / 24),
      timestampMs: 20_000 + (i * 1000) / 24,
    }));
    proc.processSignal(
      1, 80, 72, rr, 0.005, { sqi: 80 }, 1,
      undefined, undefined, undefined, undefined, undefined, morphology24Hz,
    );
    expect(bp).toHaveBeenCalled();
    expect(bp.mock.calls[0][2]).toBeCloseTo(24, 0);
  });

  it('retains the HR SQI acceptance boundary at 10', () => {
    const at = new VitalSignsProcessor().processSignal(1, 10, 72.375);
    const below = new VitalSignsProcessor().processSignal(1, 9.999, 72.375);
    expect(at.heartRate.value).toBe(72.375);
    expect(below.heartRate.value).toBeNull();
  });

  it('SpO2Calculator rechaza DC insuficiente', () => {
    const calc = new SpO2Calculator();
    const result = calc.calculate(
      { redAC: 0.5, redDC: 5, greenAC: 0.3, greenDC: 3 },
      0,
    );
    expect(result).toBe(0);
  });

  it('procesa señales válidas y actualiza el estado de las mediciones', () => {
    const proc = new VitalSignsProcessor();
    
    const result = proc.processSignal(
      150,
      75,
      72,
      { intervals: [833, 830, 835], lastPeakTime: Date.now() },
      0.0035,
      { sqi: 75 }
    );

    expect(result).toBeDefined();
    expect(result.signalQuality).toBe(75);
  });
});

