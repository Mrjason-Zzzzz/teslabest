import { selectContiguousAudioBatch } from './audio-batch';

describe('Tesla decoded audio batching', () => {
  const frame = (index: number, timestampOffsetSec = 0) => ({
    timestamp: Math.round((index * (1024 / 48000) + timestampOffsetSec) * 1e6),
    sampleRate: 48000,
    numberOfChannels: 2,
    numberOfFrames: 1024,
  });

  test('groups contiguous AAC frames without changing their duration', () => {
    const selection = selectContiguousAudioBatch(
      Array.from({ length: 12 }, (_, index) => frame(index)),
      0.2
    );
    expect(selection.count).toBe(9);
    expect(selection.totalFrames).toBe(9 * 1024);
    expect(selection.durationSec).toBeCloseTo(0.192, 3);
  });

  test('stops before a timestamp discontinuity or format change', () => {
    expect(
      selectContiguousAudioBatch([frame(0), frame(1), frame(2, 0.2)]).count
    ).toBe(2);
    expect(
      selectContiguousAudioBatch([frame(0), { ...frame(1), sampleRate: 44100 }])
        .count
    ).toBe(1);
  });
});
