export type TeslaDanmakuTimelineInput = {
  /** Content time after only verified, source-specific ad removals. */
  contentTime: number;
  /** Presentation timestamp of the Canvas frame actually on screen. */
  mediaTime?: number;
  /** Media PTS minus content time. */
  timelineOffsetSec?: number;
};

export type TeslaDanmakuTimeline = {
  time: number;
  aligned: boolean;
};

/**
 * A visual overlay must follow the presented video frame, not a decoder or
 * audio clock.  We still reject a stale/corrupt presentation value instead of
 * letting it move danmaku by seconds.  This helper never controls playback.
 */
export function resolveTeslaDanmakuTimeline({
  contentTime,
  mediaTime,
  timelineOffsetSec,
}: TeslaDanmakuTimelineInput): TeslaDanmakuTimeline {
  const fallback = Number.isFinite(contentTime) ? Math.max(0, contentTime) : 0;
  if (!Number.isFinite(mediaTime) || !Number.isFinite(timelineOffsetSec)) {
    return { time: fallback, aligned: false };
  }

  const renderedContentTime = Math.max(0, mediaTime! - timelineOffsetSec!);
  // The state clock and the actually painted-frame clock normally differ by a
  // fraction of a second.  Beyond this boundary the input is stale; retaining
  // the content clock is safer than showing a visibly wrong comment.
  if (Math.abs(renderedContentTime - fallback) > 0.75) {
    return { time: fallback, aligned: false };
  }
  return { time: renderedContentTime, aligned: true };
}
