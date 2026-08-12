import "server-only";

import {
  SHORT_VIDEO_RESOLVER_CONTRACT_VERSION,
  type ShortVideoFeedRequest,
  type ShortVideoFeedResponse,
  type ShortVideoMedia,
  type ShortVideoPlaybackPreference,
  type ShortVideoResolveRequest,
  type ShortVideoResolveResponse,
  type ShortVideoResolverStatus,
} from "./types";

const DEFAULT_TIMEOUT_MS = 12_000;
const MIN_TIMEOUT_MS = 3_000;
const MAX_TIMEOUT_MS = 30_000;
const MAX_SOURCE_URL_LENGTH = 2_048;
const MAX_MEDIA_URL_LENGTH = 8_192;
const MAX_TEXT_LENGTH = 500;
const MAX_CURSOR_LENGTH = 512;
const MAX_MEDIA_VARIANTS = 8;
const MAX_FEED_ITEMS = 12;

const ALLOWED_DOUYIN_HOSTS = new Set([
  "douyin.com",
  "www.douyin.com",
  "v.douyin.com",
  "iesdouyin.com",
  "www.iesdouyin.com",
  "v.iesdouyin.com",
]);

const TESLA_PLAYBACK_PREFERENCE: ShortVideoPlaybackPreference = {
  preferredContainers: ["hls"],
  preferredVideoCodec: "h264",
  preferredAudioCodec: "aac",
  preferredSegmentFormat: "mpegts",
};

export class ShortVideoResolverError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code: string
  ) {
    super(message);
    this.name = "ShortVideoResolverError";
  }
}

function readTimeoutMs(): number {
  const parsed = Number(process.env.SHORT_VIDEO_RESOLVER_TIMEOUT_MS);
  if (!Number.isFinite(parsed)) return DEFAULT_TIMEOUT_MS;
  return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Math.floor(parsed)));
}

function readResolverConfig() {
  const rawBaseUrl = process.env.SHORT_VIDEO_RESOLVER_BASE_URL?.trim() || "";
  const token = process.env.SHORT_VIDEO_RESOLVER_TOKEN?.trim() || "";

  if (!rawBaseUrl || !token) return { configured: false as const };

  let baseUrl: URL;
  try {
    baseUrl = new URL(rawBaseUrl.endsWith("/") ? rawBaseUrl : `${rawBaseUrl}/`);
  } catch {
    return { configured: false as const };
  }

  const isLocalDevelopment =
    baseUrl.protocol === "http:" &&
    (baseUrl.hostname === "localhost" || baseUrl.hostname === "127.0.0.1");
  if (baseUrl.protocol !== "https:" && !isLocalDevelopment) {
    return { configured: false as const };
  }
  if (baseUrl.username || baseUrl.password)
    return { configured: false as const };

  return {
    configured: true as const,
    resolveEndpoint: new URL("v1/resolve", baseUrl),
    feedEndpoint: new URL("v1/feed", baseUrl),
    token,
    timeoutMs: readTimeoutMs(),
  };
}

export function getShortVideoResolverStatus(): ShortVideoResolverStatus {
  return {
    configured: readResolverConfig().configured,
    contractVersion: SHORT_VIDEO_RESOLVER_CONTRACT_VERSION,
    mode: "external-resolver",
    player: "tesla-webcodecs",
    capabilities: {
      resolve: true,
      feed: true,
      output: "hls-ts-h264-aac",
    },
  };
}

export function normalizeDouyinSourceUrl(rawUrl: unknown): string {
  if (typeof rawUrl !== "string") {
    throw new ShortVideoResolverError(
      "请输入抖音公开分享链接",
      400,
      "INVALID_URL"
    );
  }

  const value = rawUrl.trim();
  if (!value || value.length > MAX_SOURCE_URL_LENGTH) {
    throw new ShortVideoResolverError("抖音链接无效", 400, "INVALID_URL");
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ShortVideoResolverError("抖音链接格式不正确", 400, "INVALID_URL");
  }

  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    !ALLOWED_DOUYIN_HOSTS.has(url.hostname.toLowerCase())
  ) {
    throw new ShortVideoResolverError(
      "仅支持抖音官方 HTTPS 分享链接",
      400,
      "UNSUPPORTED_SOURCE"
    );
  }

  url.hash = "";
  return url.toString();
}

function readText(
  record: Record<string, unknown>,
  key: string,
  fallback = "",
  maxLength = MAX_TEXT_LENGTH
): string {
  const value = record[key];
  if (typeof value !== "string") return fallback;
  return value.trim().slice(0, maxLength);
}

function readPositiveNumber(
  record: Record<string, unknown>,
  key: string
): number | undefined {
  const value = Number(record[key]);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

function sanitizeHttpsUrl(
  value: unknown,
  maxLength = MAX_MEDIA_URL_LENGTH
): string | undefined {
  if (typeof value !== "string" || value.length > maxLength) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.port) {
      return undefined;
    }
    return url.toString();
  } catch {
    return undefined;
  }
}

function sanitizeMedia(value: unknown): ShortVideoMedia | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const url = sanitizeHttpsUrl(record.url);
  const container =
    record.container === "hls" || record.container === "mp4"
      ? record.container
      : null;
  const segmentFormat =
    record.segmentFormat === "mpegts" || record.segmentFormat === "fmp4"
      ? record.segmentFormat
      : undefined;

  if (
    !url ||
    !container ||
    record.videoCodec !== "h264" ||
    record.audioCodec !== "aac"
  ) {
    return null;
  }

  const media: ShortVideoMedia = {
    url,
    container,
    videoCodec: "h264",
    audioCodec: "aac",
  };
  if (segmentFormat) media.segmentFormat = segmentFormat;

  const width = readPositiveNumber(record, "width");
  const height = readPositiveNumber(record, "height");
  const bitrate = readPositiveNumber(record, "bitrate");
  const expiresAt = readText(record, "expiresAt");
  if (width) media.width = Math.floor(width);
  if (height) media.height = Math.floor(height);
  if (bitrate) media.bitrate = Math.floor(bitrate);
  if (expiresAt && !Number.isNaN(Date.parse(expiresAt))) {
    media.expiresAt = new Date(expiresAt).toISOString();
  }
  return media;
}

function sanitizeResolverResponse(value: unknown): ShortVideoResolveResponse {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ShortVideoResolverError(
      "短视频解析服务返回了无效数据",
      502,
      "INVALID_UPSTREAM_RESPONSE"
    );
  }

  const record = value as Record<string, unknown>;
  const id = readText(record, "id");
  const duration = readPositiveNumber(record, "duration");
  const media = Array.isArray(record.media)
    ? record.media
        .slice(0, MAX_MEDIA_VARIANTS)
        .map(sanitizeMedia)
        .filter((item): item is ShortVideoMedia => item !== null)
    : [];

  if (
    record.version !== SHORT_VIDEO_RESOLVER_CONTRACT_VERSION ||
    record.provider !== "douyin" ||
    !id ||
    !duration ||
    media.length === 0
  ) {
    throw new ShortVideoResolverError(
      "解析服务没有返回 Tesla 可播放的 H.264/AAC 视频",
      502,
      "NO_TESLA_MEDIA"
    );
  }

  const result: ShortVideoResolveResponse = {
    version: SHORT_VIDEO_RESOLVER_CONTRACT_VERSION,
    provider: "douyin",
    id,
    title: readText(record, "title", "抖音视频"),
    author: readText(record, "author", "未知作者"),
    duration,
    media,
  };

  const description = readText(record, "description");
  const cover = sanitizeHttpsUrl(record.cover);
  const authorAvatar = sanitizeHttpsUrl(record.authorAvatar);
  const shareUrl = sanitizeHttpsUrl(record.shareUrl, MAX_SOURCE_URL_LENGTH);
  const likeCount = readPositiveNumber(record, "likeCount");
  const commentCount = readPositiveNumber(record, "commentCount");
  if (description) result.description = description;
  if (cover) result.cover = cover;
  if (authorAvatar) result.authorAvatar = authorAvatar;
  if (
    shareUrl &&
    ALLOWED_DOUYIN_HOSTS.has(new URL(shareUrl).hostname.toLowerCase())
  ) {
    result.shareUrl = shareUrl;
  }
  if (likeCount) result.likeCount = Math.floor(likeCount);
  if (commentCount) result.commentCount = Math.floor(commentCount);
  return result;
}

async function requestResolver(
  endpoint: URL,
  token: string,
  timeoutMs: number,
  body: unknown
) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "X-Resolver-Contract-Version": SHORT_VIDEO_RESOLVER_CONTRACT_VERSION,
      },
      body: JSON.stringify(body),
      cache: "no-store",
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new ShortVideoResolverError(
        response.status === 429
          ? "短视频解析请求过于频繁，请稍后再试"
          : "短视频解析服务暂时不可用",
        response.status === 429 ? 429 : 502,
        response.status === 429 ? "RATE_LIMITED" : "UPSTREAM_UNAVAILABLE"
      );
    }
    try {
      return (await response.json()) as unknown;
    } catch {
      throw new ShortVideoResolverError(
        "短视频解析服务返回了无效数据",
        502,
        "INVALID_UPSTREAM_RESPONSE"
      );
    }
  } catch (error) {
    if (error instanceof ShortVideoResolverError) throw error;
    if (error instanceof Error && error.name === "AbortError") {
      throw new ShortVideoResolverError(
        "短视频解析超时，请稍后重试",
        504,
        "RESOLVER_TIMEOUT"
      );
    }
    throw new ShortVideoResolverError(
      "无法连接短视频解析服务",
      502,
      "RESOLVER_UNREACHABLE"
    );
  } finally {
    clearTimeout(timeout);
  }
}

function requireResolverConfig() {
  const config = readResolverConfig();
  if (!config.configured) {
    throw new ShortVideoResolverError(
      "短视频解析服务尚未配置",
      503,
      "RESOLVER_NOT_CONFIGURED"
    );
  }
  return config;
}

export async function resolveShortVideo(
  rawUrl: unknown
): Promise<ShortVideoResolveResponse> {
  const config = requireResolverConfig();
  const requestBody: ShortVideoResolveRequest = {
    version: SHORT_VIDEO_RESOLVER_CONTRACT_VERSION,
    provider: "douyin",
    url: normalizeDouyinSourceUrl(rawUrl),
    playback: TESLA_PLAYBACK_PREFERENCE,
  };
  const payload = await requestResolver(
    config.resolveEndpoint,
    config.token,
    config.timeoutMs,
    requestBody
  );
  return sanitizeResolverResponse(payload);
}

export async function fetchShortVideoFeed(
  rawCursor: unknown,
  rawLimit: unknown
): Promise<ShortVideoFeedResponse> {
  const config = requireResolverConfig();
  const cursor =
    typeof rawCursor === "string"
      ? rawCursor.trim().slice(0, MAX_CURSOR_LENGTH)
      : "";
  const parsedLimit = Number(rawLimit);
  const limit = Number.isFinite(parsedLimit)
    ? Math.min(MAX_FEED_ITEMS, Math.max(4, Math.floor(parsedLimit)))
    : 8;

  const requestBody: ShortVideoFeedRequest = {
    version: SHORT_VIDEO_RESOLVER_CONTRACT_VERSION,
    provider: "douyin",
    mode: "recommend",
    limit,
    playback: TESLA_PLAYBACK_PREFERENCE,
  };
  if (cursor) requestBody.cursor = cursor;

  const payload = await requestResolver(
    config.feedEndpoint,
    config.token,
    config.timeoutMs,
    requestBody
  );
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new ShortVideoResolverError(
      "短视频推荐流返回了无效数据",
      502,
      "INVALID_UPSTREAM_RESPONSE"
    );
  }

  const record = payload as Record<string, unknown>;
  if (
    record.version !== SHORT_VIDEO_RESOLVER_CONTRACT_VERSION ||
    record.provider !== "douyin" ||
    !Array.isArray(record.items)
  ) {
    throw new ShortVideoResolverError(
      "短视频推荐流版本不兼容",
      502,
      "INVALID_UPSTREAM_RESPONSE"
    );
  }

  const items = record.items
    .slice(0, MAX_FEED_ITEMS)
    .map((item) => {
      try {
        return sanitizeResolverResponse(item);
      } catch {
        return null;
      }
    })
    .filter((item): item is ShortVideoResolveResponse => item !== null)
    .map((item) => ({
      ...item,
      media: item.media.filter(
        (media) => media.container === "hls" && media.segmentFormat === "mpegts"
      ),
    }))
    .filter((item) => item.media.length > 0);

  if (items.length === 0) {
    throw new ShortVideoResolverError(
      "推荐流没有返回 Tesla 可播放的 HLS-TS 视频",
      502,
      "NO_TESLA_MEDIA"
    );
  }

  const nextCursor = readText(record, "nextCursor", "", MAX_CURSOR_LENGTH);
  const hasMore = record.hasMore === true && Boolean(nextCursor);
  return {
    version: SHORT_VIDEO_RESOLVER_CONTRACT_VERSION,
    provider: "douyin",
    items,
    ...(nextCursor ? { nextCursor } : {}),
    hasMore,
  };
}
