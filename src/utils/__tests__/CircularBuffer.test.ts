import { describe, expect, it } from 'vitest';
import { CircularBuffer } from '../CircularBuffer';

describe('CircularBuffer recent visible window', () => {
  it('returns only points at or after the cutoff, in chronological order', () => {
    const buffer = new CircularBuffer(8);
    for (const time of [100, 200, 300, 400, 500]) {
      buffer.push({ time, value: time / 100, isArrhythmia: false });
    }

    expect(buffer.getRecentPointsSince(300)).toEqual([
      { time: 300, value: 3, isArrhythmia: false },
      { time: 400, value: 4, isArrhythmia: false },
      { time: 500, value: 5, isArrhythmia: false },
    ]);
  });

  it('keeps chronological order after the ring buffer wraps', () => {
    const buffer = new CircularBuffer(4);
    for (const time of [100, 200, 300, 400, 500]) {
      buffer.push({ time, value: time / 100, isArrhythmia: false });
    }

    expect(buffer.getRecentPointsSince(250).map((point) => point.time)).toEqual([
      300, 400, 500,
    ]);
  });

  it('returns an empty array when no sample is inside the visible window', () => {
    const buffer = new CircularBuffer(4);
    buffer.push({ time: 100, value: 1, isArrhythmia: false });

    expect(buffer.getRecentPointsSince(101)).toEqual([]);
  });
});
