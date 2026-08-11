export const SHORT_VIDEO_RESOLVER_CONTRACT_VERSION = '1' as const;

export type ShortVideoContainer = 'hls' | 'mp4';

export interface ShortVideoResolveRequest {
  version: typeof SHORT_VIDEO_RESOLVER_CONTRACT_VERSION;
  provider: 'douyin';
  url: string;
  playback: {
    preferredContainers: ShortVideoContainer[];
    preferredVideoCodec: 'h264';
    preferredAudioCodec: 'aac';
  };
}

export interface ShortVideoMedia {
  url: string;
  container: ShortVideoContainer;
  videoCodec: 'h264';
  audioCodec: 'aac';
  width?: number;
  height?: number;
  bitrate?: number;
  expiresAt?: string;
}

export interface ShortVideoResolveResponse {
  version: typeof SHORT_VIDEO_RESOLVER_CONTRACT_VERSION;
  provider: 'douyin';
  id: string;
  title: string;
  author: string;
  cover?: string;
  duration: number;
  media: ShortVideoMedia[];
}

export interface ShortVideoResolverStatus {
  configured: boolean;
  contractVersion: typeof SHORT_VIDEO_RESOLVER_CONTRACT_VERSION;
  mode: 'external-resolver';
  player: 'tesla-webcodecs';
}
