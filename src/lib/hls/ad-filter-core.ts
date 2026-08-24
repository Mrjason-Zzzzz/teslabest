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

export interface AdFilterOptions {
  /**
   * 由站长自定义规则识别出的完整媒体分片序号。核心过滤器仍会
   * 执行 VOD、加密和 LL-HLS 安全校验，不允许自定义逻辑绕过音画同步保护。
   */
  additionalAdSegmentIndexes?: ReadonlySet<number>;
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
  if (!isCompletedVod) return m3u8Content;

  // These structures depend on original segment numbering or byte positions.
  // Preserving the source is safer than risking silent A/V corruption.
  if (lines.some((line) => UNSAFE_PLAYLIST_TAG.test(line.trim()))) {
    return m3u8Content;
  }
  // AES-128 without an explicit IV derives it from the original media sequence.
  // Before removing a complete ad segment, materialize that IV on every segment
  // so later programme segments keep decrypting with their original value.
  if (hasImplicitAesIv(lines)) lines = materializeImplicitAesIvs(lines);

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
