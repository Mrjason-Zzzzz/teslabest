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
const MAX_UPSTREAM_BYTES = 5 * 1024 * 1024;

const DOUYIN_APP_USER_AGENT =
  "com.ss.android.ugc.aweme/170400 (Linux; U; Android 10; zh_CN; MI 9; Build/QKQ1.190825.002; Cronet/TTNetVersion)";
const DOUYIN_WEB_USER_AGENT =
  "Mozilla/5.0 (Linux; Android 10; MI 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36";
const DOUYIN_FEED_ENDPOINTS = [
  "https://api5-normal-c-lf.amemv.com/aweme/v1/feed/",
  "https://aweme.snssdk.com/aweme/v1/feed/",
] as const;

const ALLOWED_DOUYIN_HOSTS = new Set([
  "douyin.com",
  "www.douyin.com",
  "v.douyin.com",
  "iesdouyin.com",
  "www.iesdouyin.com",
  "v.iesdouyin.com",
]);

const TESLA_PLAYBACK_PREFERENCE: ShortVideoPlaybackPreference = {
  preferredContainers: ["mp4", "hls"],
  preferredVideoCodec: "h264",
  preferredAudioCodec: "aac",
  preferredSegmentFormat: "mpegts",
};

type JsonRecord = Record<string, unknown>;

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

function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
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
  const external = readResolverConfig().configured;
  return {
    configured: true,
    contractVersion: SHORT_VIDEO_RESOLVER_CONTRACT_VERSION,
    mode: external ? "external-resolver" : "vercel-direct",
    player: "tesla-webcodecs",
    capabilities: {
      resolve: true,
      feed: true,
      output: external ? "hls-ts-h264-aac" : "mp4-h264-aac",
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
  record: JsonRecord,
  key: string,
  fallback = "",
  maxLength = MAX_TEXT_LENGTH
): string {
  const value = record[key];
  if (typeof value !== "string") return fallback;
  return value.trim().slice(0, maxLength);
}

function readPositiveNumber(
  record: JsonRecord,
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

function firstImageUrl(value: unknown): string | undefined {
  const record = asRecord(value);
  const urls = Array.isArray(record?.url_list) ? record.url_list : [];
  const safeUrls = urls
    .map((url) => sanitizeHttpsUrl(url))
    .filter(Boolean) as string[];
  return (
    safeUrls.find((url) => /\.(?:jpe?g|png|webp)(?:\?|$)/i.test(url)) ||
    safeUrls[0]
  );
}

function firstMediaUrl(value: unknown): string | undefined {
  const record = asRecord(value);
  const urls = Array.isArray(record?.url_list) ? record.url_list : [];
  const safeUrls = urls
    .map((url) => sanitizeHttpsUrl(url))
    .filter(Boolean) as string[];
  return (
    safeUrls.find((url) => {
      try {
        const host = new URL(url).hostname;
        return (
          host.includes("douyinvod.com") || host.includes("bytevcloud.com")
        );
      } catch {
        return false;
      }
    }) || safeUrls[0]
  );
}

function mapDouyinItem(
  value: unknown,
  allowSharePagePlayAddress = false
): ShortVideoResolveResponse | null {
  const item = asRecord(value);
  if (!item) return null;
  const id = readText(item, "aweme_id", "", 64);
  const video = asRecord(item.video);
  const author = asRecord(item.author) || {};
  const statistics = asRecord(item.statistics) || {};
  const playback =
    asRecord(video?.play_addr_h264) ||
    (allowSharePagePlayAddress ? asRecord(video?.play_addr) : null);
  const mediaUrl = firstMediaUrl(playback);
  const durationMs = Number(item.duration ?? video?.duration);
  if (
    !id ||
    !video ||
    !playback ||
    !mediaUrl ||
    !Number.isFinite(durationMs) ||
    durationMs <= 0
  ) {
    return null;
  }

  const description = readText(item, "desc", "抖音视频");
  const duration = durationMs / 1000;
  const width =
    readPositiveNumber(playback, "width") || readPositiveNumber(video, "width");
  const height =
    readPositiveNumber(playback, "height") ||
    readPositiveNumber(video, "height");
  const dataSize = readPositiveNumber(playback, "data_size");
  const media: ShortVideoMedia = {
    url: mediaUrl,
    container: "mp4",
    videoCodec: "h264",
    audioCodec: "aac",
    ...(width ? { width: Math.floor(width) } : {}),
    ...(height ? { height: Math.floor(height) } : {}),
    ...(dataSize ? { bitrate: Math.round((dataSize * 8) / duration) } : {}),
  };

  const result: ShortVideoResolveResponse = {
    version: SHORT_VIDEO_RESOLVER_CONTRACT_VERSION,
    provider: "douyin",
    id,
    title: description,
    description,
    author: readText(author, "nickname", "抖音用户"),
    duration,
    media: [media],
    shareUrl: `https://www.douyin.com/video/${id}`,
  };
  const cover = firstImageUrl(video.cover) || firstImageUrl(video.origin_cover);
  const authorAvatar =
    firstImageUrl(author.avatar_thumb) || firstImageUrl(author.avatar_medium);
  const likeCount = readPositiveNumber(statistics, "digg_count");
  const commentCount = readPositiveNumber(statistics, "comment_count");
  if (cover) result.cover = cover;
  if (authorAvatar) result.authorAvatar = authorAvatar;
  if (likeCount) result.likeCount = Math.floor(likeCount);
  if (commentCount) result.commentCount = Math.floor(commentCount);
  return result;
}

function sanitizeMedia(value: unknown): ShortVideoMedia | null {
  const record = asRecord(value);
  if (!record) return null;
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
  if (container === "hls" && segmentFormat !== "mpegts") return null;

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
  const record = asRecord(value);
  if (!record) {
    throw new ShortVideoResolverError(
      "短视频解析服务返回了无效数据",
      502,
      "INVALID_UPSTREAM_RESPONSE"
    );
  }
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
  )
    result.shareUrl = shareUrl;
  if (likeCount) result.likeCount = Math.floor(likeCount);
  if (commentCount) result.commentCount = Math.floor(commentCount);
  return result;
}

async function readLimitedText(response: Response): Promise<string> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_UPSTREAM_BYTES) {
    throw new ShortVideoResolverError(
      "抖音返回内容过大",
      502,
      "UPSTREAM_RESPONSE_TOO_LARGE"
    );
  }
  const text = await response.text();
  if (text.length > MAX_UPSTREAM_BYTES) {
    throw new ShortVideoResolverError(
      "抖音返回内容过大",
      502,
      "UPSTREAM_RESPONSE_TOO_LARGE"
    );
  }
  return text;
}

async function fetchWithTimeout(
  url: URL | string,
  init: RequestInit
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), readTimeoutMs());
  try {
    return await fetch(url, {
      ...init,
      cache: "no-store",
      signal: controller.signal,
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new ShortVideoResolverError(
        "短视频请求超时，请稍后重试",
        504,
        "RESOLVER_TIMEOUT"
      );
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
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
    return (await response.json()) as unknown;
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

function encodeCursor(refreshIndex: number, viewCount: number): string {
  return Buffer.from(
    JSON.stringify({ version: 1, refreshIndex, viewCount }),
    "utf8"
  ).toString("base64url");
}

function decodeCursor(value: unknown): {
  refreshIndex: number;
  viewCount: number;
} {
  if (typeof value !== "string" || !value || value.length > MAX_CURSOR_LENGTH) {
    return { refreshIndex: 1, viewCount: 0 };
  }
  try {
    const parsed = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8")
    ) as JsonRecord;
    const refreshIndex = Math.min(
      10_000,
      Math.max(1, Math.floor(Number(parsed.refreshIndex) || 1))
    );
    const viewCount = Math.min(
      100_000,
      Math.max(0, Math.floor(Number(parsed.viewCount) || 0))
    );
    return { refreshIndex, viewCount };
  } catch {
    return { refreshIndex: 1, viewCount: 0 };
  }
}

async function fetchDirectDouyinFeed(
  rawCursor: unknown,
  rawLimit: unknown
): Promise<ShortVideoFeedResponse> {
  const cursor = decodeCursor(rawCursor);
  const parsedLimit = Number(rawLimit);
  const limit = Number.isFinite(parsedLimit)
    ? Math.min(MAX_FEED_ITEMS, Math.max(4, Math.floor(parsedLimit)))
    : 8;
  let lastError: unknown;

  for (const endpoint of DOUYIN_FEED_ENDPOINTS) {
    try {
      const url = new URL(endpoint);
      const params: Record<string, string> = {
        count: String(Math.max(10, limit)),
        feed_style: "1",
        filter_warn: "0",
        is_cold_start: cursor.viewCount === 0 ? "1" : "0",
        pull_type: cursor.viewCount === 0 ? "0" : "2",
        request_tag_from: "h5",
        volume: "0.5",
        os_api: "29",
        device_type: "MI 9",
        device_platform: "android",
        version_code: "170400",
        aid: "1128",
        channel: "wandoujia",
        refresh_index: String(cursor.refreshIndex),
        view_count: String(cursor.viewCount),
      };
      Object.entries(params).forEach(([key, value]) =>
        url.searchParams.set(key, value)
      );
      const response = await fetchWithTimeout(url, {
        headers: {
          Accept: "application/json",
          "User-Agent": DOUYIN_APP_USER_AGENT,
        },
      });
      if (!response.ok) throw new Error(`Douyin feed HTTP ${response.status}`);
      const payload = JSON.parse(await readLimitedText(response)) as JsonRecord;
      if (
        Number(payload.status_code) !== 0 ||
        !Array.isArray(payload.aweme_list)
      ) {
        throw new Error("Douyin feed payload invalid");
      }
      const items = payload.aweme_list
        .map((item) => mapDouyinItem(item))
        .filter((item): item is ShortVideoResolveResponse => item !== null)
        .slice(0, limit);
      if (items.length === 0)
        throw new Error("Douyin feed contained no H.264/AAC MP4");
      return {
        version: SHORT_VIDEO_RESOLVER_CONTRACT_VERSION,
        provider: "douyin",
        items,
        nextCursor: encodeCursor(
          cursor.refreshIndex + 1,
          cursor.viewCount + items.length
        ),
        hasMore: true,
      };
    } catch (error) {
      lastError = error;
    }
  }
  console.error("[short-video] Direct Douyin feed failed:", lastError);
  throw new ShortVideoResolverError(
    "抖音推荐流暂时不可用，请稍后再试",
    502,
    "DOUYIN_FEED_UNAVAILABLE"
  );
}

function findRouterVideoItem(value: unknown): unknown {
  const root = asRecord(value);
  const loaderData = asRecord(root?.loaderData);
  if (!loaderData) return undefined;
  for (const entry of Object.values(loaderData)) {
    const record = asRecord(entry);
    const response = asRecord(record?.videoInfoRes);
    if (Array.isArray(response?.item_list) && response.item_list.length > 0) {
      return response.item_list[0];
    }
  }
  return undefined;
}

async function resolveDirectDouyin(
  rawUrl: unknown
): Promise<ShortVideoResolveResponse> {
  const sourceUrl = normalizeDouyinSourceUrl(rawUrl);
  let response: Response;
  try {
    response = await fetchWithTimeout(sourceUrl, {
      redirect: "follow",
      headers: { Accept: "text/html", "User-Agent": DOUYIN_WEB_USER_AGENT },
    });
  } catch (error) {
    if (error instanceof ShortVideoResolverError) throw error;
    throw new ShortVideoResolverError(
      "无法打开抖音分享链接",
      502,
      "DOUYIN_LINK_UNAVAILABLE"
    );
  }
  if (!response.ok) {
    throw new ShortVideoResolverError(
      "抖音分享链接暂时不可用",
      502,
      "DOUYIN_LINK_UNAVAILABLE"
    );
  }
  const finalUrl = new URL(response.url || sourceUrl);
  if (!ALLOWED_DOUYIN_HOSTS.has(finalUrl.hostname.toLowerCase())) {
    throw new ShortVideoResolverError(
      "抖音分享链接跳转到了未知站点",
      502,
      "UNSAFE_REDIRECT"
    );
  }
  const html = await readLimitedText(response);
  const match = html.match(
    /<script[^>]*>\s*window\._ROUTER_DATA\s*=\s*([\s\S]*?)<\/script>/i
  );
  if (!match?.[1]) {
    throw new ShortVideoResolverError(
      "抖音页面暂时没有可解析视频",
      502,
      "DOUYIN_PAGE_CHANGED"
    );
  }
  try {
    const routerData = JSON.parse(
      match[1].trim().replace(/;\s*$/, "")
    ) as unknown;
    const item = mapDouyinItem(findRouterVideoItem(routerData), true);
    if (item) return item;
  } catch (error) {
    console.warn("[short-video] Douyin router data parse failed:", error);
  }
  throw new ShortVideoResolverError(
    "该链接没有 H.264/AAC 视频档位",
    502,
    "NO_TESLA_MEDIA"
  );
}

export async function resolveShortVideo(
  rawUrl: unknown
): Promise<ShortVideoResolveResponse> {
  const config = readResolverConfig();
  if (!config.configured) return resolveDirectDouyin(rawUrl);
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
  const config = readResolverConfig();
  if (!config.configured) return fetchDirectDouyinFeed(rawCursor, rawLimit);

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
  const record = asRecord(payload);
  if (
    !record ||
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
    .filter((item): item is ShortVideoResolveResponse => item !== null);
  if (items.length === 0) {
    throw new ShortVideoResolverError(
      "推荐流没有返回 Tesla 可播放的视频",
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
