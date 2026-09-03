export type DecodedAudioFrameLike = {
  timestamp: number;
  sampleRate: number;
  numberOfChannels: number;
  numberOfFrames: number;
};

export type AudioBatchSelection = {
  count: number;
  totalFrames: number;
  durationSec: number;
};

/**
 * Select a short run of contiguous decoded AAC frames for one WebAudio node.
 * Samples are not stretched, resampled or reordered; batching only reduces the
 * tens of thousands of short-lived AudioBufferSourceNodes created in a long
 * Tesla session.
 */
export function selectContiguousAudioBatch(
  frames: readonly DecodedAudioFrameLike[],
  maxDurationSec = 0.2,
  timestampToleranceSec = 0.035
): AudioBatchSelection {
  const first = frames[0];
  if (
    !first ||
    first.sampleRate <= 0 ||
    first.numberOfFrames <= 0 ||
    first.numberOfChannels <= 0
  ) {
    return { count: 0, totalFrames: 0, durationSec: 0 };
  }

  const maxFrames = Math.max(
    first.numberOfFrames,
    Math.floor(first.sampleRate * Math.max(0.02, maxDurationSec))
  );
  let count = 0;
  let totalFrames = 0;
  let expectedTimestampSec = first.timestamp / 1e6;

  for (const frame of frames) {
    if (
      frame.sampleRate !== first.sampleRate ||
      frame.numberOfChannels !== first.numberOfChannels ||
      frame.numberOfFrames <= 0 ||
      totalFrames + frame.numberOfFrames > maxFrames
    ) {
      break;
    }
    const timestampSec = frame.timestamp / 1e6;
    if (
      count > 0 &&
      Math.abs(timestampSec - expectedTimestampSec) > timestampToleranceSec
    ) {
      break;
    }
    totalFrames += frame.numberOfFrames;
    count += 1;
    expectedTimestampSec =
      timestampSec + frame.numberOfFrames / frame.sampleRate;
  }

  return {
    count,
    totalFrames,
    durationSec: totalFrames / first.sampleRate,
  };
}
