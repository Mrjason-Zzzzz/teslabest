type FragmentLike = {
  type?: string;
  cc?: number;
  sn?: number | string;
  start?: number;
};

type PartLike = {
  index?: number;
};

type StreamCursor = {
  cc: number | null;
  sn: number | null;
  part: number | null;
  start: number | null;
};

function finiteNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

/**
 * hls.js may deliver a fragment again after a network/media recovery. Feeding
 * that old payload into the append-only WebCodecs queues corrupts the custom
 * timeline, so admission is monotonic per media stream and duplicate-safe.
 */
export class HlsFragmentAdmissionGuard {
  private readonly seen = new Set<string>();
  private readonly order: string[] = [];
  private readonly cursors = new Map<string, StreamCursor>();

  duplicateDrops = 0;
  staleDrops = 0;

  reset() {
    this.seen.clear();
    this.order.length = 0;
    this.cursors.clear();
    this.duplicateDrops = 0;
    this.staleDrops = 0;
  }

  accept(frag: FragmentLike, part?: PartLike | null): boolean {
    const stream = String(frag?.type || 'main');
    const cc = finiteNumber(frag?.cc);
    const sn = finiteNumber(frag?.sn);
    const start = finiteNumber(frag?.start);
    const partIndex = finiteNumber(part?.index);
    const rawSn = frag?.sn == null ? 'unknown' : String(frag.sn);
    const key = `${stream}|${cc ?? 'x'}|${rawSn}|${partIndex ?? 'full'}|${
      start === null ? 'x' : Math.round(start * 1000)
    }`;

    if (this.seen.has(key)) {
      this.duplicateDrops++;
      return false;
    }

    const previous = this.cursors.get(stream);
    if (previous) {
      const continuityMovedBackward =
        cc !== null && previous.cc !== null && cc < previous.cc;
      const sameContinuity =
        cc === null || previous.cc === null || cc === previous.cc;
      const sequenceMovedBackward =
        sameContinuity &&
        sn !== null &&
        previous.sn !== null &&
        sn < previous.sn;
      const partMovedBackward =
        sameContinuity &&
        sn !== null &&
        previous.sn !== null &&
        sn === previous.sn &&
        partIndex !== null &&
        previous.part !== null &&
        partIndex < previous.part;
      const timelineMovedBackward =
        sameContinuity &&
        start !== null &&
        previous.start !== null &&
        start < previous.start - 0.05;

      if (
        continuityMovedBackward ||
        sequenceMovedBackward ||
        partMovedBackward ||
        timelineMovedBackward
      ) {
        this.staleDrops++;
        return false;
      }
    }

    this.seen.add(key);
    this.order.push(key);
    if (this.order.length > 256) {
      const oldest = this.order.shift();
      if (oldest) this.seen.delete(oldest);
    }

    const continuityAdvanced =
      previous && cc !== null && previous.cc !== null && cc > previous.cc;
    this.cursors.set(stream, {
      cc: cc ?? previous?.cc ?? null,
      sn: continuityAdvanced ? sn : sn ?? previous?.sn ?? null,
      part: continuityAdvanced
        ? partIndex
        : partIndex ?? previous?.part ?? null,
      start: continuityAdvanced ? start : start ?? previous?.start ?? null,
    });
    return true;
  }
}

export function getHlsRecoveryStartPosition(
  live: boolean,
  mediaTime: number,
  liveSyncPosition?: number | null
) {
  if (live) {
    return Number.isFinite(liveSyncPosition) ? Number(liveSyncPosition) : -1;
  }
  return Number.isFinite(mediaTime) ? Math.max(0, mediaTime) : 0;
}

export function resolveLiveHiddenMediaTarget(
  mediaClock: number,
  liveSyncPosition: number | null | undefined,
  windowStart: number | null | undefined,
  windowEnd: number | null | undefined
) {
  const clock = finiteNumber(mediaClock) ?? 0;
  const liveSync = finiteNumber(liveSyncPosition);
  const start = finiteNumber(windowStart);
  const end = finiteNumber(windowEnd);

  if (start !== null && end !== null && end >= start) {
    if (clock >= start && clock <= end) return clock;
    if (liveSync !== null && liveSync >= start && liveSync <= end)
      return liveSync;
    return Math.max(start, end - 0.1);
  }

  return liveSync ?? Math.max(0, clock);
}
