/* eslint-disable @typescript-eslint/ban-ts-comment, @typescript-eslint/no-empty-function, no-empty, no-constant-condition */
// @ts-nocheck
import Hls from 'hls.js';
import * as MP4Box from 'mp4box';
import * as muxjs from 'mux.js';

import { createAdFilteringPlaylistLoader } from '@/lib/hls/ad-filter';
import {
  claimTeslaAudioFocus,
  deferTeslaAudioFocusRelease,
  getTeslaAudioContext,
} from '@/lib/tesla/audio-session';
import {
  chooseCommonAvStart,
  getAvDriftAction,
  getTeslaAvSyncPolicy,
  hasFutureVideoFrame,
  hasScheduledAudioCoverage,
  shouldContinueAudioPts,
  shouldResetAudioSchedule,
} from '@/lib/tesla/av-sync';
import {
  getHlsRecoveryStartPosition,
  HlsFragmentAdmissionGuard,
  resolveLiveHiddenMediaTarget,
} from '@/lib/tesla/hls-live-guard';

export type PlayerState =
  | 'idle'
  | 'buffering'
  | 'playing'
  | 'paused'
  | 'ended'
  | 'error';

export interface PlayerCallbacks {
  onTime?: (currentSec: number) => void;
  onDurationChange?: (durationSec: number) => void;
  onStateChange?: (state: PlayerState) => void;
  onFirstVideoFrame?: () => void;
  onError?: (message: string) => void;
  liveHint?: boolean;
  adFilterSource?: string;
  resolveLiveSource?: () => Promise<string | undefined>;
}

interface Segment {
  url: string;
  duration: number;
  startTime: number;
}

export class WebCodecsPlayer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private cb: PlayerCallbacks;

  private hls: any = null;
  private hlsVideoEl: HTMLVideoElement | null = null;
  private mp4File: any = null;
  private mp4AbortController: AbortController | null = null;
  private sourceKind: 'hls' | 'mp4' = 'hls';
  private sourceUrl = '';
  private loadGeneration = 0;
  private segments: Segment[] = [];
  private currentSegIndex = 0;
  private durationSec = 0;
  private isLivePlaylist = false;
  private liveHint = false;
  private adFilterSource = '';
  private endedReported = false;
  private lastRenderedMediaTime = 0;

  private packetStream: any = null;
  private parseStream: any = null;
  private elementaryStream: any = null;

  private videoDecoder: VideoDecoder | null = null;
  private audioDecoder: AudioDecoder | null = null;
  private videoConfig: any = null;
  private audioConfig: any = null;

  private encodedVideo: any[] = [];
  private encodedAudio: any[] = [];
  private vIdx = 0;
  private aIdx = 0;

  private frameQueue: VideoFrame[] = [];
  private decodedAudio: AudioData[] = [];

  private state: PlayerState = 'idle';
  private wantPlaying = true;
  private destroyed = false;
  private raf = 0;
  private audioScheduleTimer: number | null = null;
  private canvasSized = false;
  private showDebug = false;
  private needVideoKey = true;
  private lastTimeReportMs = 0;
  private lastHlsClockSyncMs = 0;
  private lastRenderedAtMs = 0;
  private lastAudioScheduledAtMs = 0;
  private bufferingStartedAtMs = 0;
  private recoveryAttempts = 0;
  private pipelineRecoveryTimestamps: number[] = [];
  private recoveryInFlight = false;
  private videoDecoderRecoveryInFlight = false;
  private videoDecoderRecoveryStartedAtMs = 0;
  private videoDecoderRecoveryTimestamps: number[] = [];
  private videoDecoderRecoveryCount = 0;
  private hlsNetworkRecoveryAttempts = 0;
  private hlsNetworkRecoveryTimer: number | null = null;
  private checkedTsContainer = false;
  private audioRemainder = new Uint8Array(0);
  private nextAudioPtsSec: number | null = null;
  private fragmentTimelineStartSec: number | null = null;
  private fragmentTimelineOffsetSec: number | null = null;
  private fragmentContinuityCounter: number | null = null;
  private fragmentTimelineEpoch = 0;
  private fragmentGuard = new HlsFragmentAdmissionGuard();
  private activeVideoTimelineEpoch: number | null = null;
  private activeAudioTimelineEpoch: number | null = null;

  private spsNalu: Uint8Array | null = null;
  private ppsNalu: Uint8Array | null = null;
  private parsedVideoConfig: any = null;
  private parsedAudioConfig: any = null;

  private renderedFrames = 0;
  private firstVideoFrameReported = false;
  private decodedFrames = 0;
  private droppedFrames = 0;
  private lastAvDriftSec = 0;
  private avSyncCorrections = 0;
  private statsMark = { t: 0, rendered: 0, decoded: 0 };

  private audioCtx: AudioContext | null = null;
  private gain: GainNode | null = null;
  private mediaDest: MediaStreamAudioDestinationNode | null = null;
  private audioEl: HTMLAudioElement | null = null;
  private activeSources = new Set<AudioBufferSourceNode>();
  private baseMediaTime = 0;
  private ctxStartTime: number | null = null;
  private nextAudioStartTime = 0;
  private volume = 1;
  private playbackRate = 1;
  // At non-1x use the browser media path for audio when it exposes a
  // pitch-preservation flag. Canvas/WebCodecs still renders the video.
  private useNativePitchPreservingAudio = false;

  private debugStats = {
    hlsState: 'init',
    levelCount: 0,
    currentLevel: -1,
    fragLoaded: 0,
    bytesLoaded: 0,
    videoPes: 0,
    audioPes: 0,
    videoSamples: 0,
    audioSamples: 0,
    pmtFound: false,
    m3u8Preview: '',
    error: '',
    lastError: '',
    fragmentDuplicateDrops: 0,
    fragmentStaleDrops: 0,
    lastRecoveryReason: '',
  };

  constructor(canvas: HTMLCanvasElement, cb: PlayerCallbacks = {}) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('2d canvas context unavailable');
    this.ctx = ctx;
    this.cb = cb;
    this.liveHint = cb.liveHint === true;
    this.adFilterSource = cb.adFilterSource || '';

    if (!canvas.width || !canvas.height) {
      canvas.width = 1280;
      canvas.height = 720;
    }
  }

  static isSupported(): boolean {
    return (
      typeof VideoDecoder === 'function' && typeof AudioDecoder === 'function'
    );
  }

  async load(url: string, startAt = 0): Promise<void> {
    const isNewSource = this.sourceUrl !== url;
    if (isNewSource) {
      this.recoveryAttempts = 0;
      this.pipelineRecoveryTimestamps = [];
      this.videoDecoderRecoveryTimestamps = [];
      this.videoDecoderRecoveryCount = 0;
    }
    this.hlsNetworkRecoveryAttempts = 0;
    this.videoDecoderRecoveryInFlight = false;
    this.videoDecoderRecoveryStartedAtMs = 0;
    const generation = ++this.loadGeneration;
    this.teardown();
    this.teardownAudioGraph();
    this.destroyed = false;
    this.sourceUrl = url;
    this.sourceKind = this.looksLikeMp4Url(url) ? 'mp4' : 'hls';
    this.useNativePitchPreservingAudio =
      this.sourceKind === 'hls' &&
      this.playbackRate !== 1 &&
      this.canUseNativePitchPreservingAudio();
    this.segments = [];
    this.currentSegIndex = 0;
    this.isLivePlaylist = this.liveHint;
    this.endedReported = false;
    this.lastRenderedMediaTime = 0;
    this.videoConfig = null;
    this.audioConfig = null;
    this.audioRemainder = new Uint8Array(0);
    this.nextAudioPtsSec = null;
    this.fragmentTimelineStartSec = null;
    this.fragmentTimelineOffsetSec = null;
    this.fragmentContinuityCounter = null;
    this.fragmentTimelineEpoch = 0;
    this.fragmentGuard.reset();
    this.debugStats.fragmentDuplicateDrops = 0;
    this.debugStats.fragmentStaleDrops = 0;
    this.activeVideoTimelineEpoch = null;
    this.activeAudioTimelineEpoch = null;
    this.parsedVideoConfig = null;
    this.parsedAudioConfig = null;
    this.checkedTsContainer = false;
    this.lastHlsClockSyncMs = 0;
    this.lastRenderedAtMs = performance.now();
    this.lastAudioScheduledAtMs = performance.now();
    this.bufferingStartedAtMs = performance.now();
    this.baseMediaTime = startAt;
    this.ctxStartTime = null;
    this.nextAudioStartTime = 0;
    this.renderedFrames = 0;
    this.firstVideoFrameReported = false;
    this.decodedFrames = 0;
    this.droppedFrames = 0;
    this.lastAvDriftSec = 0;
    this.avSyncCorrections = 0;
    this.statsMark = { t: performance.now(), rendered: 0, decoded: 0 };
    this.setState('buffering');
    console.log('[WebCodecsPlayer] load url=' + url + ' startAt=' + startAt);

    // Keep the browser media session owned by this page while the audible
    // graph and decoders are rebuilt. This keeper is silent and does not take
    // part in the A/V clock.
    void claimTeslaAudioFocus();

    this.setupAudioGraph();
    this.setupDecoders(generation);
    this.startAudioScheduler();

    if (this.sourceKind === 'mp4') {
      this.loop();
      void this.loadMp4(url, startAt, generation).catch((error) => {
        if (this.destroyed || generation !== this.loadGeneration) return;
        this.fail(
          error instanceof Error ? error.message : 'MP4 短视频读取失败'
        );
      });
      return;
    }

    this.initDemuxPipeline(generation);

    if (!Hls.isSupported()) {
      this.fail('hls.js not supported');
      return;
    }

    const hls = new Hls({
      enableWorker: true,
      // Filter only text playlists before hls.js and the Canvas demuxer see
      // them. Segment bytes and HLS timing metadata remain untouched.
      pLoader: createAdFilteringPlaylistLoader(
        this.adFilterSource,
        !this.liveHint
      ),
      lowLatencyMode: false,
      autoStartLoad: true,
      startPosition: this.liveHint ? -1 : startAt,
      maxBufferLength: this.liveHint ? 24 : 36,
      maxMaxBufferLength: this.liveHint ? 48 : 72,
      backBufferLength: this.liveHint ? 8 : 16,
      liveSyncDurationCount: this.liveHint ? 3 : undefined,
      liveMaxLatencyDurationCount: this.liveHint ? 10 : undefined,
      maxLiveSyncPlaybackRate: this.liveHint ? 1.03 : 1,
      startLevel: 0,
      capLevelToPlayerSize: true,
      testBandwidth: false,
      fragLoadingTimeOut: 30000,
      manifestLoadingTimeOut: 20000,
      levelLoadingTimeOut: 20000,
    });

    this.hls = hls;

    hls.on(Hls.Events.MANIFEST_PARSED, (_evt: any, data: any) => {
      if (this.destroyed || generation !== this.loadGeneration) return;
      this.debugStats.hlsState = 'manifest-parsed';
      this.debugStats.levelCount = data.levels?.length || 0;
      console.log(
        '[WebCodecsPlayer] MANIFEST_PARSED, levels:',
        data.levels?.length
      );
    });

    hls.on(Hls.Events.LEVEL_LOADED, (_evt: any, data: any) => {
      if (this.destroyed || generation !== this.loadGeneration) return;
      const details = data.details;
      this.isLivePlaylist = Boolean(details?.live);
      if (this.hls?.config && this.isLivePlaylist) {
        this.hls.config.maxBufferLength = 24;
        this.hls.config.maxMaxBufferLength = 48;
        this.hls.config.backBufferLength = 8;
      }
      this.debugStats.hlsState = 'level-loaded';
      this.debugStats.currentLevel = data.level;

      if (details && details.fragments && details.fragments.length > 0) {
        this.segments = details.fragments.map((f: any) => ({
          url: f.url,
          duration: f.duration,
          startTime: f.start,
        }));
        this.durationSec =
          details.totalduration ||
          this.segments.reduce((s, f) => s + f.duration, 0);
        this.cb.onDurationChange?.(this.durationSec);

        if (this.currentSegIndex === 0 && startAt > 0) {
          this.currentSegIndex = this.findSegIndex(startAt);
          this.baseMediaTime = startAt;
        }

        console.log(
          '[WebCodecsPlayer] LEVEL_LOADED, segments:',
          this.segments.length,
          'duration:',
          this.durationSec
        );
      }
    });

    const feedCompatibleFragment = (data: any) => {
      if (this.destroyed || generation !== this.loadGeneration) return;
      const frag = data.frag;
      const payload = data.payload || frag?.data;
      if (!payload || !payload.byteLength) return;
      if (!this.fragmentGuard.accept(frag, data.part)) {
        this.debugStats.fragmentDuplicateDrops =
          this.fragmentGuard.duplicateDrops;
        this.debugStats.fragmentStaleDrops = this.fragmentGuard.staleDrops;
        return;
      }

      const bytes = new Uint8Array(payload);
      if (!this.checkedTsContainer) {
        this.checkedTsContainer = true;
        if (!this.isTransportStreamPayload(bytes)) {
          this.fail('当前直播线路不是 Tesla 播放所需的 H.264/AAC TS');
          return;
        }
      }
      this.debugStats.bytesLoaded += bytes.byteLength;
      if (!this.prepareFragmentTimeline(frag, generation)) return;
      this.feedTsData(bytes, generation);
    };

    const isEncryptedFragment = (frag: any) => {
      const method = frag?.decryptdata?.method;
      return Boolean(method && method !== 'NONE');
    };

    hls.on(Hls.Events.FRAG_LOADED, (_evt: any, data: any) => {
      if (this.destroyed || generation !== this.loadGeneration) return;
      this.debugStats.fragLoaded++;
      this.hlsNetworkRecoveryAttempts = 0;
      if (this.hlsNetworkRecoveryTimer) {
        clearTimeout(this.hlsNetworkRecoveryTimer);
        this.hlsNetworkRecoveryTimer = null;
      }

      // AES-128 payload is still ciphertext at FRAG_LOADED. Feeding it to the
      // TS detector produces a false incompatibility result, while hls.js can
      // play the same source after decryption. Plain fragments keep the fast
      // path and encrypted fragments are consumed once at FRAG_DECRYPTED.
      if (!isEncryptedFragment(data.frag)) {
        feedCompatibleFragment(data);
      }
    });

    hls.on(Hls.Events.FRAG_DECRYPTED, (_evt: any, data: any) => {
      if (this.destroyed || generation !== this.loadGeneration) return;
      feedCompatibleFragment(data);
    });

    hls.on(Hls.Events.ERROR, (_evt: any, data: any) => {
      if (this.destroyed || generation !== this.loadGeneration) return;
      console.warn('[WebCodecsPlayer] HLS ERROR:', data.type, data.details);
      this.debugStats.lastError = data.details || data.type;
      if (!data.fatal) return;

      if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
        this.setState('buffering');
        if (typeof navigator !== 'undefined' && !navigator.onLine) return;

        if (this.hlsNetworkRecoveryAttempts < 5) {
          const attempt = ++this.hlsNetworkRecoveryAttempts;
          const delay = Math.min(10000, 1000 * Math.pow(2, attempt - 1));
          if (this.hlsNetworkRecoveryTimer)
            clearTimeout(this.hlsNetworkRecoveryTimer);
          this.hlsNetworkRecoveryTimer = window.setTimeout(() => {
            this.hlsNetworkRecoveryTimer = null;
            if (
              this.destroyed ||
              generation !== this.loadGeneration ||
              this.hls !== hls
            )
              return;
            try {
              const recoveryPosition = getHlsRecoveryStartPosition(
                this.isLivePlaylist,
                this.getMediaTime(),
                hls.liveSyncPosition
              );
              this.debugStats.lastRecoveryReason = this.isLivePlaylist
                ? 'network-live-edge'
                : 'network-current-position';
              hls.startLoad(recoveryPosition, this.isLivePlaylist);
            } catch {}
          }, delay);
          return;
        }
      }

      if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
        if (this.recoveryInFlight) return;
        if (!this.registerPipelineRecoveryAttempt()) {
          this.fail('hls: ' + (data.details || data.type));
          return;
        }
        this.setState('buffering');
        if (this.isLivePlaylist || this.liveHint) {
          this.recoveryInFlight = true;
          void this.restartLiveAtEdge('fatal-media-error').finally(() => {
            this.recoveryInFlight = false;
          });
          return;
        }
        try {
          hls.recoverMediaError();
        } catch {}
        return;
      }

      this.fail('hls: ' + (data.details || data.type));
    });

    hls.loadSource(url);
    const videoEl = document.createElement('video');
    videoEl.style.display = 'none';
    videoEl.playsInline = true;
    this.configureNativePitchAudio(videoEl);
    document.body.appendChild(videoEl);
    this.hlsVideoEl = videoEl;
    hls.attachMedia(videoEl);

    this.loop();
  }

  private looksLikeMp4Url(url: string): boolean {
    try {
      const parsed = new URL(url, window.location.href);
      return (
        /\.mp4$/i.test(parsed.pathname) ||
        parsed.searchParams.get('mime_type') === 'video_mp4'
      );
    } catch {
      return /\.mp4(?:\?|$)/i.test(url) || /mime_type=video_mp4/i.test(url);
    }
  }

  /**
   * Progressive MP4 path for the Tesla short-video module. MP4Box only
   * separates the already-compatible AVC/AAC samples; VideoDecoder,
   * AudioDecoder, Canvas and WebAudio remain the actual playback path.
   */
  private async loadMp4(url: string, startAt: number, generation: number) {
    const controller = new AbortController();
    this.mp4AbortController = controller;
    const file = MP4Box.createFile();
    this.mp4File = file;

    let info: any = null;
    let readyResolve: (() => void) | null = null;
    let readyReject: ((error: Error) => void) | null = null;
    const ready = new Promise<void>((resolve, reject) => {
      readyResolve = resolve;
      readyReject = reject;
    });

    file.onError = (error: unknown) => {
      readyReject?.(new Error('MP4 解析失败：' + String(error)));
    };
    file.onReady = (nextInfo: any) => {
      if (this.destroyed || generation !== this.loadGeneration) return;
      info = nextInfo;
      readyResolve?.();
    };
    file.onSamples = (trackId: number, _user: unknown, samples: any[]) => {
      if (this.destroyed || generation !== this.loadGeneration || !info) return;
      const track = info.tracks.find((item: any) => item.id === trackId);
      if (!track) return;

      if (track.type === 'video') {
        this.configureMp4Video(track, samples[0]);
        for (const sample of samples) {
          if (!sample.data?.byteLength) continue;
          this.encodedVideo.push({
            key: sample.is_sync === true,
            timestamp: Math.round((sample.cts / sample.timescale) * 1e6),
            duration: Math.max(
              1,
              Math.round((sample.duration / sample.timescale) * 1e6)
            ),
            data: sample.data.slice(),
          });
          this.debugStats.videoSamples++;
        }
      } else if (track.type === 'audio') {
        this.configureMp4Audio(track);
        for (const sample of samples) {
          if (!sample.data?.byteLength) continue;
          this.encodedAudio.push({
            key: true,
            timestamp: Math.round((sample.cts / sample.timescale) * 1e6),
            duration: Math.max(
              1,
              Math.round((sample.duration / sample.timescale) * 1e6)
            ),
            data: sample.data.slice(),
          });
          this.debugStats.audioSamples++;
        }
      }

      const lastSample = samples[samples.length - 1];
      if (lastSample?.number != null) {
        try {
          file.releaseUsedSamples(trackId, lastSample.number + 1);
        } catch {}
      }
    };

    // Douyin's H.264 combined files are fast-start MP4. Read only enough for
    // ftyp/moov first, then Range-seek to the requested keyframe. This keeps
    // resume and swipe seeking fast even for long videos.
    const metadataChunkSize = 2 * 1024 * 1024;
    let metadataOffset = 0;
    while (!info && metadataOffset < 8 * 1024 * 1024) {
      const chunk = await this.fetchMp4Range(
        url,
        metadataOffset,
        metadataOffset + metadataChunkSize - 1,
        controller.signal
      );
      if (this.destroyed || generation !== this.loadGeneration) return;
      this.appendMp4Buffer(file, chunk.buffer, chunk.start);
      metadataOffset = chunk.end + 1;
      if (chunk.end >= chunk.total - 1) break;
    }
    if (!info) {
      throw new Error('该短视频不是可渐进读取的 MP4');
    }
    await ready;

    const videoTrack = info.tracks.find(
      (track: any) =>
        track.type === 'video' && /^avc[13]\./i.test(track.codec || '')
    );
    const audioTrack = info.tracks.find(
      (track: any) =>
        track.type === 'audio' && /^mp4a\.40\./i.test(track.codec || '')
    );
    if (!videoTrack || !audioTrack) {
      throw new Error('该短视频不是 Tesla 所需的 H.264/AAC');
    }

    this.durationSec = Number(info.duration) / Number(info.timescale || 1);
    if (!Number.isFinite(this.durationSec) || this.durationSec <= 0) {
      this.durationSec = Math.max(
        Number(videoTrack.duration) / Number(videoTrack.timescale || 1),
        Number(audioTrack.duration) / Number(audioTrack.timescale || 1)
      );
    }
    this.cb.onDurationChange?.(this.durationSec);
    this.isLivePlaylist = false;

    file.setExtractionOptions(videoTrack.id, null, {
      nbSamples: 24,
      rapAlignement: false,
    });
    file.setExtractionOptions(audioTrack.id, null, {
      nbSamples: 48,
      rapAlignement: false,
    });
    const seekResult = file.seek(Math.max(0, startAt), true);
    const seekOffset = Number(seekResult?.offset) || 0;
    file.start();

    // MP4Box may discard mdat bytes that arrived before extraction was
    // configured. Re-read from the keyframe offset returned by seek() instead
    // of skipping to the end of the metadata probe, otherwise the first
    // undecoded sample leaves extraction permanently blocked.
    const nextOffset = Math.max(0, seekOffset);
    await this.streamMp4Range(
      url,
      nextOffset,
      file,
      controller.signal,
      generation
    );
    if (!this.destroyed && generation === this.loadGeneration) file.flush();
  }

  private appendMp4Buffer(file: any, buffer: ArrayBuffer, fileStart: number) {
    const mp4Buffer = buffer as ArrayBuffer & { fileStart: number };
    mp4Buffer.fileStart = fileStart;
    file.appendBuffer(mp4Buffer);
  }

  private async fetchMp4Range(
    url: string,
    start: number,
    end: number | null,
    signal: AbortSignal
  ): Promise<{
    buffer: ArrayBuffer;
    start: number;
    end: number;
    total: number;
  }> {
    const range = end == null ? `bytes=${start}-` : `bytes=${start}-${end}`;
    const response = await fetch(url, {
      headers: { Range: range },
      cache: 'no-store',
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      signal,
    });
    if (response.status !== 206) {
      throw new Error('短视频源不支持 Range 分段读取');
    }
    const contentRange = response.headers.get('content-range') || '';
    const match = contentRange.match(/^bytes\s+(\d+)-(\d+)\/(\d+)$/i);
    if (!match) throw new Error('短视频源返回了无效的分段范围');
    const actualStart = Number(match[1]);
    const actualEnd = Number(match[2]);
    const total = Number(match[3]);
    if (actualStart !== start || !Number.isFinite(total)) {
      throw new Error('短视频分段位置不匹配');
    }
    return {
      buffer: await response.arrayBuffer(),
      start: actualStart,
      end: actualEnd,
      total,
    };
  }

  private async streamMp4Range(
    url: string,
    start: number,
    file: any,
    signal: AbortSignal,
    generation: number
  ) {
    const response = await fetch(url, {
      headers: { Range: `bytes=${start}-` },
      cache: 'no-store',
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      signal,
    });
    if (response.status !== 206 || !response.body) {
      throw new Error('短视频续传失败');
    }
    const contentRange = response.headers.get('content-range') || '';
    const match = contentRange.match(/^bytes\s+(\d+)-(\d+)\/(\d+)$/i);
    if (!match || Number(match[1]) !== start) {
      throw new Error('短视频续传范围不匹配');
    }

    const reader = response.body.getReader();
    let offset = start;
    while (true) {
      if (this.destroyed || generation !== this.loadGeneration) {
        await reader.cancel();
        return;
      }
      while (
        this.encodedVideo.length - this.vIdx > 360 ||
        this.encodedAudio.length - this.aIdx > 720
      ) {
        await new Promise((resolve) => setTimeout(resolve, 35));
        if (this.destroyed || generation !== this.loadGeneration) return;
      }
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = value.buffer.slice(
        value.byteOffset,
        value.byteOffset + value.byteLength
      );
      this.appendMp4Buffer(file, chunk, offset);
      offset += value.byteLength;
    }
  }

  private configureMp4Video(track: any, sample: any) {
    if (this.videoConfig || !sample?.description?.avcC) return;
    const avcC = sample.description.avcC;
    const sps = avcC.SPS?.[0]?.data;
    const pps = avcC.PPS?.[0]?.data;
    if (!sps || !pps) {
      this.fail('MP4 缺少 AVC 解码参数');
      return;
    }
    const config = this.buildVideoConfig(sps, pps);
    config.codec = track.codec;
    config.codedWidth =
      track.video?.width || sample.description.width || config.codedWidth;
    config.codedHeight =
      track.video?.height || sample.description.height || config.codedHeight;
    this.videoConfig = config;
    this.videoDecoder?.configure({
      codec: config.codec,
      codedWidth: config.codedWidth,
      codedHeight: config.codedHeight,
      description: config.description,
      optimizeForLatency: false,
    });
  }

  private configureMp4Audio(track: any) {
    if (this.audioConfig) return;
    const sampleRate = Number(track.audio?.sample_rate) || 44100;
    const channels = Number(track.audio?.channel_count) || 2;
    const description = this.buildAacConfig(sampleRate, channels, 2);
    this.audioConfig = {
      codec: track.codec || 'mp4a.40.2',
      sampleRate,
      numberOfChannels: channels,
      description,
    };
    this.audioDecoder?.configure(this.audioConfig);
  }

  private initDemuxPipeline(generation = this.loadGeneration) {
    const mp2t = muxjs.mp2t;

    this.packetStream = new mp2t.TransportPacketStream();
    this.parseStream = new mp2t.TransportParseStream();
    this.elementaryStream = new mp2t.ElementaryStream();

    this.packetStream.pipe(this.parseStream);
    this.parseStream.pipe(this.elementaryStream);

    this.parseStream.on('data', (d: any) => {
      if (d.type === 'pmt') this.debugStats.pmtFound = true;
    });

    this.elementaryStream.on('data', (d: any) => {
      if (this.destroyed || generation !== this.loadGeneration) return;
      if (d.type === 'video') {
        this.debugStats.videoPes++;
        this.handleVideoPes(d);
      } else if (d.type === 'audio') {
        this.debugStats.audioPes++;
        this.handleAudioPes(d);
      }
    });

    this.elementaryStream.on('error', (err: any) => {
      if (this.destroyed || generation !== this.loadGeneration) return;
      console.warn('[WebCodecsPlayer] demux error:', err);
      this.debugStats.lastError = String(err);
    });
  }

  private prepareFragmentTimeline(
    frag: any,
    generation = this.loadGeneration
  ): boolean {
    const start = Number(frag?.start);
    const cc = Number(frag?.cc);
    const hasStart = Number.isFinite(start);
    const hasCC = Number.isFinite(cc);
    const staleContinuity =
      hasCC &&
      this.fragmentContinuityCounter !== null &&
      cc < this.fragmentContinuityCounter;
    if (staleContinuity) {
      this.debugStats.fragmentStaleDrops++;
      return false;
    }
    const continuityChanged =
      hasCC &&
      this.fragmentContinuityCounter !== null &&
      cc > this.fragmentContinuityCounter;

    if (this.fragmentTimelineOffsetSec === null || continuityChanged) {
      this.fragmentTimelineStartSec = hasStart ? start : null;
      this.fragmentTimelineOffsetSec = null;
      this.audioRemainder = new Uint8Array(0);
      this.nextAudioPtsSec = null;
    }
    if (continuityChanged) {
      // A discontinuity may switch PAT/PMT PIDs or restart the PES parser. The
      // fragment is fetched ahead of playback, so only reset the demuxer here;
      // decoded queues are switched later when their epoch reaches the pump.
      this.fragmentTimelineEpoch++;
      this.spsNalu = null;
      this.ppsNalu = null;
      this.parsedVideoConfig = null;
      this.parsedAudioConfig = null;
      this.initDemuxPipeline(generation);
    }
    if (hasCC) this.fragmentContinuityCounter = cc;
    return true;
  }

  private normalizeFragmentPts(rawPtsSec: number): number {
    if (!Number.isFinite(rawPtsSec)) return 0;
    if (
      this.fragmentTimelineOffsetSec === null &&
      this.fragmentTimelineStartSec !== null
    ) {
      // HLS keeps frag.start continuous across EXT-X-DISCONTINUITY while the
      // underlying MPEG-TS PTS may restart. One shared offset preserves the
      // original audio/video delta and prevents post-ad timeline overlap.
      this.fragmentTimelineOffsetSec =
        this.fragmentTimelineStartSec - rawPtsSec;
    }
    return rawPtsSec + (this.fragmentTimelineOffsetSec || 0);
  }

  private feedTsData(data: Uint8Array, generation = this.loadGeneration) {
    if (
      this.destroyed ||
      generation !== this.loadGeneration ||
      !this.packetStream
    )
      return;
    try {
      this.packetStream.push(data);
      this.packetStream.flush();
    } catch (e) {
      console.warn('[WebCodecsPlayer] feedTs error:', e);
    }
  }

  private handleVideoPes(pes: any) {
    const pesData = pes.data;
    const rawPts = pes.pts != null ? pes.pts / 90000 : 0;
    const pts = this.normalizeFragmentPts(rawPts);
    if (!pesData || !(pesData instanceof Uint8Array) || pesData.length === 0)
      return;

    const nalus = this.splitNalus(pesData);
    if (nalus.length === 0) return;

    let hasKeyFrame = false;
    const frameNalus: Uint8Array[] = [];

    for (const nalu of nalus) {
      const naluType = this.getNaluType(nalu);
      if (naluType === 7) {
        this.spsNalu = nalu;
      } else if (naluType === 8) {
        this.ppsNalu = nalu;
      } else if (naluType === 5) {
        hasKeyFrame = true;
        frameNalus.push(nalu);
      } else if (
        naluType === 1 ||
        naluType === 2 ||
        naluType === 3 ||
        naluType === 4
      ) {
        frameNalus.push(nalu);
      }
    }

    if (this.spsNalu && this.ppsNalu) {
      const config = this.buildVideoConfig(this.spsNalu, this.ppsNalu);
      if (!this.areDecoderConfigsEqual(config, this.parsedVideoConfig)) {
        this.parsedVideoConfig = config;
      }
    }

    if (frameNalus.length === 0) return;

    const frameData = this.nalusToAvcc(frameNalus);
    this.encodedVideo.push({
      key: hasKeyFrame,
      timestamp: Math.round(pts * 1e6),
      duration: 33000,
      data: frameData,
      timelineEpoch: this.fragmentTimelineEpoch,
      decoderConfig: this.parsedVideoConfig,
    });
    this.debugStats.videoSamples++;
  }

  private handleAudioPes(pes: any) {
    const pesData = pes.data;
    const rawPesPts = pes.pts != null ? pes.pts / 90000 : 0;
    const pesPts = this.normalizeFragmentPts(rawPesPts);
    if (!pesData || !(pesData instanceof Uint8Array) || pesData.length === 0)
      return;

    const combined = new Uint8Array(
      this.audioRemainder.length + pesData.length
    );
    combined.set(this.audioRemainder, 0);
    combined.set(pesData, this.audioRemainder.length);
    const extracted = this.extractAdtsFrames(combined);
    this.audioRemainder = extracted.remainder;

    let framePts = shouldContinueAudioPts(
      pesPts,
      this.nextAudioPtsSec,
      this.isLivePlaylist
    )
      ? this.nextAudioPtsSec
      : pesPts;

    for (const frame of extracted.frames) {
      const adts = this.parseAdts(frame);
      if (!adts) continue;

      const nextAudioConfig = {
        codec: 'mp4a.40.2',
        sampleRate: adts.sampleRate,
        numberOfChannels: adts.channels,
        description: this.buildAacConfig(
          adts.sampleRate,
          adts.channels,
          adts.profile
        ),
      };
      if (
        !this.areDecoderConfigsEqual(nextAudioConfig, this.parsedAudioConfig)
      ) {
        this.parsedAudioConfig = nextAudioConfig;
      }

      const headerLength = (frame[1] & 0x01) === 1 ? 7 : 9;
      if (frame.length <= headerLength) continue;
      const frameDurationSec = 1024 / adts.sampleRate;
      this.encodedAudio.push({
        key: true,
        timestamp: Math.round(framePts * 1e6),
        duration: Math.round(frameDurationSec * 1e6),
        data: frame.subarray(headerLength),
        timelineEpoch: this.fragmentTimelineEpoch,
        decoderConfig: this.parsedAudioConfig,
      });
      framePts += frameDurationSec;
      this.nextAudioPtsSec = framePts;
      this.debugStats.audioSamples++;
    }
  }

  private createVideoDecoder(generation = this.loadGeneration) {
    this.needVideoKey = true;
    const decoder = new VideoDecoder({
      output: (frame) => {
        if (this.destroyed || generation !== this.loadGeneration) {
          frame.close();
          return;
        }
        this.onVideoFrame(frame);
      },
      error: (e) => {
        if (generation === this.loadGeneration) {
          this.recoverVideoDecoder(e, generation);
        }
      },
    });
    this.videoDecoder = decoder;
    if (this.videoConfig) {
      decoder.configure({
        codec: this.videoConfig.codec,
        codedWidth: this.videoConfig.codedWidth,
        codedHeight: this.videoConfig.codedHeight,
        description: this.videoConfig.description,
        optimizeForLatency: false,
      });
    }
    return decoder;
  }

  private createAudioDecoder(generation = this.loadGeneration) {
    const decoder = new AudioDecoder({
      output: (data) => {
        if (this.destroyed || generation !== this.loadGeneration) {
          data.close();
          return;
        }
        this.decodedAudio.push(data);
      },
      error: (e) => {
        if (generation === this.loadGeneration)
          this.fail('audio decoder: ' + e.message);
      },
    });
    this.audioDecoder = decoder;
    if (this.audioConfig) decoder.configure(this.audioConfig);
    return decoder;
  }

  private configureVideoDecoder(config: any) {
    if (!config || !this.videoDecoder) return;
    this.videoConfig = config;
    this.videoDecoder.configure({
      codec: config.codec,
      codedWidth: config.codedWidth,
      codedHeight: config.codedHeight,
      description: config.description,
      optimizeForLatency: false,
    });
    this.needVideoKey = true;
    console.log(
      '[WebCodecsPlayer] video decoder configured:',
      config.codec,
      config.codedWidth + 'x' + config.codedHeight
    );
  }

  private rebuildVideoDecoderForBoundary(config: any) {
    const previous = this.videoDecoder;
    this.videoDecoder = null;
    try {
      if (previous && previous.state !== 'closed') previous.close();
    } catch {}
    for (const frame of this.frameQueue) frame.close();
    this.frameQueue = [];
    if (config) this.videoConfig = config;
    this.createVideoDecoder(this.loadGeneration);
    this.needVideoKey = true;
  }

  private configureAudioDecoder(config: any) {
    if (!config || !this.audioDecoder) return;
    this.audioConfig = config;
    this.audioDecoder.configure(config);
    console.log(
      '[WebCodecsPlayer] audio decoder configured:',
      config.sampleRate + 'Hz',
      config.numberOfChannels + 'ch'
    );
  }

  private rebuildAudioDecoderForBoundary(config: any) {
    const previous = this.audioDecoder;
    this.audioDecoder = null;
    try {
      if (previous && previous.state !== 'closed') previous.close();
    } catch {}
    if (config) this.audioConfig = config;
    this.createAudioDecoder(this.loadGeneration);
  }

  private areDecoderConfigsEqual(left: any, right: any): boolean {
    if (left === right) return true;
    if (!left || !right) return false;
    if (
      left.codec !== right.codec ||
      left.codedWidth !== right.codedWidth ||
      left.codedHeight !== right.codedHeight ||
      left.sampleRate !== right.sampleRate ||
      left.numberOfChannels !== right.numberOfChannels
    )
      return false;

    const leftDescription = left.description as Uint8Array | undefined;
    const rightDescription = right.description as Uint8Array | undefined;
    if (leftDescription === rightDescription) return true;
    if (
      !leftDescription ||
      !rightDescription ||
      leftDescription.byteLength !== rightDescription.byteLength
    )
      return false;
    for (let index = 0; index < leftDescription.byteLength; index++) {
      if (leftDescription[index] !== rightDescription[index]) return false;
    }
    return true;
  }

  private recoverVideoDecoder(error: Error, generation = this.loadGeneration) {
    if (
      this.destroyed ||
      generation !== this.loadGeneration ||
      this.videoDecoderRecoveryInFlight
    )
      return;

    const now = Date.now();
    this.videoDecoderRecoveryTimestamps =
      this.videoDecoderRecoveryTimestamps.filter(
        (timestamp) => now - timestamp < 60_000
      );
    if (this.videoDecoderRecoveryTimestamps.length >= 6) {
      this.fail('video decoder: 连续恢复失败，请重试当前线路');
      return;
    }

    this.videoDecoderRecoveryInFlight = true;
    this.videoDecoderRecoveryStartedAtMs = performance.now();
    this.videoDecoderRecoveryTimestamps.push(now);
    this.videoDecoderRecoveryCount++;
    this.debugStats.lastError = `video decoder recovered: ${error.message}`;
    console.warn(
      '[WebCodecsPlayer] rebuilding video decoder without resetting audio:',
      error
    );

    const failedDecoder = this.videoDecoder;
    this.videoDecoder = null;
    try {
      if (failedDecoder && failedDecoder.state !== 'closed') {
        failedDecoder.close();
      }
    } catch {}

    for (const frame of this.frameQueue) frame.close();
    this.frameQueue = [];
    this.needVideoKey = true;
    this.lastRenderedAtMs = performance.now();

    try {
      this.createVideoDecoder(generation);
    } catch (decoderError) {
      this.videoDecoderRecoveryInFlight = false;
      this.videoDecoderRecoveryStartedAtMs = 0;
      this.fail(
        'video decoder: ' +
          (decoderError instanceof Error
            ? decoderError.message
            : '视频轨道重建失败')
      );
      return;
    }

    // Keep ctxStartTime, scheduled audio and the shared AudioContext intact.
    // The video pump resumes at the next keyframe and catches up to the same
    // audio master clock, avoiding the overlapping-audio regression caused by
    // rebuilding the full player.
  }

  private setupDecoders(generation = this.loadGeneration) {
    this.createVideoDecoder(generation);
    this.createAudioDecoder(generation);
  }

  private setupAudioGraph() {
    const ctx = getTeslaAudioContext();
    if (!ctx) return;

    // Reuse one document-level AudioContext across source/episode/quality
    // changes. Recreating the context on every player mount loses the browser's
    // previous user-gesture unlock and is the main cause of silent source swaps.
    this.audioCtx = ctx;
    this.gain = ctx.createGain();
    this.gain.gain.value = this.volume;
    this.gain.connect(ctx.destination);
    this.mediaDest = null;
    this.audioEl = null;
  }

  private onVideoFrame(frame: VideoFrame) {
    this.videoDecoderRecoveryInFlight = false;
    this.videoDecoderRecoveryStartedAtMs = 0;
    this.decodedFrames++;
    const frameLimit = this.isLivePlaylist ? 16 : 48;
    while (this.frameQueue.length >= frameLimit) {
      this.frameQueue.shift()?.close();
      this.droppedFrames++;
    }
    this.frameQueue.push(frame);
  }

  private startAudioScheduler() {
    if (this.audioScheduleTimer !== null) {
      clearInterval(this.audioScheduleTimer);
    }
    // Canvas rendering stays on the single RAF loop. This lightweight timer
    // only keeps the cancellable WebAudio horizon filled when Tesla delays RAF
    // during layout, controls or browser chrome work.
    this.audioScheduleTimer = window.setInterval(() => {
      if (this.destroyed) return;
      try {
        this.pumpAudio();
        if (!this.wantPlaying || this.ctxStartTime === null) return;
        const clock = this.getMediaTime();
        if (this.getCurrentAvDriftAction(clock) === 'none') {
          this.scheduleAudio();
        }
      } catch (error) {
        console.warn('[WebCodecsPlayer] audio scheduler error:', error);
      }
    }, 35);
  }

  private loop = () => {
    this.tick();
    if (!this.destroyed) {
      this.raf = requestAnimationFrame(this.loop);
    }
  };

  private tick() {
    try {
      this.pumpVideo();
      this.pumpAudio();
      this.compactEncodedQueues();

      if (this.ctxStartTime === null) {
        this.maybePrime();
        this.drawFirstFrame();
      } else {
        const clock = this.getMediaTime();
        this.presentVideo(clock);
        const driftAction = this.getCurrentAvDriftAction(clock);
        if (driftAction === 'reset-clock') {
          this.resetClockForAvDrift();
          return;
        }
        if (driftAction === 'none') this.scheduleAudio();
        this.reportTime(clock);
        this.maybeReportEnded(clock);
        this.maybeEnterBuffering();
      }

      // Debug information is exposed through getStats(). Never paint it into
      // the video canvas: that races with VideoFrame rendering and flickers.
      this.maybeRecoverFromStall();
    } catch (e) {
      console.error('[WebCodecsPlayer] tick error:', e);
    }
  }

  private maybeReportEnded(clock: number) {
    if (
      this.endedReported ||
      this.isLivePlaylist ||
      this.state !== 'playing' ||
      this.durationSec <= 0 ||
      clock < this.durationSec - 0.15
    )
      return;

    this.endedReported = true;
    this.wantPlaying = false;
    this.cb.onTime?.(this.durationSec);
    this.setState('ended');
    this.audioCtx?.suspend().catch(() => {});
  }

  private compactEncodedQueues() {
    const videoCompactThreshold = this.isLivePlaylist ? 120 : 600;
    const audioCompactThreshold = this.isLivePlaylist ? 240 : 1200;
    if (this.vIdx > videoCompactThreshold) {
      this.encodedVideo = this.encodedVideo.slice(this.vIdx);
      this.vIdx = 0;
    }
    if (this.aIdx > audioCompactThreshold) {
      this.encodedAudio = this.encodedAudio.slice(this.aIdx);
      this.aIdx = 0;
    }
  }

  private maybeEnterBuffering() {
    if (
      this.state !== 'playing' ||
      !this.wantPlaying ||
      this.ctxStartTime === null
    )
      return;

    const noVideoReady =
      this.frameQueue.length === 0 &&
      (this.videoDecoder?.decodeQueueSize || 0) === 0 &&
      this.vIdx >= this.encodedVideo.length;
    const audioPipelineActive =
      this.audioConfig !== null ||
      this.debugStats.audioSamples > 0 ||
      this.encodedAudio.length > 0 ||
      this.decodedAudio.length > 0;
    const syncPolicy = getTeslaAvSyncPolicy(
      this.isLivePlaylist,
      this.playbackRate,
      this.canvasSized
    );
    const hasAudibleCoverage =
      this.audioCtx !== null &&
      hasScheduledAudioCoverage(
        this.nextAudioStartTime,
        this.audioCtx.currentTime,
        syncPolicy.audioStartSafetySec
      );
    const noAudioReady =
      audioPipelineActive &&
      !hasAudibleCoverage &&
      this.decodedAudio.length === 0 &&
      (this.audioDecoder?.decodeQueueSize || 0) === 0 &&
      this.aIdx >= this.encodedAudio.length;
    const currentClock = this.getMediaTime();
    const nearVodEnd =
      !this.isLivePlaylist &&
      this.durationSec > 0 &&
      this.durationSec - currentClock <= 0.25;

    // Brief decoder gaps are normal. Freeze the media clock only when one side
    // of the A/V pipeline has actually been empty for a moment.
    const now = performance.now();
    const videoStarved =
      !this.videoDecoderRecoveryInFlight &&
      noVideoReady &&
      now - this.lastRenderedAtMs >= syncPolicy.videoStarvationMs;
    // The actual WebAudio horizon is already at/below the safety margin and
    // no decoded or encoded audio remains. Freeze before the picture advances
    // into a silent second; wall-clock time since the last scheduler run is
    // not a reliable measure of audible coverage.
    const audioStarved = noAudioReady && !nearVodEnd;
    if (!videoStarved && !audioStarved) return;

    const clock = currentClock;
    this.baseMediaTime = Math.max(
      this.baseMediaTime,
      this.lastRenderedMediaTime || clock
    );
    this.ctxStartTime = null;
    this.nextAudioStartTime = 0;
    this.bufferingStartedAtMs = performance.now();

    for (const source of this.activeSources) {
      try {
        source.stop();
      } catch {}
    }
    this.activeSources.clear();
    // Do not suspend the page-level AudioContext here. The media clock is
    // already frozen by ctxStartTime=null, while keeping the context running
    // lets the silent MediaSession keeper retain Tesla's audio focus during a
    // short decoder rebuild.
    this.setState('buffering');
  }

  private async restartLiveAtEdge(reason: string) {
    const currentUrl = this.sourceUrl;
    let url = currentUrl;
    if (this.cb.resolveLiveSource) {
      try {
        const resolved = await Promise.race([
          this.cb.resolveLiveSource(),
          new Promise<undefined>((resolve) =>
            window.setTimeout(() => resolve(undefined), 5000)
          ),
        ]);
        if (resolved) url = resolved;
      } catch {}
    }
    if (!url) return;
    this.debugStats.lastRecoveryReason = reason;
    this.setState('buffering');
    // Refresh the exact selected channel URL before rebuilding. Signed IPTV
    // URLs commonly expire and redirect to a provider's default channel; an
    // identity-preserving refresh prevents that redirect from becoming an
    // apparent automatic channel switch.
    await this.load(url, 0);
  }

  private registerPipelineRecoveryAttempt(now = performance.now()) {
    // Count only recent failures. A long-running live channel must not be
    // terminated because three unrelated recoveries happened hours apart.
    const windowStart = now - 120_000;
    this.pipelineRecoveryTimestamps = this.pipelineRecoveryTimestamps.filter(
      (timestamp) => timestamp >= windowStart
    );
    if (this.pipelineRecoveryTimestamps.length >= 3) {
      this.recoveryAttempts = this.pipelineRecoveryTimestamps.length;
      return false;
    }
    this.pipelineRecoveryTimestamps.push(now);
    this.recoveryAttempts = this.pipelineRecoveryTimestamps.length;
    return true;
  }

  private maybeRecoverFromStall() {
    const now = performance.now();
    if (this.videoDecoderRecoveryInFlight) {
      if (now - this.videoDecoderRecoveryStartedAtMs < 15_000) return;
      this.videoDecoderRecoveryInFlight = false;
      this.recoverVideoDecoder(
        new Error('视频轨道重建后未收到关键帧'),
        this.loadGeneration
      );
      return;
    }
    const syncPolicy = getTeslaAvSyncPolicy(
      this.isLivePlaylist,
      this.playbackRate,
      this.canvasSized
    );
    const stalledWhilePlaying =
      this.state === 'playing' &&
      this.ctxStartTime !== null &&
      now - this.lastRenderedAtMs >= syncPolicy.stallRecoveryMs;
    const stalledWhileBuffering =
      this.state === 'buffering' &&
      this.ctxStartTime === null &&
      this.bufferingStartedAtMs > 0 &&
      now - this.bufferingStartedAtMs >= syncPolicy.stallRecoveryMs;

    if (
      (!stalledWhilePlaying && !stalledWhileBuffering) ||
      this.recoveryInFlight
    )
      return;

    if (!this.registerPipelineRecoveryAttempt(now)) {
      this.fail(
        this.sourceKind === 'mp4'
          ? '短视频持续卡顿，请上滑切换或重试'
          : '直播画面持续卡顿，请重试当前线路'
      );
      return;
    }

    this.recoveryInFlight = true;
    const isLive = this.isLivePlaylist || this.liveHint;
    const restartAt = isLive
      ? 0
      : Math.max(
          0,
          this.lastRenderedMediaTime || this.baseMediaTime,
          this.getMediaTime()
        ) + 0.05;
    Promise.resolve()
      .then(() =>
        isLive
          ? this.restartLiveAtEdge('stall-live-edge')
          : this.seek(restartAt)
      )
      .finally(() => {
        this.recoveryInFlight = false;
      });
  }

  private pumpVideo() {
    let dec = this.videoDecoder;
    if (!dec) return;
    const MAX_OUTSTANDING = this.isLivePlaylist ? 12 : 50;
    while (
      this.vIdx < this.encodedVideo.length &&
      this.frameQueue.length + dec.decodeQueueSize < MAX_OUTSTANDING
    ) {
      const s = this.encodedVideo[this.vIdx];
      const epochChanged =
        this.activeVideoTimelineEpoch !== null &&
        s.timelineEpoch !== this.activeVideoTimelineEpoch;
      const configChanged =
        s.decoderConfig &&
        !this.areDecoderConfigsEqual(s.decoderConfig, this.videoConfig);

      if (epochChanged || configChanged) {
        // Do not close a decoder while old-epoch frames are still visible.
        // Once drained, rebuild before the new keyframe so old references can
        // never corrupt the first pictures after a live splice.
        if (this.frameQueue.length > 0 || dec.decodeQueueSize > 0) break;
        // A new continuity epoch must start from a keyframe carrying a fresh
        // AVC description. Reusing the previous SPS/PPS is what turns a
        // delayed programme splice into a garbled picture.
        if (!s.key || (epochChanged && !s.decoderConfig)) {
          this.vIdx++;
          continue;
        }
        this.rebuildVideoDecoderForBoundary(s.decoderConfig);
        this.activeVideoTimelineEpoch = s.timelineEpoch;
        dec = this.videoDecoder;
        if (!dec || dec.state !== 'configured') return;
      } else if (this.activeVideoTimelineEpoch === null) {
        this.activeVideoTimelineEpoch = s.timelineEpoch;
      }

      if (dec.state !== 'configured') {
        if (!s.decoderConfig || !s.key) {
          this.vIdx++;
          continue;
        }
        this.configureVideoDecoder(s.decoderConfig);
        dec = this.videoDecoder;
        if (!dec || dec.state !== 'configured') return;
      }

      this.vIdx++;
      if (this.needVideoKey) {
        if (!s.key) continue;
        this.needVideoKey = false;
      }
      try {
        dec.decode(
          new EncodedVideoChunk({
            type: s.key ? 'key' : 'delta',
            timestamp: s.timestamp,
            duration: s.duration,
            data: s.data,
          })
        );
      } catch (e) {
        console.warn('[WebCodecsPlayer] video decode error:', e);
        this.recoverVideoDecoder(
          e instanceof Error ? e : new Error('视频帧解码失败')
        );
        break;
      }
    }
  }

  private pumpAudio() {
    let dec = this.audioDecoder;
    if (!dec) return;
    while (
      this.aIdx < this.encodedAudio.length &&
      dec.decodeQueueSize < (this.isLivePlaylist ? 24 : 32) &&
      this.decodedAudio.length + dec.decodeQueueSize <
        (this.isLivePlaylist ? 96 : 160)
    ) {
      const s = this.encodedAudio[this.aIdx];
      const epochChanged =
        this.activeAudioTimelineEpoch !== null &&
        s.timelineEpoch !== this.activeAudioTimelineEpoch;
      const configChanged =
        s.decoderConfig &&
        !this.areDecoderConfigsEqual(s.decoderConfig, this.audioConfig);
      if (epochChanged || configChanged) {
        if (this.decodedAudio.length > 0 || dec.decodeQueueSize > 0) break;
        this.rebuildAudioDecoderForBoundary(s.decoderConfig);
        this.activeAudioTimelineEpoch = s.timelineEpoch;
        dec = this.audioDecoder;
        if (!dec) return;
      } else if (this.activeAudioTimelineEpoch === null) {
        this.activeAudioTimelineEpoch = s.timelineEpoch;
      }

      if (dec.state !== 'configured') {
        if (!s.decoderConfig) {
          this.aIdx++;
          continue;
        }
        this.configureAudioDecoder(s.decoderConfig);
        dec = this.audioDecoder;
        if (!dec || dec.state !== 'configured') return;
      }

      this.aIdx++;
      try {
        dec.decode(
          new EncodedAudioChunk({
            type: 'key',
            timestamp: s.timestamp,
            duration: s.duration,
            data: s.data,
          })
        );
      } catch (e) {
        console.warn('[WebCodecsPlayer] audio decode error:', e);
      }
    }
  }

  private maybePrime() {
    const syncPolicy = getTeslaAvSyncPolicy(
      this.isLivePlaylist,
      this.playbackRate,
      this.canvasSized
    );
    const audioPipelineActive =
      this.audioConfig !== null ||
      this.debugStats.audioSamples > 0 ||
      this.encodedAudio.length > 0 ||
      this.decodedAudio.length > 0;
    if (
      this.frameQueue.length < syncPolicy.minVideoFrames ||
      (audioPipelineActive &&
        this.decodedAudio.length < syncPolicy.minAudioFrames) ||
      !this.audioCtx
    )
      return;

    const firstVideo = this.frameQueue[0];
    const firstAudio = this.decodedAudio[0];

    // Some live channels carry MP2 audio that this WebCodecs AAC pipeline
    // cannot decode. Start rendering video instead of holding a valid picture
    // behind an audio gate forever; AAC audio can still join when available.
    const firstVideoSec = firstVideo.timestamp / 1e6;
    const firstAudioSec = firstAudio
      ? firstAudio.timestamp / 1e6
      : firstVideoSec;
    this.baseMediaTime = chooseCommonAvStart(
      this.baseMediaTime,
      firstVideoSec,
      firstAudioSec
    );
    this.ctxStartTime = this.audioCtx.currentTime + 0.15;
    this.nextAudioStartTime = 0;

    if (this.wantPlaying) {
      this.resumeAudio();
    }
  }

  private resumeAudio() {
    if (!this.audioCtx) return;
    void claimTeslaAudioFocus();
    this.audioCtx
      .resume()
      .then(() => {
        if (this.audioCtx?.state === 'running' && this.state !== 'ended') {
          this.startNativePitchAudio();
          this.bufferingStartedAtMs = 0;
          this.lastRenderedAtMs = performance.now();
          this.lastAudioScheduledAtMs = performance.now();
          this.setState('playing');
        }
      })
      .catch((e) => console.warn('[WebCodecsPlayer] resume audio failed:', e));
  }

  private drawFirstFrame() {
    const f = this.frameQueue[0];
    if (f) this.drawFrameContained(f);
  }

  private drawFrameContained(frame: VideoFrame) {
    const width = Math.max(
      1,
      Math.floor(this.canvas.clientWidth || frame.displayWidth)
    );
    const height = Math.max(
      1,
      Math.floor(this.canvas.clientHeight || frame.displayHeight)
    );
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }

    const sourceWidth = frame.displayWidth || frame.codedWidth || width;
    const sourceHeight = frame.displayHeight || frame.codedHeight || height;
    const scale = Math.min(width / sourceWidth, height / sourceHeight);
    const drawWidth = Math.round(sourceWidth * scale);
    const drawHeight = Math.round(sourceHeight * scale);
    const x = Math.round((width - drawWidth) / 2);
    const y = Math.round((height - drawHeight) / 2);

    this.ctx.fillStyle = '#000';
    this.ctx.fillRect(0, 0, width, height);
    this.ctx.drawImage(frame, x, y, drawWidth, drawHeight);
    this.canvasSized = true;
    if (!this.firstVideoFrameReported) {
      this.firstVideoFrameReported = true;
      this.cb.onFirstVideoFrame?.();
    }
  }

  private canUseNativePitchPreservingAudio(): boolean {
    if (typeof HTMLMediaElement === 'undefined') return false;
    const proto: any = HTMLMediaElement.prototype;
    return (
      'preservesPitch' in proto ||
      'webkitPreservesPitch' in proto ||
      'mozPreservesPitch' in proto
    );
  }

  private configureNativePitchAudio(video: HTMLVideoElement) {
    video.volume = this.volume;
    video.muted = !this.useNativePitchPreservingAudio;
    if (!this.useNativePitchPreservingAudio) return;

    const media: any = video;
    media.preservesPitch = true;
    media.webkitPreservesPitch = true;
    media.mozPreservesPitch = true;
    video.defaultPlaybackRate = this.playbackRate;
    video.playbackRate = this.playbackRate;
  }

  private startNativePitchAudio() {
    if (!this.useNativePitchPreservingAudio || !this.hlsVideoEl) return;
    const video = this.hlsVideoEl;
    this.configureNativePitchAudio(video);

    const target = Math.max(0, this.baseMediaTime);
    try {
      if (Math.abs(video.currentTime - target) > 0.4)
        video.currentTime = target;
    } catch {}

    video.play().catch((e) => {
      // If a browser refuses this hidden-media path, retain audible playback
      // through the proven WebAudio scheduler rather than leaving the user silent.
      console.warn('[WebCodecsPlayer] native pitch audio unavailable:', e);
      this.useNativePitchPreservingAudio = false;
      video.muted = true;
    });
  }

  private getMediaTime(): number {
    // At non-1x the hidden HLS media is the audible, pitch-preserving path.
    // Drive Canvas from its real currentTime instead of a second estimated
    // AudioContext clock, so buffering and ad transitions cannot accumulate
    // an audio/video offset.
    if (
      this.useNativePitchPreservingAudio &&
      this.hlsVideoEl &&
      this.hlsVideoEl.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA &&
      !this.hlsVideoEl.paused
    ) {
      return this.hlsVideoEl.currentTime;
    }
    if (this.ctxStartTime === null || !this.audioCtx) return this.baseMediaTime;
    return (
      this.baseMediaTime +
      (this.audioCtx.currentTime - this.ctxStartTime) * this.playbackRate
    );
  }

  /**
   * Stable speed path: use the decoder's native AAC frame boundaries and one
   * ordinary AudioBufferSourceNode per frame. It is deliberately simple:
   * no buffering gate, no DSP search and no resampling work in RAF, so a
   * small timestamp discontinuity cannot silence the whole player.
   */
  private scheduleAudio() {
    if (this.useNativePitchPreservingAudio) return;
    if (this.ctxStartTime === null || !this.audioCtx || !this.gain) return;
    const now = this.audioCtx.currentTime;
    const syncPolicy = getTeslaAvSyncPolicy(
      this.isLivePlaylist,
      this.playbackRate,
      this.canvasSized
    );
    const maxLeadSec = syncPolicy.maxAudioLeadSec;
    if (
      this.nextAudioStartTime !== 0 &&
      this.nextAudioStartTime - now > maxLeadSec
    )
      return;

    let scheduled = 0;
    const maxChunks = this.isLivePlaylist
      ? 8
      : this.playbackRate === 1
      ? 24
      : 10;
    while (this.decodedAudio.length && scheduled < maxChunks) {
      const head = this.decodedAudio[0];
      const sampleRate = head.sampleRate;
      const channels = head.numberOfChannels;
      const headTs = head.timestamp / 1e6;
      const headDuration = head.numberOfFrames / sampleRate;
      const mediaNow = this.getMediaTime();

      if (headTs + headDuration < mediaNow - 0.08) {
        this.decodedAudio.shift();
        head.close();
        continue;
      }

      const startOffsetSec = Math.min(
        Math.max(0, mediaNow - headTs),
        headDuration
      );
      const audibleTs = headTs + startOffsetSec;
      const idealWhen =
        this.ctxStartTime +
        (audibleTs - this.baseMediaTime) / this.playbackRate;

      const scheduleFloor = now + syncPolicy.audioStartSafetySec;
      let when = Math.max(idealWhen, scheduleFloor);
      if (this.nextAudioStartTime !== 0) {
        const driftSec = idealWhen - this.nextAudioStartTime;
        if (shouldResetAudioSchedule(driftSec, this.isLivePlaylist)) {
          // A discontinuity or ad splice can reset TS timestamps. Never start
          // the new timeline while old future nodes are still scheduled: that
          // is the direct cause of overlapping voices after an ad boundary.
          for (const source of this.activeSources) {
            try {
              source.stop();
            } catch {}
          }
          this.activeSources.clear();
          this.nextAudioStartTime = 0;
          when = Math.max(idealWhen, scheduleFloor);
        } else {
          when = Math.max(this.nextAudioStartTime, scheduleFloor);
        }
      }
      if (when > now + maxLeadSec + 0.12) break;

      let buffer: AudioBuffer;
      try {
        buffer = this.audioCtx.createBuffer(
          channels,
          head.numberOfFrames,
          sampleRate
        );
        for (let channel = 0; channel < channels; channel++) {
          const dest = new Float32Array(head.numberOfFrames);
          head.copyTo(dest, { planeIndex: channel, format: 'f32-planar' });
          buffer.copyToChannel(dest, channel);
        }
      } finally {
        head.close();
        this.decodedAudio.shift();
      }

      this.scheduleAudioBuffer(buffer, when, startOffsetSec, this.playbackRate);
      this.lastAudioScheduledAtMs = performance.now();
      this.nextAudioStartTime =
        when + Math.max(0, headDuration - startOffsetSec) / this.playbackRate;
      scheduled++;
    }
  }

  /** Schedule one decoded AAC frame at the shared A/V rate. */
  private scheduleAudioBuffer(
    buffer: AudioBuffer,
    when: number,
    startOffsetSec = 0,
    rate = 1
  ) {
    if (!this.audioCtx || !this.gain) return;
    const src = this.audioCtx.createBufferSource();
    src.buffer = buffer;
    src.playbackRate.value = rate;
    src.connect(this.gain);
    src.start(when, startOffsetSec);
    this.activeSources.add(src);
    src.onended = () => this.activeSources.delete(src);
  }

  private presentVideo(clock: number) {
    let toDraw: VideoFrame | null = null;
    while (
      this.frameQueue.length &&
      this.frameQueue[0].timestamp / 1e6 <= clock
    ) {
      if (toDraw) {
        toDraw.close();
        this.droppedFrames++;
      }
      toDraw = this.frameQueue.shift()!;
    }
    if (toDraw) {
      this.lastRenderedMediaTime = toDraw.timestamp / 1e6;
      this.drawFrameContained(toDraw);
      toDraw.close();
      this.renderedFrames++;
      this.lastRenderedAtMs = performance.now();
    }
  }

  private getCurrentAvDriftAction(clock: number) {
    if (this.useNativePitchPreservingAudio || this.lastRenderedMediaTime <= 0)
      return 'none';
    const nextVideoPts = this.frameQueue[0]?.timestamp / 1e6;
    if (hasFutureVideoFrame(nextVideoPts, clock)) {
      // The current picture is intentionally held until this future VFR frame;
      // its age is not evidence that audio has drifted ahead.
      this.lastAvDriftSec = 0;
      return 'none';
    }
    const syncPolicy = getTeslaAvSyncPolicy(
      this.isLivePlaylist,
      this.playbackRate,
      this.canvasSized
    );
    const videoPipelinePending =
      (this.videoDecoder?.decodeQueueSize || 0) > 0 ||
      this.vIdx < this.encodedVideo.length;
    if (
      videoPipelinePending &&
      performance.now() - this.lastRenderedAtMs < syncPolicy.avDriftConfirmMs
    ) {
      this.lastAvDriftSec = Math.max(0, clock - this.lastRenderedMediaTime);
      return 'none';
    }
    this.lastAvDriftSec = clock - this.lastRenderedMediaTime;
    return getAvDriftAction(
      this.lastRenderedMediaTime,
      clock,
      this.isLivePlaylist
    );
  }

  private resetClockForAvDrift() {
    const now = performance.now();
    this.avSyncCorrections++;

    for (const source of this.activeSources) {
      try {
        source.stop();
      } catch {}
    }
    this.activeSources.clear();
    this.nextAudioStartTime = 0;
    this.baseMediaTime = Math.max(0, this.lastRenderedMediaTime);
    this.ctxStartTime = null;
    this.bufferingStartedAtMs = now;
    this.setState('buffering');
  }

  private reportTime(clock: number) {
    const now = performance.now();
    if (now - this.lastTimeReportMs < 250) return;
    this.lastTimeReportMs = now;

    // hls.js bases forward loading on the attached media element's currentTime.
    // Keep the hidden element near the real WebCodecs clock; otherwise loading
    // stops after its max buffer (the observed ~2 minute stall).
    if (
      this.hlsVideoEl &&
      !this.useNativePitchPreservingAudio &&
      now - this.lastHlsClockSyncMs >= 1000
    ) {
      this.lastHlsClockSyncMs = now;
      try {
        let syncTarget = clock;
        if (this.isLivePlaylist) {
          const details = this.hls?.latestLevelDetails;
          const firstFragment = details?.fragments?.[0];
          syncTarget = resolveLiveHiddenMediaTarget(
            clock,
            this.hls?.liveSyncPosition,
            details?.fragmentStart ?? firstFragment?.start,
            details?.edge
          );
        }
        if (Math.abs(this.hlsVideoEl.currentTime - syncTarget) > 1) {
          this.hlsVideoEl.currentTime = syncTarget;
        }
      } catch {}
    }

    this.cb.onTime?.(Math.min(clock, this.durationSec));
  }

  play() {
    this.wantPlaying = true;
    void claimTeslaAudioFocus();
    if (this.ctxStartTime === null) {
      if (this.audioCtx) this.audioCtx.resume().catch(() => {});
      return;
    }
    this.resumeAudio();
  }

  pause() {
    this.wantPlaying = false;
    if (this.audioCtx) this.audioCtx.suspend().catch(() => {});
    if (this.audioEl) this.audioEl.pause();
    if (this.useNativePitchPreservingAudio) this.hlsVideoEl?.pause();
    if (this.state !== 'ended' && this.state !== 'error')
      this.setState('paused');
    deferTeslaAudioFocusRelease(1200);
  }

  togglePlay() {
    if (this.state === 'playing') this.pause();
    else this.play();
  }

  setVolume(v: number) {
    this.volume = Math.max(0, Math.min(1, v));
    if (this.gain) this.gain.gain.value = this.volume;
    if (this.hlsVideoEl) this.hlsVideoEl.volume = this.volume;
  }

  setMuted(muted: boolean) {
    if (this.gain) this.gain.gain.value = muted ? 0 : this.volume;
    if (this.hlsVideoEl)
      this.hlsVideoEl.muted = muted || !this.useNativePitchPreservingAudio;
  }

  unmute() {
    if (this.gain) this.gain.gain.value = this.volume;
    if (this.hlsVideoEl && this.useNativePitchPreservingAudio)
      this.hlsVideoEl.muted = false;
  }

  isAudioActive(): boolean {
    if (!this.audioCtx) return true;
    return (
      this.audioCtx.state === 'running' && (this.gain?.gain.value || 0) > 0
    );
  }

  async ensureAudible(): Promise<boolean> {
    if (this.gain) this.gain.gain.value = this.volume;
    if (!this.audioCtx) return true;
    try {
      await claimTeslaAudioFocus();
      await this.audioCtx.resume();
      this.startNativePitchAudio();
      if (this.ctxStartTime !== null && this.state !== 'ended')
        this.setState('playing');
    } catch (e) {
      console.warn('[WebCodecsPlayer] audio activation failed:', e);
    }
    return this.audioCtx.state === 'running';
  }

  setPlaybackRate(rate: number) {
    const nextRate = Math.max(
      0.75,
      Math.min(2, Number.isFinite(rate) ? rate : 1)
    );
    if (Math.abs(nextRate - this.playbackRate) < 0.001) return;

    // A full reload from the current media time clears already scheduled
    // 1x/old-rate grains. That makes video, media clock and new audio timeline
    // start from the same keyframe instead of drifting after a rate change.
    const restartAt = Math.max(0, this.getMediaTime());
    this.playbackRate = nextRate;
    this.nextAudioStartTime = 0;
    for (const source of this.activeSources) {
      try {
        source.stop();
      } catch {}
    }
    this.activeSources.clear();

    if (!this.sourceUrl) return;
    this.wantPlaying = true;
    void this.load(this.sourceUrl, restartAt);
  }

  async seek(seconds: number) {
    if (this.liveHint || this.isLivePlaylist) {
      await this.restartLiveAtEdge('live-seek-redirected-to-edge');
      return;
    }
    const t = Math.max(0, Math.min(seconds, this.durationSec));
    const url = this.sourceUrl;
    if (!url) return;

    console.log('[WebCodecsPlayer] full pipeline seek to:', t);
    this.setState('buffering');
    await this.load(url, t);
  }

  private teardown() {
    if (this.raf) cancelAnimationFrame(this.raf);
    if (this.audioScheduleTimer !== null) {
      clearInterval(this.audioScheduleTimer);
      this.audioScheduleTimer = null;
    }
    if (this.hlsNetworkRecoveryTimer) {
      clearTimeout(this.hlsNetworkRecoveryTimer);
      this.hlsNetworkRecoveryTimer = null;
    }
    this.raf = 0;

    if (this.mp4AbortController) {
      this.mp4AbortController.abort();
      this.mp4AbortController = null;
    }
    if (this.mp4File) {
      try {
        this.mp4File.stop();
      } catch {}
      this.mp4File = null;
    }

    if (this.hls) {
      try {
        this.hls.destroy();
      } catch {}
      this.hls = null;
    }

    if (this.hlsVideoEl) {
      try {
        this.hlsVideoEl.pause();
      } catch {}
      this.hlsVideoEl.removeAttribute('src');
      this.hlsVideoEl.remove();
      this.hlsVideoEl = null;
    }

    for (const f of this.frameQueue) f.close();
    this.frameQueue = [];
    for (const d of this.decodedAudio) d.close();
    this.decodedAudio = [];
    this.encodedVideo = [];
    this.encodedAudio = [];
    this.vIdx = 0;
    this.aIdx = 0;
    this.canvasSized = false;
    this.audioRemainder = new Uint8Array(0);
    this.nextAudioPtsSec = null;
    this.spsNalu = null;
    this.ppsNalu = null;
    this.parsedVideoConfig = null;
    this.parsedAudioConfig = null;
    this.activeVideoTimelineEpoch = null;
    this.activeAudioTimelineEpoch = null;

    try {
      if (this.videoDecoder && this.videoDecoder.state !== 'closed')
        this.videoDecoder.close();
    } catch {}
    try {
      if (this.audioDecoder && this.audioDecoder.state !== 'closed')
        this.audioDecoder.close();
    } catch {}
    this.videoDecoder = null;
    this.audioDecoder = null;

    for (const src of this.activeSources) {
      try {
        src.stop();
      } catch {}
    }
    this.activeSources.clear();

    this.packetStream = null;
    this.parseStream = null;
    this.elementaryStream = null;
  }

  private teardownAudioGraph() {
    for (const src of this.activeSources) {
      try {
        src.stop();
      } catch {}
    }
    this.activeSources.clear();

    if (this.audioEl) {
      this.audioEl.pause();
      this.audioEl.srcObject = null;
      this.audioEl.remove();
      this.audioEl = null;
    }

    if (this.gain) {
      try {
        this.gain.gain.value = 0;
        this.gain.disconnect();
      } catch {}
    }
    // The AudioContext is owned by the page-level audio session. Keep it alive
    // so a source switch does not discard the user's sound unlock.
    this.audioCtx = null;
    this.gain = null;
    this.mediaDest = null;
    this.nextAudioStartTime = 0;
  }

  destroy() {
    this.destroyed = true;
    this.loadGeneration++;
    this.sourceUrl = '';
    this.teardown();
    this.teardownAudioGraph();
    this.setState('idle');
    // A reconnect destroys and recreates the player. Delay release so the next
    // instance can cancel it without yielding focus to another vehicle app.
    deferTeslaAudioFocusRelease(2500);
  }

  getState(): PlayerState {
    return this.state;
  }

  getCurrentTime(): number {
    return this.getMediaTime();
  }

  getDuration(): number {
    return this.durationSec;
  }

  setShowDebug(show: boolean) {
    this.showDebug = show;
  }

  getStats() {
    const now = performance.now();
    const dt = Math.max(1, now - this.statsMark.t) / 1000;
    const renderFps = (this.renderedFrames - this.statsMark.rendered) / dt;
    const decodeFps = (this.decodedFrames - this.statsMark.decoded) / dt;
    this.statsMark = {
      t: now,
      rendered: this.renderedFrames,
      decoded: this.decodedFrames,
    };

    const clock = this.getMediaTime();
    return {
      state: this.state,
      renderFps: Math.round(renderFps),
      decodeFps: Math.round(decodeFps),
      queued: this.frameQueue.length,
      decodeQueue: this.videoDecoder?.decodeQueueSize ?? 0,
      dropped: this.droppedFrames,
      resolution: this.videoConfig
        ? `${this.videoConfig.codedWidth}x${this.videoConfig.codedHeight}`
        : '',
      codec: this.videoConfig?.codec ?? '',
      currentSec: +clock.toFixed(1),
      decodedFrames: this.decodedFrames,
      renderedFrames: this.renderedFrames,
      demuxVideoQueue: this.encodedVideo.length - this.vIdx,
      demuxAudioQueue: this.encodedAudio.length - this.aIdx,
      audioCtx: this.audioCtx?.state ?? 'none',
      audioLeadMs: this.audioCtx
        ? Math.max(
            0,
            Math.round(
              (this.nextAudioStartTime - this.audioCtx.currentTime) * 1000
            )
          )
        : 0,
      videoDecoderRecoveries: this.videoDecoderRecoveryCount,
      avDriftMs: Math.round(this.lastAvDriftSec * 1000),
      avSyncCorrections: this.avSyncCorrections,
      fragmentDuplicateDrops: this.debugStats.fragmentDuplicateDrops,
      fragmentStaleDrops: this.debugStats.fragmentStaleDrops,
      lastRecoveryReason: this.debugStats.lastRecoveryReason,
    };
  }

  private setState(s: PlayerState) {
    if (this.state === s) return;
    this.state = s;
    this.cb.onStateChange?.(s);
  }

  private fail(message: string) {
    console.error('[WebCodecsPlayer] fail:', message);
    this.debugStats.error = message;
    this.cb.onError?.(message);
    this.setState('error');
  }

  private findSegIndex(seconds: number): number {
    for (let i = 0; i < this.segments.length; i++) {
      const seg = this.segments[i];
      if (seg.startTime + seg.duration > seconds) {
        return Math.max(0, i);
      }
    }
    return Math.max(0, this.segments.length - 1);
  }

  private splitNalus(data: Uint8Array): Uint8Array[] {
    const nalus: Uint8Array[] = [];
    let i = 0;
    const len = data.length;

    while (i < len) {
      let startCodeLen = 0;
      if (
        i + 4 <= len &&
        data[i] === 0 &&
        data[i + 1] === 0 &&
        data[i + 2] === 0 &&
        data[i + 3] === 1
      ) {
        startCodeLen = 4;
      } else if (
        i + 3 <= len &&
        data[i] === 0 &&
        data[i + 1] === 0 &&
        data[i + 2] === 1
      ) {
        startCodeLen = 3;
      }

      if (startCodeLen > 0) {
        const start = i;
        i += startCodeLen;
        let end = i;
        while (end < len) {
          if (
            end + 4 <= len &&
            data[end] === 0 &&
            data[end + 1] === 0 &&
            data[end + 2] === 0 &&
            data[end + 3] === 1
          )
            break;
          if (
            end + 3 <= len &&
            data[end] === 0 &&
            data[end + 1] === 0 &&
            data[end + 2] === 1
          )
            break;
          end++;
        }
        nalus.push(data.subarray(start, end));
        i = end;
      } else {
        i++;
      }
    }

    return nalus;
  }

  private getNaluType(nalu: Uint8Array): number {
    let startCodeLen = 0;
    if (nalu[0] === 0 && nalu[1] === 0 && nalu[2] === 0 && nalu[3] === 1)
      startCodeLen = 4;
    else if (nalu[0] === 0 && nalu[1] === 0 && nalu[2] === 1) startCodeLen = 3;
    if (nalu.length <= startCodeLen) return 0;
    return nalu[startCodeLen] & 0x1f;
  }

  private nalusToAvcc(nalus: Uint8Array[]): Uint8Array {
    let totalLen = 0;
    const raws: Uint8Array[] = [];
    for (const nalu of nalus) {
      const raw = this.stripStartCode(nalu);
      raws.push(raw);
      totalLen += 4 + raw.length;
    }
    const result = new Uint8Array(totalLen);
    let offset = 0;
    for (const raw of raws) {
      result[offset] = (raw.length >> 24) & 0xff;
      result[offset + 1] = (raw.length >> 16) & 0xff;
      result[offset + 2] = (raw.length >> 8) & 0xff;
      result[offset + 3] = raw.length & 0xff;
      result.set(raw, offset + 4);
      offset += 4 + raw.length;
    }
    return result;
  }

  private buildVideoConfig(sps: Uint8Array, pps: Uint8Array) {
    let spsOffset = 0;
    if (sps[0] === 0 && sps[1] === 0 && sps[2] === 0 && sps[3] === 1)
      spsOffset = 4;
    else if (sps[0] === 0 && sps[1] === 0 && sps[2] === 1) spsOffset = 3;

    const profileIdc = sps[spsOffset + 1];
    const profileCompat = sps[spsOffset + 2];
    const levelIdc = sps[spsOffset + 3];
    const codec = `avc1.${this.hex(profileIdc)}${this.hex(
      profileCompat
    )}${this.hex(levelIdc)}`;

    const spsRaw = this.stripStartCode(sps);
    const ppsRaw = this.stripStartCode(pps);
    const description = new Uint8Array(11 + spsRaw.length + ppsRaw.length);
    let i = 0;
    description[i++] = 1;
    description[i++] = profileIdc;
    description[i++] = profileCompat;
    description[i++] = levelIdc;
    description[i++] = 0xff;
    description[i++] = 0xe1;
    description[i++] = (spsRaw.length >> 8) & 0xff;
    description[i++] = spsRaw.length & 0xff;
    description.set(spsRaw, i);
    i += spsRaw.length;
    description[i++] = 1;
    description[i++] = (ppsRaw.length >> 8) & 0xff;
    description[i++] = ppsRaw.length & 0xff;
    description.set(ppsRaw, i);

    return {
      kind: 'video',
      codec,
      codedWidth: 1920,
      codedHeight: 1080,
      description,
    };
  }

  private hex(b: number): string {
    return b.toString(16).padStart(2, '0').toUpperCase();
  }

  private stripStartCode(nalu: Uint8Array): Uint8Array {
    if (nalu[0] === 0 && nalu[1] === 0 && nalu[2] === 0 && nalu[3] === 1)
      return nalu.subarray(4);
    if (nalu[0] === 0 && nalu[1] === 0 && nalu[2] === 1)
      return nalu.subarray(3);
    return nalu;
  }

  private extractAdtsFrames(data: Uint8Array): {
    frames: Uint8Array[];
    remainder: Uint8Array;
  } {
    const frames: Uint8Array[] = [];
    let i = 0;

    while (i + 7 <= data.length) {
      if (data[i] !== 0xff || (data[i + 1] & 0xf0) !== 0xf0) {
        i++;
        continue;
      }

      const headerLength = (data[i + 1] & 0x01) === 1 ? 7 : 9;
      if (i + headerLength > data.length) break;
      const frameLength =
        ((data[i + 3] & 0x03) << 11) |
        (data[i + 4] << 3) |
        ((data[i + 5] & 0xe0) >> 5);

      if (frameLength < headerLength || frameLength > 8191) {
        i++;
        continue;
      }
      if (i + frameLength > data.length) {
        return { frames, remainder: data.slice(i) };
      }

      frames.push(data.subarray(i, i + frameLength));
      i += frameLength;
    }

    const remainder =
      i < data.length
        ? data.slice(Math.max(i, data.length - 8191))
        : new Uint8Array(0);
    return { frames, remainder };
  }

  private isTransportStreamPayload(data: Uint8Array): boolean {
    const limit = Math.min(188, data.length);
    for (let offset = 0; offset < limit; offset++) {
      if (data[offset] !== 0x47) continue;
      if (offset + 188 >= data.length || data[offset + 188] === 0x47)
        return true;
    }
    return false;
  }

  private parseAdts(
    data: Uint8Array
  ): { sampleRate: number; channels: number; profile: number } | null {
    if (data[0] !== 0xff || (data[1] & 0xf0) !== 0xf0) return null;
    const sampleRates = [
      96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000,
      11025, 8000, 7350,
    ];
    const profile = ((data[2] & 0xc0) >> 6) + 1;
    const sampleRateIdx = (data[2] & 0x3c) >> 2;
    const channels = ((data[2] & 0x01) << 2) | ((data[3] & 0xc0) >> 6);
    return {
      sampleRate: sampleRates[sampleRateIdx] || 44100,
      channels,
      profile,
    };
  }

  private buildAacConfig(
    sampleRate: number,
    channels: number,
    profile: number
  ): Uint8Array {
    const sampleRates = [
      96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000,
      11025, 8000, 7350,
    ];
    let sampleRateIdx = sampleRates.indexOf(sampleRate);
    if (sampleRateIdx < 0) sampleRateIdx = 4;
    const audioObjectType = profile || 2;
    const asc = new Uint8Array(2);
    asc[0] = (audioObjectType << 3) | (sampleRateIdx >> 1);
    asc[1] = ((sampleRateIdx & 0x01) << 7) | (channels << 3);
    return asc;
  }
}
