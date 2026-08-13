export interface TeslaAvSyncPolicy {
  minVideoFrames: number;
  minAudioFrames: number;
  maxAudioLeadSec: number;
  audioScheduleResetSec: number;
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
      maxAudioLeadSec: 0.75,
      audioScheduleResetSec: 0.16,
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
    videoStarvationMs: 700,
    audioStarvationMs: 950,
    stallRecoveryMs: 12000,
  };
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
