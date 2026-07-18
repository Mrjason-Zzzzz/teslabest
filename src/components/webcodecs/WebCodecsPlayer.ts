// @ts-nocheck
import { HLSTSDemuxer } from './HLSTSDemuxer';

export type PlayerState = 'idle' | 'buffering' | 'playing' | 'paused' | 'ended' | 'error';

export interface PlayerCallbacks {
  onTime?: (currentSec: number) => void;
  onDurationChange?: (durationSec: number) => void;
  onStateChange?: (state: PlayerState) => void;
  onError?: (message: string) => void;
}

export class WebCodecsPlayer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private cb: PlayerCallbacks;

  private demuxer: HLSTSDemuxer | null = null;

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
  private durationSec = 0;
  private wantPlaying = true;
  private destroyed = false;
  private raf = 0;
  private canvasSized = false;
  private showDebug = false;
  private lastFrameDrawn = false;
  private needVideoKey = true;
  private lastVideoOutputAt = 0;
  private lastTimeReportMs = 0;

  private renderedFrames = 0;
  private decodedFrames = 0;
  private droppedFrames = 0;
  private statsMark = { t: 0, rendered: 0, decoded: 0 };

  private audioCtx: AudioContext | null = null;
  private gain: GainNode | null = null;
  private mediaDest: MediaStreamAudioDestinationNode | null = null;
  private audioEl: HTMLAudioElement | null = null;
  private activeSources = new Set<AudioBufferSourceNode>();
  private baseMediaTime = 0;
  private ctxStartTime: number | null = null;
  private lastAudioScheduledSec = 0;
  private nextAudioStartTime = 0;
  private volume = 1;

  private demuxerStats: any = {
    m3u8Loaded: false,
    segmentCount: 0,
    segmentsDownloaded: 0,
    videoSamples: 0,
    audioSamples: 0,
    error: '',
  };

  constructor(canvas: HTMLCanvasElement, cb: PlayerCallbacks = {}) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('2d canvas context unavailable');
    this.ctx = ctx;
    this.cb = cb;

    if (!canvas.width || !canvas.height) {
      canvas.width = 1280;
      canvas.height = 720;
    }
  }

  static isSupported(): boolean {
    return typeof VideoDecoder === 'function' && typeof AudioDecoder === 'function';
  }

  async load(url: string, startAt = 0): Promise<void> {
    this.teardownPipeline();
    this.baseMediaTime = startAt;
    this.ctxStartTime = null;
    this.lastAudioScheduledSec = 0;
    this.nextAudioStartTime = 0;
    this.lastVideoOutputAt = performance.now();
    this.renderedFrames = 0;
    this.decodedFrames = 0;
    this.droppedFrames = 0;
    this.statsMark = { t: performance.now(), rendered: 0, decoded: 0 };
    this.setState('buffering');
    console.log('[WebCodecsPlayer] load url=' + url + ' startAt=' + startAt);

    this.setupAudioGraph();
    this.setupDecoders();

    const demuxer = new HLSTSDemuxer({
      url,
      onVideoConfig: (config) => {
        console.log('[WebCodecsPlayer] video config:', config.codec, config.codedWidth + 'x' + config.codedHeight);
        this.videoConfig = config;
        try {
          const cfg: any = {
            codec: config.codec,
            codedWidth: config.codedWidth,
            codedHeight: config.codedHeight,
            optimizeForLatency: false,
          };
          if (config.description) cfg.description = config.description;
          this.videoDecoder?.configure(cfg);
        } catch (e) {
          console.warn('[WebCodecsPlayer] video decoder configure failed:', e);
        }
      },
      onAudioConfig: (config) => {
        console.log('[WebCodecsPlayer] audio config:', config.codec, config.sampleRate + 'Hz', config.numberOfChannels + 'ch');
        this.audioConfig = config;
        try {
          const cfg: any = {
            codec: config.codec,
            sampleRate: config.sampleRate,
            numberOfChannels: config.numberOfChannels,
          };
          if (config.description) cfg.description = config.description;
          this.audioDecoder?.configure(cfg);
        } catch (e) {
          console.warn('[WebCodecsPlayer] audio decoder configure failed:', e);
        }
      },
      onVideoSample: (sample) => {
        this.encodedVideo.push(sample);
      },
      onAudioSample: (sample) => {
        this.encodedAudio.push(sample);
      },
      onDuration: (dur) => {
        console.log('[WebCodecsPlayer] duration:', dur);
        this.durationSec = dur;
        this.cb.onDurationChange?.(dur);
      },
      onError: (e) => {
        console.error('[WebCodecsPlayer] demuxer error:', e);
        this.fail('demuxer: ' + String(e));
      },
    });

    this.demuxer = demuxer;
    demuxer.start(startAt).catch((e) => {
      this.fail('demuxer start: ' + String(e));
    });

    this.loop();
  }

  private setupDecoders() {
    this.needVideoKey = true;
    this.videoDecoder = new VideoDecoder({
      output: (frame) => this.onVideoFrame(frame),
      error: (e) => this.fail('video decoder: ' + e.message),
    });
    this.audioDecoder = new AudioDecoder({
      output: (data) => this.decodedAudio.push(data),
      error: (e) => this.fail('audio decoder: ' + e.message),
    });
  }

  private setupAudioGraph() {
    const Ctor = (window as any).AudioContext || (window as any).webkitAudioContext;
    if (!Ctor) return;

    const ctx = new Ctor({ latencyHint: 'playback' });
    this.audioCtx = ctx;
    this.gain = ctx.createGain();
    this.gain.gain.value = this.volume;
    this.mediaDest = ctx.createMediaStreamDestination();
    this.gain.connect(this.mediaDest);

    const audioEl = document.createElement('audio');
    audioEl.srcObject = this.mediaDest.stream;
    audioEl.style.display = 'none';
    document.body.appendChild(audioEl);
    this.audioEl = audioEl;
  }

  private onVideoFrame(frame: VideoFrame) {
    this.lastVideoOutputAt = performance.now();
    this.decodedFrames++;
    if (!this.canvasSized) {
      this.canvas.width = frame.displayWidth;
      this.canvas.height = frame.displayHeight;
      this.canvasSized = true;
    }
    this.frameQueue.push(frame);
  }

  private loop = () => {
    this.tick();
    this.raf = requestAnimationFrame(this.loop);
  };

  private tick() {
    try {
      this.updateDemuxerStats();
      this.pumpVideo();
      this.pumpAudio();

      if (this.ctxStartTime === null) {
        this.maybePrime();
        this.drawFirstFrame();
      } else {
        this.scheduleAudio();
        const clock = this.getMediaTime();
        this.presentVideo(clock);
        this.reportTime(clock);
        this.maybePauseDemuxer();
      }

      if (this.showDebug) {
        this.drawDebugOverlay();
      }
    } catch (e) {
      console.error('[WebCodecsPlayer] tick error:', e);
    }
  }

  private updateDemuxerStats() {
    if (this.demuxer) {
      this.demuxerStats = this.demuxer.getStats();
    }
  }

  private pumpVideo() {
    const dec = this.videoDecoder;
    if (!dec || dec.state !== 'configured') return;
    const MAX_OUTSTANDING = 30;
    while (
      this.vIdx < this.encodedVideo.length &&
      this.frameQueue.length + dec.decodeQueueSize < MAX_OUTSTANDING
    ) {
      const s = this.encodedVideo[this.vIdx++];
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
          }),
        );
      } catch (e) {
        console.warn('[WebCodecsPlayer] video decode error:', e);
        this.needVideoKey = true;
      }
    }
  }

  private pumpAudio() {
    const dec = this.audioDecoder;
    if (!dec || dec.state !== 'configured') return;
    while (
      this.aIdx < this.encodedAudio.length &&
      dec.decodeQueueSize < 64
    ) {
      const s = this.encodedAudio[this.aIdx++];
      try {
        dec.decode(
          new EncodedAudioChunk({
            type: 'key',
            timestamp: s.timestamp,
            duration: s.duration,
            data: s.data,
          }),
        );
      } catch (e) {
        console.warn('[WebCodecsPlayer] audio decode error:', e);
      }
    }
  }

  private maybePrime() {
    const haveVideo = this.frameQueue.length > 0;
    const haveAudio = this.decodedAudio.length > 0;
    if (!haveVideo || !haveAudio) return;

    this.ctxStartTime = this.audioCtx!.currentTime + 0.1;
    if (this.wantPlaying) {
      this.resumeAudio();
    }
  }

  private resumeAudio() {
    if (!this.audioCtx || !this.audioEl) return;
    Promise.all([this.audioCtx.resume(), this.audioEl.play()])
      .then(() => {
        if (this.audioCtx?.state === 'running' && !this.audioEl?.paused) {
          if (this.state !== 'ended') this.setState('playing');
        }
      })
      .catch((e) => console.warn('[WebCodecsPlayer] resume audio failed:', e));
  }

  private drawFirstFrame() {
    const f = this.frameQueue[0];
    if (f) {
      this.ctx.drawImage(f, 0, 0, this.canvas.width, this.canvas.height);
      this.lastFrameDrawn = true;
    }
  }

  private getMediaTime(): number {
    if (this.ctxStartTime === null || !this.audioCtx) return this.baseMediaTime;
    return this.baseMediaTime + (this.audioCtx.currentTime - this.ctxStartTime);
  }

  private scheduleAudio() {
    if (this.ctxStartTime === null || !this.audioCtx || !this.gain) return;
    const now = this.audioCtx.currentTime;
    if (this.nextAudioStartTime !== 0 && this.nextAudioStartTime - now > 4) return;

    while (this.decodedAudio.length) {
      const head = this.decodedAudio[0];
      const rate = head.sampleRate;
      const channels = head.numberOfChannels;
      const headTs = head.timestamp / 1e6;
      const headDuration = head.numberOfFrames / rate;

      let startOffsetSec = 0;
      if (this.nextAudioStartTime === 0) {
        if (headTs + headDuration <= this.baseMediaTime) {
          this.decodedAudio.shift();
          head.close();
          continue;
        }
        startOffsetSec = Math.min(Math.max(0, this.baseMediaTime - headTs), headDuration);
      }

      const audibleTs = headTs + startOffsetSec;
      const idealWhen = this.ctxStartTime + (audibleTs - this.baseMediaTime);
      let when: number;
      if (this.nextAudioStartTime === 0) {
        when = Math.max(idealWhen, now + 0.02);
      } else {
        when = this.nextAudioStartTime;
        if (when < now) {
          when = now + 0.05;
        }
      }

      if (when > now + 6) break;

      const frames = head.numberOfFrames;
      let buffer: AudioBuffer;
      try {
        buffer = this.audioCtx.createBuffer(channels, frames, rate);
        const channelData = Array.from({ length: channels }, () => new Float32Array(frames));
        for (let ch = 0; ch < channels; ch++) {
          const dest = channelData[ch];
          head.copyTo(dest, { planeIndex: ch, format: 'f32-planar' });
          buffer.copyToChannel(dest, ch);
        }
      } finally {
        head.close();
        this.decodedAudio.shift();
      }

      const src = this.audioCtx.createBufferSource();
      src.buffer = buffer;
      src.connect(this.gain);
      src.start(when, startOffsetSec);
      this.activeSources.add(src);
      src.onended = () => this.activeSources.delete(src);
      this.nextAudioStartTime = when + (frames / rate - startOffsetSec);
      this.lastAudioScheduledSec = headTs + headDuration;
    }
  }

  private presentVideo(clock: number) {
    let toDraw: VideoFrame | null = null;
    while (this.frameQueue.length && this.frameQueue[0].timestamp / 1e6 <= clock) {
      if (toDraw) {
        toDraw.close();
        this.droppedFrames++;
      }
      toDraw = this.frameQueue.shift()!;
    }
    if (toDraw) {
      this.ctx.drawImage(toDraw, 0, 0, this.canvas.width, this.canvas.height);
      toDraw.close();
      this.renderedFrames++;
      this.lastFrameDrawn = true;
    }
  }

  private maybePauseDemuxer() {
    if (!this.demuxer) return;
    const videoQueued = this.encodedVideo.length - this.vIdx;
    const audioQueued = this.encodedAudio.length - this.aIdx;
    const MAX_QUEUED = 200;
    if (videoQueued > MAX_QUEUED || audioQueued > MAX_QUEUED * 2) {
      this.demuxer.pause();
    } else if (videoQueued < 30) {
      this.demuxer.resume();
    }
  }

  private reportTime(clock: number) {
    const now = performance.now();
    if (now - this.lastTimeReportMs < 250) return;
    this.lastTimeReportMs = now;
    this.cb.onTime?.(Math.min(clock, this.durationSec));
  }

  private drawDebugOverlay() {
    const stats = this.getStats();
    const ctx = this.ctx;
    const w = this.canvas.width || 640;
    ctx.save();
    ctx.fillStyle = 'rgba(0, 0, 0, 0.8)';
    ctx.fillRect(0, 0, w, 520);
    ctx.fillStyle = '#0f0';
    ctx.font = '13px monospace';
    const ds = this.demuxerStats;
    const lines = [
      `[WC] state: ${stats.state}`,
      `[WC] render: ${stats.renderFps} fps  decode: ${stats.decodeFps} fps`,
      `[WC] frameQueue: ${stats.queued}  inDecode: ${stats.decodeQueue}  dropped: ${stats.dropped}`,
      `[WC] ${stats.resolution} ${stats.codec}`,
      `[WC] t=${stats.currentSec}s  duration=${this.durationSec.toFixed(1)}s`,
      `[WC] decoded=${stats.decodedFrames} rendered=${stats.renderedFrames}`,
      `[WC] demux vQ: ${stats.demuxVideoQueue}  aQ: ${stats.demuxAudioQueue}`,
      `[WC] vCfg: ${this.videoConfig ? 'OK' : 'no'}  aCfg: ${this.audioConfig ? 'OK' : 'no'}`,
      `--- Demuxer ---`,
      `  m3u8: ${ds.m3u8Loaded ? 'OK' : 'pending'}  master: ${ds.isMasterPlaylist ? 'yes' : 'no'}`,
      `  segs: ${ds.segmentCount}  downloaded: ${ds.segmentsDownloaded}`,
      `  bytes: ${(ds.bytesDownloaded / 1024 / 1024).toFixed(2)}MB`,
      `  pmt: ${ds.pmtFound ? 'found' : 'waiting'}  vPES: ${ds.videoPesCount}  aPES: ${ds.audioPesCount}`,
      `  video samples: ${ds.videoSamples}  audio samples: ${ds.audioSamples}`,
      `  audioCtx: ${this.audioCtx?.state || 'none'}`,
      ds.error ? `  ERROR: ${ds.error}` : '',
      ds.lastError && ds.lastError !== ds.error ? `  lastErr: ${ds.lastError}` : '',
      ds.m3u8Preview ? `  m3u8: ${ds.m3u8Preview.slice(0, 80)}` : '',
    ].filter(Boolean);
    lines.forEach((line, i) => {
      ctx.fillText(line, 10, 18 + i * 16);
    });
    ctx.restore();
  }

  play() {
    this.wantPlaying = true;
    if (this.ctxStartTime === null) {
      if (this.audioCtx) this.audioCtx.resume().catch(() => {});
      if (this.audioEl) this.audioEl.play().catch(() => {});
      return;
    }
    this.resumeAudio();
  }

  pause() {
    this.wantPlaying = false;
    if (this.audioCtx) this.audioCtx.suspend().catch(() => {});
    if (this.audioEl) this.audioEl.pause();
    if (this.state !== 'ended' && this.state !== 'error') this.setState('paused');
  }

  togglePlay() {
    if (this.state === 'playing') this.pause();
    else this.play();
  }

  setVolume(v: number) {
    this.volume = Math.max(0, Math.min(1, v));
    if (this.gain) this.gain.gain.value = this.volume;
  }

  async seek(seconds: number) {
    const t = Math.max(0, Math.min(seconds, this.durationSec));

    this.encodedVideo = [];
    this.encodedAudio = [];
    this.vIdx = 0;
    this.aIdx = 0;
    this.needVideoKey = true;
    this.baseMediaTime = t;
    this.ctxStartTime = null;
    this.nextAudioStartTime = 0;

    for (const f of this.frameQueue) f.close();
    this.frameQueue = [];
    for (const d of this.decodedAudio) d.close();
    this.decodedAudio = [];

    try { this.videoDecoder?.reset(); } catch {}
    try { this.audioDecoder?.reset(); } catch {}
    if (this.videoConfig) {
      try {
        const config: any = {
          codec: this.videoConfig.codec,
          codedWidth: this.videoConfig.codedWidth,
          codedHeight: this.videoConfig.codedHeight,
        };
        if (this.videoConfig.description) config.description = this.videoConfig.description;
        this.videoDecoder?.configure(config);
      } catch {}
    }
    if (this.audioConfig) {
      try {
        const config: any = {
          codec: this.audioConfig.codec,
          sampleRate: this.audioConfig.sampleRate,
          numberOfChannels: this.audioConfig.numberOfChannels,
        };
        if (this.audioConfig.description) config.description = this.audioConfig.description;
        this.audioDecoder?.configure(config);
      } catch {}
    }

    if (this.demuxer) {
      this.demuxer.seekTo(t);
      this.demuxer.resume();
    }

    this.setState('buffering');
  }

  private teardownPipeline() {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;

    if (this.demuxer) {
      this.demuxer.destroy();
      this.demuxer = null;
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

    try {
      if (this.videoDecoder && this.videoDecoder.state !== 'closed') this.videoDecoder.close();
    } catch {}
    try {
      if (this.audioDecoder && this.audioDecoder.state !== 'closed') this.audioDecoder.close();
    } catch {}
    this.videoDecoder = null;
    this.audioDecoder = null;

    for (const src of this.activeSources) {
      try { src.stop(); } catch {}
    }
    this.activeSources.clear();
  }

  destroy() {
    this.destroyed = true;
    this.teardownPipeline();
    if (this.audioEl) {
      this.audioEl.pause();
      this.audioEl.srcObject = null;
      this.audioEl.remove();
      this.audioEl = null;
    }
    if (this.audioCtx) {
      this.audioCtx.close().catch(() => {});
      this.audioCtx = null;
    }
    this.setState('idle');
  }

  getState(): PlayerState {
    return this.state;
  }

  setShowDebug(show: boolean) {
    this.showDebug = show;
  }

  getStats() {
    const now = performance.now();
    const dt = Math.max(1, now - this.statsMark.t) / 1000;
    const renderFps = (this.renderedFrames - this.statsMark.rendered) / dt;
    const decodeFps = (this.decodedFrames - this.statsMark.decoded) / dt;
    this.statsMark = { t: now, rendered: this.renderedFrames, decoded: this.decodedFrames };

    const clock = this.getMediaTime();
    return {
      state: this.state,
      renderFps: Math.round(renderFps),
      decodeFps: Math.round(decodeFps),
      queued: this.frameQueue.length,
      decodeQueue: this.videoDecoder?.decodeQueueSize ?? 0,
      dropped: this.droppedFrames,
      bufferedVideoSec: 0,
      bufferedAudioSec: 0,
      resolution: this.videoConfig ? `${this.videoConfig.codedWidth}x${this.videoConfig.codedHeight}` : '',
      codec: this.videoConfig?.codec ?? '',
      currentSec: +clock.toFixed(1),
      decodedFrames: this.decodedFrames,
      renderedFrames: this.renderedFrames,
      demuxVideoQueue: this.encodedVideo.length - this.vIdx,
      demuxAudioQueue: this.encodedAudio.length - this.aIdx,
    };
  }

  private setState(s: PlayerState) {
    if (this.state === s) return;
    this.state = s;
    this.cb.onStateChange?.(s);
  }

  private fail(message: string) {
    console.error('[WebCodecsPlayer] fail:', message);
    this.cb.onError?.(message);
    this.setState('error');
  }
}
