const AD_URI_KEYWORDS = [
  'sponsor',
  '/ad/',
  '/ads/',
  'advert',
  'advertisement',
  '/adjump',
  'redtraffic',
  '博彩',
  '赌博',
  '赌场',
  '投注',
  '六合彩',
];

const GAMBLING_AD_URI_PATTERN =
  /(?:^|[/?&_.=-])(?:casino|gambling|betting|lottery|poker|slots?)(?:[/?&_.=-]|$)/i;

const UNSAFE_PLAYLIST_TAG =
  /^#EXT-X-(BYTERANGE|PART|PRELOAD-HINT|GAP|SKIP|RENDITION-REPORT)/i;

// A topology-only heuristic must stay deliberately conservative: a normal
// scene/outro may live in a different directory. The verified provider insert
// is a handful of 2-5 second fragments, so we only infer a *short* island and
// leave anything longer for explicit HLS ad markers or a reviewed mapping.
const MAX_INFERRED_AD_RUN_SECONDS = 45;
const MAX_INFERRED_AD_RUN_SEGMENTS = 15;

function isAdUri(uri: string): boolean {
  let normalized = uri.toLowerCase();
  // Tesla 代理链路会把真实分片地址包在 ?url= 中。最多解码三层，
  // 既能检查原始地址，又避免对异常百分号编码无限循环。
  for (let depth = 0; depth < 3; depth += 1) {
    try {
      const decoded = decodeURIComponent(normalized);
      if (decoded === normalized) break;
      normalized = decoded.toLowerCase();
    } catch {
      break;
    }
  }
  return (
    AD_URI_KEYWORDS.some((keyword) => normalized.includes(keyword)) ||
    GAMBLING_AD_URI_PATTERN.test(normalized)
  );
}

/**
 * Live playlists cannot have media-sequence entries removed safely. Detect
 * only explicit provider markers/URIs so the caller can fail closed and move
 * to an identity-equivalent backup instead of ever rendering the ad.
 */
export function detectExplicitLiveAdSignal(m3u8Content: string): string | null {
  if (!m3u8Content.includes('#EXTM3U')) return null;
  const lines = m3u8Content.replace(/\r\n/g, '\n').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (isCueOut(trimmed)) return 'cue-out';
    if (isAdDateRange(trimmed)) return 'ad-daterange';
    if (trimmed && !trimmed.startsWith('#') && isAdUri(trimmed)) {
      return 'ad-uri';
    }
  }
  return null;
}

export interface AdFilterOptions {
  /**
   * 由站长自定义规则识别出的完整媒体分片序号。核心过滤器仍会
   * 执行 VOD、加密和 LL-HLS 安全校验，不允许自定义逻辑绕过音画同步保护。
   */
  additionalAdSegmentIndexes?: ReadonlySet<number>;
  /** The caller is VOD-only even when a malformed provider omitted its
   * PLAYLIST-TYPE:VOD and ENDLIST markers. */
  assumeVod?: boolean;
}

function isCueIn(line: string): boolean {
  return /^#EXT-X-CUE-IN/i.test(line.trim());
}

function isCueOut(line: string): boolean {
  return /^#(?:EXT-X-CUE-OUT|EXT-OATCLS-SCTE35|EXT-X-SCTE35)/i.test(
    line.trim()
  );
}

function isAdDateRange(line: string): boolean {
  const trimmed = line.trim();
  if (!/^#EXT-X-DATERANGE:/i.test(trimmed)) return false;
  return /(?:CLASS|ID)="?[^"]*(?:ad|advert|commercial|interstitial)|SCTE35-OUT=/i.test(
    trimmed
  );
}

function isAdSignal(line: string): boolean {
  return isCueIn(line) || isCueOut(line) || isAdDateRange(line);
}

function readDuration(line: string): number | null {
  const cueDuration = line.match(/^#EXT-X-CUE-OUT(?::|=)([0-9.]+)/i);
  if (cueDuration) {
    const value = Number(cueDuration[1]);
    return Number.isFinite(value) && value > 0 ? value : null;
  }

  const dateRangeDuration = line.match(
    /(?:PLANNED-DURATION|DURATION)=([0-9.]+)/i
  );
  if (dateRangeDuration) {
    const value = Number(dateRangeDuration[1]);
    return Number.isFinite(value) && value > 0 ? value : null;
  }
  return null;
}

function readExtInfDuration(line: string): number {
  const match = line.match(/^#EXTINF:([0-9.]+)/i);
  const value = match ? Number(match[1]) : 0;
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function hasImplicitAesIv(lines: string[]): boolean {
  return lines.some((line) => {
    const trimmed = line.trim();
    if (!/^#EXT-X-KEY:/i.test(trimmed)) return false;
    const method = trimmed.match(/METHOD=([^,]+)/i)?.[1]?.toUpperCase();
    return Boolean(
      method && method !== 'NONE' && !/(?:^|[:,])IV=0X[0-9A-F]+/i.test(trimmed)
    );
  });
}

function materializeImplicitAesIvs(lines: string[]): string[] {
  const mediaSequenceLine = lines.find((line) =>
    /^#EXT-X-MEDIA-SEQUENCE:/i.test(line.trim())
  );
  const mediaSequence = Number(mediaSequenceLine?.split(':')[1] || 0);
  let segmentIndex = 0;
  let implicitKeyLine = '';
  const output: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (/^#EXT-X-KEY:/i.test(trimmed)) {
      const method = trimmed.match(/METHOD=([^,]+)/i)?.[1]?.toUpperCase();
      if (method && method !== 'NONE' && !/(?:^|[:,])IV=0X/i.test(trimmed)) {
        implicitKeyLine = line;
        continue;
      }
      implicitKeyLine = '';
      output.push(line);
      continue;
    }
    if (trimmed.startsWith('#EXTINF:')) {
      if (implicitKeyLine) {
        const sequence = BigInt(Math.max(0, mediaSequence + segmentIndex));
        const iv = sequence.toString(16).padStart(32, '0').toUpperCase();
        output.push(`${implicitKeyLine},IV=0x${iv}`);
      }
      segmentIndex += 1;
    }
    output.push(line);
  }
  return output;
}

function persistentLines(lines: string[]): string[] {
  return lines.filter((line) => {
    const trimmed = line.trim();
    if (!trimmed) return true;
    if (isAdSignal(trimmed)) return false;
    if (/^#EXT-X-(PROGRAM-DATE-TIME|DISCONTINUITY)$/i.test(trimmed)) {
      return false;
    }
    if (/^#EXT-X-(KEY|MAP|DEFINE):/i.test(trimmed)) return true;
    if (/^#EXTM3U$/i.test(trimmed)) return true;
    if (/^#EXT-X-INDEPENDENT-SEGMENTS$/i.test(trimmed)) return true;
    if (
      /^#EXT-X-(VERSION|TARGETDURATION|MEDIA-SEQUENCE|DISCONTINUITY-SEQUENCE|PLAYLIST-TYPE|START):/i.test(
        trimmed
      )
    ) {
      return true;
    }
    return trimmed.startsWith('##');
  });
}

function withoutAdSignals(lines: string[]): string[] {
  return lines.filter((line) => !isAdSignal(line));
}

interface MediaUriFamily {
  /** Empty for a playlist-relative URI. */
  host: string;
  /** The programme-specific directory, without the segment filename. */
  directory: string;
}

function mediaUriFamily(uri: string): MediaUriFamily {
  try {
    const parsed = new URL(uri, 'https://relative.invalid/');
    const directory = parsed.pathname.replace(/\/[^/]*$/, '/');
    return {
      // HLS providers frequently change from a relative path to an absolute
      // CDN URL on the other side of a discontinuity. Keep the relative side
      // origin-neutral so the identical programme directory can still be
      // compared without treating two different absolute CDNs as equivalent.
      host:
        parsed.hostname === 'relative.invalid'
          ? ''
          : parsed.hostname.toLowerCase(),
      directory: directory.toLowerCase(),
    };
  } catch {
    return {
      host: '',
      directory: uri
        .split('?')[0]
        .replace(/\/[^/]*$/, '/')
        .toLowerCase(),
    };
  }
}

function isSameProgrammeFamily(
  left: MediaUriFamily | undefined,
  right: MediaUriFamily | undefined
) {
  if (!left || !right || left.directory !== right.directory) return false;
  // Two absolute sources must retain the same host. Only a relative URI is
  // allowed to match an absolute URL, because its origin is supplied by the
  // playlist request itself rather than the text line.
  return !left.host || !right.host || left.host === right.host;
}

/**
 * Detect a short, discontinuity-bounded URI island which leaves the programme
 * CDN/path and then returns to the same programme family. This catches the
 * common provider-side mid-roll layout without guessing from duration alone.
 * Unmarked or same-path baked-in video remains untouched because its media
 * identity cannot be proven safely from a playlist.
 */
function inferDiscontinuityAdIslandIndexes(lines: string[]) {
  const segments: Array<{
    index: number;
    duration: number;
    family: MediaUriFamily;
    boundaryBefore: boolean;
  }> = [];
  let cursor = 0;
  let segmentIndex = 0;
  while (cursor < lines.length) {
    const extInfIndex = lines.findIndex(
      (line, index) => index >= cursor && line.trim().startsWith('#EXTINF:')
    );
    if (extInfIndex < 0) break;
    let uriIndex = extInfIndex + 1;
    while (
      uriIndex < lines.length &&
      (!lines[uriIndex].trim() || lines[uriIndex].trim().startsWith('#'))
    ) {
      uriIndex += 1;
    }
    if (uriIndex >= lines.length) break;
    segments.push({
      index: segmentIndex,
      duration: readExtInfDuration(lines[extInfIndex]),
      family: mediaUriFamily(lines[uriIndex].trim()),
      boundaryBefore: lines
        .slice(cursor, extInfIndex + 1)
        .some((line) => /^#EXT-X-DISCONTINUITY$/i.test(line.trim())),
    });
    cursor = uriIndex + 1;
    segmentIndex += 1;
  }

  const runs: Array<typeof segments> = [];
  for (const segment of segments) {
    if (segment.boundaryBefore || runs.length === 0) runs.push([]);
    runs[runs.length - 1].push(segment);
  }

  const familyOf = (run: typeof segments) => {
    const counts = new Map<string, { family: MediaUriFamily; count: number }>();
    for (const segment of run) {
      const key = `${segment.family.host}|${segment.family.directory}`;
      const current = counts.get(key);
      counts.set(key, {
        family: segment.family,
        count: (current?.count || 0) + 1,
      });
    }
    return Array.from(counts.values()).sort(
      (left, right) => right.count - left.count
    )[0]?.family;
  };
  const inferred = new Set<number>();
  const confirmedAdFamilyKeys = new Set<string>();
  for (let index = 1; index < runs.length - 1; index += 1) {
    const previousFamily = familyOf(runs[index - 1]);
    const currentFamily = familyOf(runs[index]);
    const nextFamily = familyOf(runs[index + 1]);
    const duration = runs[index].reduce(
      (total, segment) => total + segment.duration,
      0
    );
    if (
      previousFamily &&
      currentFamily &&
      isSameProgrammeFamily(previousFamily, nextFamily) &&
      !isSameProgrammeFamily(currentFamily, previousFamily) &&
      duration > 0 &&
      duration <= MAX_INFERRED_AD_RUN_SECONDS &&
      runs[index].length <= MAX_INFERRED_AD_RUN_SEGMENTS
    ) {
      for (const segment of runs[index]) inferred.add(segment.index);
      confirmedAdFamilyKeys.add(
        `${currentFamily.host}|${currentFamily.directory}`
      );
    }
  }

  // Providers sometimes repeat the same already-proven insertion at ENDLIST.
  // A tail run alone is not enough evidence to call it an ad: it could be a
  // legitimate separately-hosted outro. We only remove it if the same short
  // foreign directory was already proven as a discontinuity-bounded insertion
  // earlier in this *same* playlist. This keeps the decision topology-based,
  // rather than guessing from its time position or duration.
  if (confirmedAdFamilyKeys.size > 0) {
    for (const run of runs) {
      const family = familyOf(run);
      const duration = run.reduce(
        (total, segment) => total + segment.duration,
        0
      );
      if (
        family &&
        confirmedAdFamilyKeys.has(`${family.host}|${family.directory}`) &&
        duration > 0 &&
        duration <= MAX_INFERRED_AD_RUN_SECONDS &&
        run.length <= MAX_INFERRED_AD_RUN_SEGMENTS
      ) {
        for (const segment of run) inferred.add(segment.index);
      }
    }
  }
  return inferred;
}

/**
 * Removes only complete, explicit ad segments from a simple HLS media playlist.
 *
 * The filter deliberately returns the original playlist for byte-range, LL-HLS
 * and implicit-IV encrypted media. Removing a segment from those structures can
 * corrupt decryption or split the audio/video timeline. Every removed ad run is
 * followed by a discontinuity boundary so hls.js assigns the returning program
 * a fresh shared timeline without keeping the removed duration as a clock gap.
 */
export function filterAdsFromMediaPlaylist(
  m3u8Content: string,
  options: AdFilterOptions = {}
): string {
  if (!m3u8Content || !m3u8Content.includes('#EXTM3U')) {
    return m3u8Content || '';
  }
  if (!m3u8Content.includes('#EXTINF:')) return m3u8Content;

  const normalized = m3u8Content.replace(/\r\n/g, '\n');
  let lines = normalized.split('\n');

  // Rewriting media-sequence numbers in a sliding live window can make an
  // already-played segment appear new on the next reload. Keep live/event
  // playlists byte-for-byte intact; ad filtering here is for completed VOD.
  const isCompletedVod = lines.some((line) =>
    /^#EXT-X-(?:PLAYLIST-TYPE:VOD|ENDLIST)$/i.test(line.trim())
  );
  if (!isCompletedVod && options.assumeVod !== true) return m3u8Content;

  // These structures depend on original segment numbering or byte positions.
  // Preserving the source is safer than risking silent A/V corruption.
  if (lines.some((line) => UNSAFE_PLAYLIST_TAG.test(line.trim()))) {
    return m3u8Content;
  }
  // AES-128 without an explicit IV derives it from the original media sequence.
  // Before removing a complete ad segment, materialize that IV on every segment
  // so later programme segments keep decrypting with their original value.
  if (hasImplicitAesIv(lines)) lines = materializeImplicitAesIvs(lines);

  const topologyAdSegmentIndexes = inferDiscontinuityAdIslandIndexes(lines);

  const output: string[] = [];
  let cursor = 0;
  let adBreakActive = false;
  let remainingAdSeconds: number | null = null;
  let needsProgramBoundary = false;
  let removedSegments = 0;
  let segmentIndex = 0;

  while (cursor < lines.length) {
    const extInfIndex = lines.findIndex(
      (line, index) => index >= cursor && line.trim().startsWith('#EXTINF:')
    );
    if (extInfIndex < 0) {
      output.push(...withoutAdSignals(lines.slice(cursor)));
      break;
    }

    let uriIndex = extInfIndex + 1;
    while (
      uriIndex < lines.length &&
      (!lines[uriIndex].trim() || lines[uriIndex].trim().startsWith('#'))
    ) {
      uriIndex++;
    }
    if (uriIndex >= lines.length) return m3u8Content;

    const prefix = lines.slice(cursor, extInfIndex);
    const between = lines.slice(extInfIndex + 1, uriIndex);
    const markerLines = [...prefix, ...between];

    for (const line of markerLines) {
      if (isCueIn(line)) {
        adBreakActive = false;
        remainingAdSeconds = null;
      } else if (isCueOut(line)) {
        adBreakActive = true;
        remainingAdSeconds = readDuration(line);
      } else if (isAdDateRange(line)) {
        const duration = readDuration(line);
        if (duration !== null) {
          adBreakActive = true;
          remainingAdSeconds = duration;
        }
      }
    }

    const duration = readExtInfDuration(lines[extInfIndex]);
    const removeSegment =
      adBreakActive ||
      isAdUri(lines[uriIndex].trim()) ||
      topologyAdSegmentIndexes.has(segmentIndex) ||
      options.additionalAdSegmentIndexes?.has(segmentIndex) === true;

    if (removeSegment) {
      output.push(...persistentLines(prefix));
      output.push(...persistentLines(between));
      needsProgramBoundary = true;
      removedSegments++;

      if (remainingAdSeconds !== null) {
        remainingAdSeconds -= duration;
        if (remainingAdSeconds <= 0.001) {
          adBreakActive = false;
          remainingAdSeconds = null;
        }
      }
    } else {
      const cleanPrefix = withoutAdSignals(prefix);
      const cleanBetween = withoutAdSignals(between);
      output.push(...cleanPrefix);
      if (
        needsProgramBoundary &&
        ![...cleanPrefix, ...cleanBetween].some((line) =>
          /^#EXT-X-DISCONTINUITY$/i.test(line.trim())
        )
      ) {
        output.push('#EXT-X-DISCONTINUITY');
      }
      output.push(lines[extInfIndex], ...cleanBetween, lines[uriIndex]);
      needsProgramBoundary = false;
    }

    cursor = uriIndex + 1;
    segmentIndex += 1;
  }

  return removedSegments > 0 ? output.join('\n') : m3u8Content;
}
