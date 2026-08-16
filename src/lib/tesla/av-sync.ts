export interface TeslaAvSyncPolicy {
  minVideoFrames: number;
  minAudioFrames: number;
  maxAudioLeadSec: number;
  audioScheduleResetSec: number;
  audioPtsContinuitySec: number;
  avDriftHoldSec: number;
  avDriftResetSec: number;
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
      maxAudioLeadSec: 0.25,
      audioScheduleResetSec: 0.16,
      audioPtsContinuitySec: 0.08,
      avDriftHoldSec: 0.12,
      avDriftResetSec: 0.3,
      videoStarvationMs: 950,
      audioStarvationMs: 1150,
      stallRecoveryMs: 9000,
    };
  }

  return {
    minVideoFrames: canvasSized ? 10 : 6,
    minAudioFrames: canvasSized ? 20 : 12,
    maxAudioLeadSec: playbackRate === 1 ? 1.5 : 0.65,
    audioScheduleResetSec: 0.12,
    audioPtsContinuitySec: 0.12,
    avDriftHoldSec: 0.18,
    avDriftResetSec: 0.4,
    videoStarvationMs: 700,
    audioStarvationMs: 950,
    stallRecoveryMs: 12000,
  };
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
