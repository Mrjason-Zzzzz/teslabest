export const SHORT_VIDEO_RESOLVER_CONTRACT_VERSION = "1" as const;

export type ShortVideoContainer = "hls" | "mp4";
export type ShortVideoSegmentFormat = "mpegts" | "fmp4";

export interface ShortVideoPlaybackPreference {
  preferredContainers: ShortVideoContainer[];
  preferredVideoCodec: "h264";
  preferredAudioCodec: "aac";
  preferredSegmentFormat: "mpegts";
}

export interface ShortVideoResolveRequest {
  version: typeof SHORT_VIDEO_RESOLVER_CONTRACT_VERSION;
  provider: "douyin";
  url: string;
  playback: ShortVideoPlaybackPreference;
}

export interface ShortVideoFeedRequest {
  version: typeof SHORT_VIDEO_RESOLVER_CONTRACT_VERSION;
  provider: "douyin";
  mode: "recommend";
  cursor?: string;
  limit: number;
  playback: ShortVideoPlaybackPreference;
}

export interface ShortVideoMedia {
  url: string;
  container: ShortVideoContainer;
  segmentFormat?: ShortVideoSegmentFormat;
  videoCodec: "h264";
  audioCodec: "aac";
  width?: number;
  height?: number;
  bitrate?: number;
  expiresAt?: string;
}

export interface ShortVideoResolveResponse {
  version: typeof SHORT_VIDEO_RESOLVER_CONTRACT_VERSION;
  provider: "douyin";
  id: string;
  title: string;
  description?: string;
  author: string;
  authorAvatar?: string;
  cover?: string;
  shareUrl?: string;
  duration: number;
  likeCount?: number;
  commentCount?: number;
  media: ShortVideoMedia[];
}

export interface ShortVideoFeedResponse {
  version: typeof SHORT_VIDEO_RESOLVER_CONTRACT_VERSION;
  provider: "douyin";
  items: ShortVideoResolveResponse[];
  nextCursor?: string;
  hasMore: boolean;
}

export interface ShortVideoResolverStatus {
  configured: boolean;
  contractVersion: typeof SHORT_VIDEO_RESOLVER_CONTRACT_VERSION;
  mode: "vercel-direct" | "external-resolver";
  player: "tesla-webcodecs";
  capabilities: {
    resolve: true;
    feed: true;
    output: "mp4-h264-aac" | "hls-ts-h264-aac";
  };
}
