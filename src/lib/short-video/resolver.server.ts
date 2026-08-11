import 'server-only';

import {
  SHORT_VIDEO_RESOLVER_CONTRACT_VERSION,
  type ShortVideoMedia,
  type ShortVideoResolveRequest,
  type ShortVideoResolveResponse,
  type ShortVideoResolverStatus,
} from './types';

const DEFAULT_TIMEOUT_MS = 12_000;
const MIN_TIMEOUT_MS = 3_000;
const MAX_TIMEOUT_MS = 30_000;
const MAX_SOURCE_URL_LENGTH = 2_048;
const MAX_TEXT_LENGTH = 500;
const MAX_MEDIA_VARIANTS = 8;

const ALLOWED_DOUYIN_HOSTS = new Set([
  'douyin.com',
  'www.douyin.com',
  'v.douyin.com',
  'iesdouyin.com',
  'www.iesdouyin.com',
  'v.iesdouyin.com',
]);

export class ShortVideoResolverError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code: string
  ) {
    super(message);
    this.name = 'ShortVideoResolverError';
  }
}

function readTimeoutMs(): number {
  const parsed = Number(process.env.SHORT_VIDEO_RESOLVER_TIMEOUT_MS);
  if (!Number.isFinite(parsed)) return DEFAULT_TIMEOUT_MS;
  return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Math.floor(parsed)));
}

function readResolverConfig() {
  const rawBaseUrl = process.env.SHORT_VIDEO_RESOLVER_BASE_URL?.trim() || '';
  const token = process.env.SHORT_VIDEO_RESOLVER_TOKEN?.trim() || '';

  if (!rawBaseUrl || !token) {
    return { configured: false as const };
  }

  let baseUrl: URL;
  try {
    baseUrl = new URL(rawBaseUrl.endsWith('/') ? rawBaseUrl : `${rawBaseUrl}/`);
  } catch {
    return { configured: false as const };
  }

  const isLocalDevelopment =
    baseUrl.protocol === 'http:' &&
    (baseUrl.hostname === 'localhost' || baseUrl.hostname === '127.0.0.1');
  if (baseUrl.protocol !== 'https:' && !isLocalDevelopment) {
    return { configured: false as const };
  }

  if (baseUrl.username || baseUrl.password) {
    return { configured: false as const };
  }

  return {
    configured: true as const,
    endpoint: new URL('v1/resolve', baseUrl),
    token,
    timeoutMs: readTimeoutMs(),
  };
}

export function getShortVideoResolverStatus(): ShortVideoResolverStatus {
  return {
    configured: readResolverConfig().configured,
    contractVersion: SHORT_VIDEO_RESOLVER_CONTRACT_VERSION,
    mode: 'external-resolver',
    player: 'tesla-webcodecs',
  };
}

export function normalizeDouyinSourceUrl(rawUrl: unknown): string {
  if (typeof rawUrl !== 'string') {
    throw new ShortVideoResolverError('请输入抖音公开分享链接', 400, 'INVALID_URL');
  }

  const value = rawUrl.trim();
  if (!value || value.length > MAX_SOURCE_URL_LENGTH) {
    throw new ShortVideoResolverError('抖音链接无效', 400, 'INVALID_URL');
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ShortVideoResolverError('抖音链接格式不正确', 400, 'INVALID_URL');
  }

  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.port ||
    !ALLOWED_DOUYIN_HOSTS.has(url.hostname.toLowerCase())
  ) {
    throw new ShortVideoResolverError(
      '仅支持抖音官方 HTTPS 分享链接',
      400,
      'UNSUPPORTED_SOURCE'
    );
  }

  url.hash = '';
  return url.toString();
}

function readRequiredText(
  record: Record<string, unknown>,
  key: string,
  fallback = ''
): string {
  const value = record[key];
  if (typeof value !== 'string') return fallback;
  return value.trim().slice(0, MAX_TEXT_LENGTH);
}

function readOptionalPositiveNumber(
  record: Record<string, unknown>,
  key: string
): number | undefined {
  const value = Number(record[key]);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

function sanitizeHttpsUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > MAX_SOURCE_URL_LENGTH) {
    return undefined;
  }

  try {
    const url = new URL(value);
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.port
    ) {
      return undefined;
    }
    return url.toString();
  } catch {
    return undefined;
  }
}

function sanitizeMedia(value: unknown): ShortVideoMedia | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const url = sanitizeHttpsUrl(record.url);
  const container =
    record.container === 'hls' || record.container === 'mp4'
      ? record.container
      : null;

  if (
    !url ||
    !container ||
    record.videoCodec !== 'h264' ||
    record.audioCodec !== 'aac'
  ) {
    return null;
  }

  const media: ShortVideoMedia = {
    url,
    container,
    videoCodec: 'h264',
    audioCodec: 'aac',
  };

  const width = readOptionalPositiveNumber(record, 'width');
  const height = readOptionalPositiveNumber(record, 'height');
  const bitrate = readOptionalPositiveNumber(record, 'bitrate');
  const expiresAt = readRequiredText(record, 'expiresAt');

  if (width) media.width = Math.floor(width);
  if (height) media.height = Math.floor(height);
  if (bitrate) media.bitrate = Math.floor(bitrate);
  if (expiresAt && !Number.isNaN(Date.parse(expiresAt))) {
    media.expiresAt = new Date(expiresAt).toISOString();
  }

  return media;
}

function sanitizeResolverResponse(value: unknown): ShortVideoResolveResponse {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ShortVideoResolverError(
      '短视频解析服务返回了无效数据',
      502,
      'INVALID_UPSTREAM_RESPONSE'
    );
  }

  const record = value as Record<string, unknown>;
  const id = readRequiredText(record, 'id');
  const duration = readOptionalPositiveNumber(record, 'duration');
  const media = Array.isArray(record.media)
    ? record.media
        .slice(0, MAX_MEDIA_VARIANTS)
        .map(sanitizeMedia)
        .filter((item): item is ShortVideoMedia => item !== null)
    : [];

  if (
    record.version !== SHORT_VIDEO_RESOLVER_CONTRACT_VERSION ||
    record.provider !== 'douyin' ||
    !id ||
    !duration ||
    media.length === 0
  ) {
    throw new ShortVideoResolverError(
      '解析服务没有返回 Tesla 可播放的 H.264/AAC 视频',
      502,
      'NO_TESLA_MEDIA'
    );
  }

  const result: ShortVideoResolveResponse = {
    version: SHORT_VIDEO_RESOLVER_CONTRACT_VERSION,
    provider: 'douyin',
    id,
    title: readRequiredText(record, 'title', '抖音视频'),
    author: readRequiredText(record, 'author', '未知作者'),
    duration,
    media,
  };
  const cover = sanitizeHttpsUrl(record.cover);
  if (cover) result.cover = cover;

  return result;
}

export async function resolveShortVideo(
  rawUrl: unknown
): Promise<ShortVideoResolveResponse> {
  const config = readResolverConfig();
  if (!config.configured) {
    throw new ShortVideoResolverError(
      '短视频解析服务尚未配置，接口已预留，可在服务器就绪后启用',
      503,
      'RESOLVER_NOT_CONFIGURED'
    );
  }

  const requestBody: ShortVideoResolveRequest = {
    version: SHORT_VIDEO_RESOLVER_CONTRACT_VERSION,
    provider: 'douyin',
    url: normalizeDouyinSourceUrl(rawUrl),
    playback: {
      preferredContainers: ['hls', 'mp4'],
      preferredVideoCodec: 'h264',
      preferredAudioCodec: 'aac',
    },
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);

  try {
    const response = await fetch(config.endpoint, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${config.token}`,
        'Content-Type': 'application/json',
        'X-Resolver-Contract-Version':
          SHORT_VIDEO_RESOLVER_CONTRACT_VERSION,
      },
      body: JSON.stringify(requestBody),
      cache: 'no-store',
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new ShortVideoResolverError(
        response.status === 429
          ? '短视频解析请求过于频繁，请稍后再试'
          : '短视频解析服务暂时不可用',
        response.status === 429 ? 429 : 502,
        response.status === 429 ? 'RATE_LIMITED' : 'UPSTREAM_UNAVAILABLE'
      );
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new ShortVideoResolverError(
        '短视频解析服务返回了无效数据',
        502,
        'INVALID_UPSTREAM_RESPONSE'
      );
    }

    return sanitizeResolverResponse(payload);
  } catch (error) {
    if (error instanceof ShortVideoResolverError) throw error;
    if (error instanceof Error && error.name === 'AbortError') {
      throw new ShortVideoResolverError(
        '短视频解析超时，请稍后重试',
        504,
        'RESOLVER_TIMEOUT'
      );
    }
    throw new ShortVideoResolverError(
      '无法连接短视频解析服务',
      502,
      'RESOLVER_UNREACHABLE'
    );
  } finally {
    clearTimeout(timeout);
  }
}
