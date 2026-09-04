export interface TeslaAvSyncPolicy {
  minVideoFrames: number;
  minAudioFrames: number;
  maxAudioLeadSec: number;
  audioStartSafetySec: number;
  audioScheduleResetSec: number;
  audioPtsContinuitySec: number;
  avDriftHoldSec: number;
  avDriftResetSec: number;
  avDriftConfirmMs: number;
  videoStarvationMs: number;
  audioStarvationMs: number;
  stallRecoveryMs: number;
}

export function getTeslaAvSyncPolicy(
  live: boolean,
  playbackRate = 1,
  canvasSized = true
): TeslaAvSyncPolicy {
  if (live) {
    return {
      minVideoFrames: 5,
      minAudioFrames: 10,
      // Keep less than half a second of cancellable audio. The previous 250ms
      // horizon was routinely exhausted by Tesla browser chrome/layout work,
      // while this remains far below a multi-second live network buffer.
      maxAudioLeadSec: 0.45,
      audioStartSafetySec: 0.02,
      // Do not tear down every future WebAudio node for ordinary TS/PES jitter.
      // Real programme discontinuities remain caught by the decoder epoch and
      // the 300ms common-clock guard below.
      audioScheduleResetSec: 0.28,
      audioPtsContinuitySec: 0.08,
      avDriftHoldSec: 0.12,
      avDriftResetSec: 0.3,
      avDriftConfirmMs: 80,
      videoStarvationMs: 950,
      audioStarvationMs: 1150,
      stallRecoveryMs: 9000,
    };
  }

  return {
    minVideoFrames: canvasSized ? 10 : 6,
    minAudioFrames: canvasSized ? 20 : 12,
    // Tesla can block main-thread timers for about a second while browser chrome
    // or layout changes. Keep one cancellable WebAudio queue long enough to
    // outlast that pause while the existing drift guard remains authoritative.
    maxAudioLeadSec: playbackRate === 1 ? 1.45 : 0.6,
    audioStartSafetySec: 0.02,
    audioScheduleResetSec: 0.3,
    audioPtsContinuitySec: 0.12,
    avDriftHoldSec: 0.12,
    avDriftResetSec: 0.32,
    // Audio is the master clock. Give the video decoder enough time to output
    // and let presentVideo drop expired frames instead of stopping audible
    // audio for a short Tesla main-thread/decode wobble.
    avDriftConfirmMs: 650,
    videoStarvationMs: 700,
    audioStarvationMs: 950,
    stallRecoveryMs: 12000,
  };
}

export function hasFutureVideoFrame(
  nextVideoPtsSec: number | null | undefined,
  mediaClockSec: number,
  maxLookAheadSec = 2
): boolean {
  if (!Number.isFinite(nextVideoPtsSec) || !Number.isFinite(mediaClockSec))
    return false;
  const lead = Number(nextVideoPtsSec) - mediaClockSec;
  return lead > 0 && lead <= maxLookAheadSec;
}

export function hasScheduledAudioCoverage(
  nextAudioStartTimeSec: number,
  audioContextTimeSec: number,
  safetySec = 0.02
): boolean {
  if (
    !Number.isFinite(nextAudioStartTimeSec) ||
    !Number.isFinite(audioContextTimeSec)
  )
    return false;
  return nextAudioStartTimeSec - audioContextTimeSec > Math.max(0, safetySec);
}

export function shouldContinueAudioPts(
  pesPtsSec: number,
  nextAudioPtsSec: number | null,
  live: boolean
): boolean {
  if (nextAudioPtsSec === null) return false;
  if (!Number.isFinite(pesPtsSec) || !Number.isFinite(nextAudioPtsSec))
    return false;
  return (
    Math.abs(pesPtsSec - nextAudioPtsSec) <=
    getTeslaAvSyncPolicy(live).audioPtsContinuitySec
  );
}

export type AvDriftAction = 'none' | 'hold-audio' | 'reset-clock';

export function getAvDriftAction(
  videoPtsSec: number,
  mediaClockSec: number,
  live: boolean
): AvDriftAction {
  if (!Number.isFinite(videoPtsSec) || !Number.isFinite(mediaClockSec))
    return 'reset-clock';
  const audioLeadSec = mediaClockSec - videoPtsSec;
  const policy = getTeslaAvSyncPolicy(live);
  if (audioLeadSec >= policy.avDriftResetSec) return 'reset-clock';
  if (audioLeadSec >= policy.avDriftHoldSec) return 'hold-audio';
  return 'none';
}

export function shouldResetAudioSchedule(
  driftSec: number,
  live: boolean
): boolean {
  if (!Number.isFinite(driftSec)) return true;
  return Math.abs(driftSec) >= getTeslaAvSyncPolicy(live).audioScheduleResetSec;
}

export function shouldRebaseLiveFragmentPts(
  normalizedPtsSec: number,
  fragmentStartSec: number,
  fragmentDurationSec: number,
  toleranceSec = 2
): boolean {
  if (
    !Number.isFinite(normalizedPtsSec) ||
    !Number.isFinite(fragmentStartSec) ||
    !Number.isFinite(fragmentDurationSec)
  )
    return false;
  const tolerance = Math.max(0.25, toleranceSec);
  return (
    normalizedPtsSec < fragmentStartSec - tolerance ||
    normalizedPtsSec >
      fragmentStartSec + Math.max(0, fragmentDurationSec) + tolerance
  );
}

export function chooseCommonAvStart(
  requestedStart: number,
  firstVideoSec: number,
  firstAudioSec: number
): number {
  return Math.max(
    Number.isFinite(requestedStart) ? requestedStart : 0,
    Number.isFinite(firstVideoSec) ? firstVideoSec : 0,
    Number.isFinite(firstAudioSec) ? firstAudioSec : 0
  );
}
