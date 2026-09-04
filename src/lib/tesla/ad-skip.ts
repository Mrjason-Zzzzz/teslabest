export interface TeslaAdSkipIdentity {
  sourceKey?: string;
  sourceName?: string;
  title?: string;
  episodeLabel?: string;
}

export interface TeslaAdSkipRange {
  startSec: number;
  endSec: number;
  reason: string;
}

function normalizeIdentity(value: string | undefined): string {
  return (value || '')
    .normalize('NFKC')
    .replace(/[\s\u3000·—_-]+/g, '')
    .toLowerCase();
}

/**
 * Verified baked-in ad ranges. These rules are deliberately bound to a full
 * programme/source/episode identity. A time-only rule must never be applied to
 * another episode because doing so would remove legitimate programme media.
 */
export function resolveVerifiedAdSkipRanges(
  identity: TeslaAdSkipIdentity
): TeslaAdSkipRange[] {
  const source = normalizeIdentity(
    `${identity.sourceKey || ''}${identity.sourceName || ''}`
  );
  const title = normalizeIdentity(identity.title);
  const episode = normalizeIdentity(identity.episodeLabel);

  if (
    source.includes('量子') &&
    title.includes('地球超新鲜') &&
    title.includes('第二季') &&
    episode.includes('20260711') &&
    episode.includes('上')
  ) {
    return [
      {
        startSec: 4 * 60 + 55,
        endSec: 5 * 60 + 20,
        reason: 'verified-baked-in-ad:地球超新鲜第二季-20260711上',
      },
    ];
  }

  return [];
}

export function findAdSkipTarget(
  mediaPtsSec: number,
  ranges: readonly TeslaAdSkipRange[]
): number | null {
  if (!Number.isFinite(mediaPtsSec)) return null;
  const range = ranges.find(
    (item) => mediaPtsSec >= item.startSec && mediaPtsSec < item.endSec
  );
  return range ? range.endSec : null;
}

/**
 * Converts the media-file PTS to a programme-content clock. Danmaku uses this
 * clock, so every verified skipped range is compensated without guessing a
 * fixed offset such as five seconds.
 */
export function toContentTimelineTime(
  mediaPtsSec: number,
  ranges: readonly TeslaAdSkipRange[]
): number {
  if (!Number.isFinite(mediaPtsSec)) return 0;
  let removedSec = 0;
  for (const range of ranges) {
    if (mediaPtsSec >= range.endSec) {
      removedSec += range.endSec - range.startSec;
    } else if (mediaPtsSec > range.startSec) {
      removedSec += mediaPtsSec - range.startSec;
    }
  }
  return Math.max(0, mediaPtsSec - removedSec);
}
