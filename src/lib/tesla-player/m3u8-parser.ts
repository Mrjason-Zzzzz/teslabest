/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * 精简版 HLS M3U8 解析器
 *
 * 支持：
 *   - Master Playlist（多码率 variant 选择，默认选第一个）
 *   - Media Playlist（VOD / EVENT / LIVE）
 *   - #EXTINF 时长解析
 *   - #EXT-X-BYTERANGE（基础支持）
 *   - #EXT-X-KEY（AES-128 URI / IV，由 engine 端用 WebCrypto 解密）
 *   - #EXT-X-MAP（初始化段，CMAF/fMP4，本次场景一般用不到）
 *   - 相对/绝对 URL 解析（基于 base URL）
 *
 * 不支持（范围外）：
 *   - #EXT-X-DISCONTINUITY 的多 codec 切换
 *   - LL-HLS、#EXT-X-PRELOAD-HINT
 */

export interface M3U8Segment {
  url: string;
  duration: number; // 秒
  byteRange?: { start: number; length: number };
  /** 该段开始时使用的加密 key（可能继承自前面的 #EXT-X-KEY） */
  key?: M3U8Key;
  /** 该段所属的初始化段（#EXT-X-MAP）URL，若有 */
  mapUri?: string;
  /** 段序号（在 playlist 中的位置，0-based） */
  sequence: number;
  /** 段在整段视频中的起始时间（秒），由 engine 累加 */
  startOffset: number;
  /** EXTINF 中携带的 title */
  title?: string;
}

export interface M3U8Key {
  method: 'AES-128' | 'NONE' | 'SAMPLE-AES' | string;
  uri?: string;
  iv?: Uint8Array;
  keyFormat?: string;
  keyFormatVersions?: string;
}

export interface M3U8Playlist {
  /** 是否为 master playlist */
  isMaster: boolean;
  /** master 时：所有 variant stream */
  variants: M3U8Variant[];
  /** media playlist 时：所有分片 */
  segments: M3U8Segment[];
  /** media playlist 时：媒体总时长（秒），LIVE 则为 Infinity */
  targetDuration: number;
  /** mediaSequence 起始值 */
  mediaSequence: number;
  /** playlist 是否结束（VOD/EVENT 含 #EXT-X-ENDLIST） */
  endList: boolean;
  /** playlist 类型：VOD / EVENT / LIVE */
  type: 'VOD' | 'EVENT' | 'LIVE';
  /** 加密 key（media playlist 顶层 #EXT-X-KEY，会被段继承） */
  currentKey?: M3U8Key;
  /** #EXT-X-MAP 初始化段 URI */
  currentMapUri?: string;
  /** 版本 */
  version?: number;
  /** allow cache（已废弃但有些流还带） */
  allowCache?: boolean;
}

export interface M3U8Variant {
  uri: string;
  bandwidth: number;
  resolution?: { width: number; height: number };
  codecs?: string;
  frameRate?: number;
  averageBandwidth?: number;
  name?: string;
}

function resolveUrl(base: string, relative: string): string {
  try {
    return new URL(relative, base).toString();
  } catch {
    // base 可能不是绝对 URL（极端情况）
    return relative;
  }
}

/**
 * 解析 #EXT-X-KEY 的 attributes 字符串
 * 形如 METHOD=AES-128,URI="https://...",IV=0x1234567890ABCDEF...
 */
function parseKeyAttributes(attr: string, baseUrl: string): M3U8Key | undefined {
  const result: M3U8Key = { method: 'NONE' };
  // 用正则拆分，但要注意 URI="..." 内可能有逗号
  const parts: string[] = [];
  let i = 0;
  let inQuote = false;
  let current = '';
  while (i < attr.length) {
    const ch = attr[i];
    if (ch === '"') {
      inQuote = !inQuote;
      current += ch;
    } else if (ch === ',' && !inQuote) {
      parts.push(current);
      current = '';
    } else {
      current += ch;
    }
    i++;
  }
  if (current) parts.push(current);

  for (const part of parts) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const key = part.slice(0, eq).trim().toUpperCase();
    const value = part.slice(eq + 1).trim().replace(/^"|"$/g, '');
    if (key === 'METHOD') {
      result.method = value;
    } else if (key === 'URI') {
      result.uri = resolveUrl(baseUrl, value);
    } else if (key === 'IV') {
      // 0x 开头的 16 进制串
      const hex = value.startsWith('0x') || value.startsWith('0X')
        ? value.slice(2)
        : value;
      if (hex.length === 32) {
        const iv = new Uint8Array(16);
        for (let j = 0; j < 16; j++) {
          iv[j] = parseInt(hex.substr(j * 2, 2), 16);
        }
        result.iv = iv;
      }
    } else if (key === 'KEYFORMAT') {
      result.keyFormat = value;
    } else if (key === 'KEYFORMATVERSIONS') {
      result.keyFormatVersions = value;
    }
  }
  return result;
}

function parseResolution(value: string): { width: number; height: number } | undefined {
  const m = value.match(/^(\d+)x(\d+)$/);
  if (!m) return undefined;
  return { width: parseInt(m[1], 10), height: parseInt(m[2], 10) };
}

/**
 * 解析 #EXT-X-STREAM-INF 的 attributes
 */
function parseStreamInfAttributes(attr: string): Partial<M3U8Variant> {
  const result: Partial<M3U8Variant> = {};
  // 简单按逗号拆，注意引号
  const parts: string[] = [];
  let i = 0;
  let inQuote = false;
  let current = '';
  while (i < attr.length) {
    const ch = attr[i];
    if (ch === '"') {
      inQuote = !inQuote;
      current += ch;
    } else if (ch === ',' && !inQuote) {
      parts.push(current);
      current = '';
    } else {
      current += ch;
    }
    i++;
  }
  if (current) parts.push(current);

  for (const part of parts) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const key = part.slice(0, eq).trim().toUpperCase();
    const value = part.slice(eq + 1).trim().replace(/^"|"$/g, '');
    if (key === 'BANDWIDTH') {
      result.bandwidth = parseInt(value, 10);
    } else if (key === 'AVERAGE-BANDWIDTH') {
      result.averageBandwidth = parseInt(value, 10);
    } else if (key === 'RESOLUTION') {
      result.resolution = parseResolution(value);
    } else if (key === 'CODECS') {
      result.codecs = value;
    } else if (key === 'FRAME-RATE') {
      result.frameRate = parseFloat(value);
    } else if (key === 'NAME') {
      result.name = value;
    }
  }
  return result;
}

/**
 * 解析 #EXT-X-BYTERANGE
 * 形如 length@offset
 */
function parseByteRange(value: string, prevEnd: number): { start: number; length: number } | undefined {
  const parts = value.split('@');
  const length = parseInt(parts[0], 10);
  if (Number.isNaN(length)) return undefined;
  const start = parts[1] != null ? parseInt(parts[1], 10) : prevEnd;
  return { start, length };
}

/**
 * 解析 M3U8 文本
 * @param text M3U8 文本内容
 * @param baseUrl 用于解析相对 URL 的基础 URL
 */
export function parseM3U8(text: string, baseUrl: string): M3U8Playlist {
  const lines = text.split(/\r?\n/);
  // 第一行必须是 #EXTM3U
  if (!lines.length || !lines[0].startsWith('#EXTM3U')) {
    throw new Error('Invalid M3U8: missing #EXTM3U header');
  }

  let isMaster = false;
  let currentKey: M3U8Key | undefined;
  let currentMapUri: string | undefined;
  let mediaSequence = 0;
  let targetDuration = 0;
  let endList = false;
  let type: 'VOD' | 'EVENT' | 'LIVE' = 'LIVE';
  let version: number | undefined;
  let allowCache: boolean | undefined;

  const variants: M3U8Variant[] = [];
  const segments: M3U8Segment[] = [];

  let pendingInfDuration: number | null = null;
  let pendingInfTitle: string | undefined;
  let pendingByteRange: { start: number; length: number } | undefined;
  let lastByteRangeEnd = 0;
  let segmentStartOffset = 0;

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    if (line.startsWith('#EXT-X-VERSION')) {
      const v = line.split(':')[1];
      if (v) version = parseInt(v.trim(), 10);
      continue;
    }
    if (line.startsWith('#EXT-X-ALLOW-CACHE')) {
      allowCache = line.split(':')[1]?.trim() === 'YES';
      continue;
    }
    if (line.startsWith('#EXT-X-STREAM-INF')) {
      isMaster = true;
      const attr = line.slice('#EXT-X-STREAM-INF:'.length);
      const partial = parseStreamInfAttributes(attr);
      // 下一行非空行就是 URL
      let j = i + 1;
      while (j < lines.length && !lines[j].trim()) j++;
      const uri = lines[j]?.trim();
      if (uri && !uri.startsWith('#')) {
        variants.push({
          uri: resolveUrl(baseUrl, uri),
          bandwidth: partial.bandwidth || 0,
          resolution: partial.resolution,
          codecs: partial.codecs,
          frameRate: partial.frameRate,
          averageBandwidth: partial.averageBandwidth,
          name: partial.name,
        });
        i = j;
      }
      continue;
    }
    if (line.startsWith('#EXT-X-MEDIA')) {
      // #EXT-X-MEDIA:TYPE=AUDIO,... 我们只关心视频，跳过
      continue;
    }
    if (line.startsWith('#EXTINF')) {
      const body = line.slice('#EXTINF:'.length);
      const comma = body.indexOf(',');
      if (comma >= 0) {
        pendingInfDuration = parseFloat(body.slice(0, comma));
        pendingInfTitle = body.slice(comma + 1).trim() || undefined;
      } else {
        pendingInfDuration = parseFloat(body);
        pendingInfTitle = undefined;
      }
      continue;
    }
    if (line.startsWith('#EXT-X-BYTERANGE')) {
      const body = line.slice('#EXT-X-BYTERANGE:'.length).trim();
      pendingByteRange = parseByteRange(body, lastByteRangeEnd);
      continue;
    }
    if (line.startsWith('#EXT-X-KEY')) {
      const attr = line.slice('#EXT-X-KEY:'.length);
      currentKey = parseKeyAttributes(attr, baseUrl);
      continue;
    }
    if (line.startsWith('#EXT-X-MAP')) {
      const attr = line.slice('#EXT-X-MAP:'.length);
      // 仅取 URI=...
      const m = attr.match(/URI="([^"]+)"/i);
      if (m) currentMapUri = resolveUrl(baseUrl, m[1]);
      continue;
    }
    if (line.startsWith('#EXT-X-TARGETDURATION')) {
      targetDuration = parseInt(line.split(':')[1], 10);
      continue;
    }
    if (line.startsWith('#EXT-X-MEDIA-SEQUENCE')) {
      mediaSequence = parseInt(line.split(':')[1], 10);
      continue;
    }
    if (line.startsWith('#EXT-X-PLAYLIST-TYPE')) {
      const v = line.split(':')[1]?.trim().toUpperCase();
      if (v === 'VOD' || v === 'EVENT') type = v;
      continue;
    }
    if (line === '#EXT-X-ENDLIST') {
      endList = true;
      continue;
    }
    if (line.startsWith('#EXT-X-DISCONTINUITY')) {
      // 标记不连续，不处理细节
      lastByteRangeEnd = 0;
      continue;
    }
    if (line.startsWith('#EXT-X-PROGRAM-DATE-TIME')) {
      // 忽略，不影响播放
      continue;
    }
    if (line.startsWith('#EXT-X-INDEPENDENT-SEGMENTS')) {
      continue;
    }
    if (line.startsWith('#EXT-X-I-FRAMES-ONLY')) {
      // I-Frame only playlist，本次不支持
      continue;
    }
    if (line.startsWith('#')) {
      // 其他未知 tag 忽略
      continue;
    }

    // 普通 URL 行
    const url = resolveUrl(baseUrl, line);
    if (pendingInfDuration != null) {
      const seg: M3U8Segment = {
        url,
        duration: pendingInfDuration,
        sequence: segments.length + mediaSequence,
        startOffset: segmentStartOffset,
        title: pendingInfTitle,
        key: currentKey,
        mapUri: currentMapUri,
      };
      if (pendingByteRange) {
        seg.byteRange = pendingByteRange;
        lastByteRangeEnd = pendingByteRange.start + pendingByteRange.length;
      } else {
        lastByteRangeEnd = 0;
      }
      segments.push(seg);
      segmentStartOffset += pendingInfDuration;
      pendingInfDuration = null;
      pendingInfTitle = undefined;
      pendingByteRange = undefined;
    }
  }

  if (!endList && type === 'LIVE') {
    // LIVE playlist
  }

  return {
    isMaster,
    variants,
    segments,
    targetDuration,
    mediaSequence,
    endList,
    type,
    currentKey,
    currentMapUri,
    version,
    allowCache,
  };
}

/**
 * 简单选择一个 variant：优先 720p 以下、带宽适中的
 */
export function pickVariant(variants: M3U8Variant[]): M3U8Variant | null {
  if (!variants.length) return null;
  // 优先选分辨率 <= 720p 的最高带宽
  const sdOrBelow = variants.filter(
    (v) => !v.resolution || v.resolution.height <= 720
  );
  const pool = sdOrBelow.length > 0 ? sdOrBelow : variants;
  pool.sort((a, b) => (b.bandwidth || 0) - (a.bandwidth || 0));
  return pool[0];
}
