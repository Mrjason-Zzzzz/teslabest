// @ts-nocheck
import Hls from 'hls.js';
import * as muxjs from 'mux.js';

export type PlayerState = 'idle' | 'buffering' | 'playing' | 'paused' | 'ended' | 'error';

export interface PlayerCallbacks {
  onTime?: (currentSec: number) => void;
  onDurationChange?: (durationSec: number) => void;
  onStateChange?: (state: PlayerState) => void;
  onError?: (message: string) => void;
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
  private segments: Segment[] = [];
  private currentSegIndex = 0;
  private durationSec = 0;
  private downloading = false;

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
  private canvasSized = false;
  private showDebug = false;
  private needVideoKey = true;
  private lastTimeReportMs = 0;

  private spsNalu: Uint8Array | null = null;
  private ppsNalu: Uint8Array | null = null;

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
  private nextAudioStartTime = 0;
  private volume = 1;

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
    this.teardown();
    this.baseMediaTime = startAt;
    this.ctxStartTime = null;
    this.nextAudioStartTime = 0;
    this.renderedFrames = 0;
    this.decodedFrames = 0;
    this.droppedFrames = 0;
    this.statsMark = { t: performance.now(), rendered: 0, decoded: 0 };
    this.setState('buffering');
    console.log('[WebCodecsPlayer] load url=' + url + ' startAt=' + startAt);

    this.setupAudioGraph();
    this.setupDecoders();
    this.initDemuxPipeline();

    if (!Hls.isSupported()) {
      this.fail('hls.js not supported');
      return;
    }

    const hls = new Hls({
      enableWorker: false,
      lowLatencyMode: false,
      autoStartLoad: true,
      startPosition: startAt,
    });

    this.hls = hls;

    hls.on(Hls.Events.MANIFEST_PARSED, (_evt: any, data: any) => {
      this.debugStats.hlsState = 'manifest-parsed';
      this.debugStats.levelCount = data.levels?.length || 0;
      console.log('[WebCodecsPlayer] MANIFEST_PARSED, levels:', data.levels?.length);
    });

    hls.on(Hls.Events.LEVEL_LOADED, (_evt: any, data: any) => {
      const details = data.details;
      this.debugStats.hlsState = 'level-loaded';
      this.debugStats.currentLevel = data.level;

      if (details && details.fragments && details.fragments.length > 0) {
        this.segments = details.fragments.map((f: any) => ({
          url: f.url,
          duration: f.duration,
          startTime: f.start,
        }));
        this.durationSec = details.totalduration || this.segments.reduce((s, f) => s + f.duration, 0);
        this.cb.onDurationChange?.(this.durationSec);

        if (this.currentSegIndex === 0 && startAt > 0) {
          this.currentSegIndex = this.findSegIndex(startAt);
          this.baseMediaTime = startAt;
        }

        console.log('[WebCodecsPlayer] LEVEL_LOADED, segments:', this.segments.length, 'duration:', this.durationSec);
      }
    });

    hls.on(Hls.Events.FRAG_LOADED, (_evt: any, data: any) => {
      this.debugStats.fragLoaded++;
      const payload = data.frag?.data || data.payload;
      if (payload && payload.byteLength) {
        this.debugStats.bytesLoaded += payload.byteLength;
        this.feedTsData(new Uint8Array(payload));
      }
    });

    hls.on(Hls.Events.ERROR, (_evt: any, data: any) => {
      console.warn('[WebCodecsPlayer] HLS ERROR:', data.type, data.details);
      this.debugStats.lastError = data.details || data.type;
      if (data.fatal) {
        this.fail('hls: ' + (data.details || data.type));
      }
    });

    hls.loadSource(url);
    const videoEl = document.createElement('video');
    videoEl.style.display = 'none';
    document.body.appendChild(videoEl);
    hls.attachMedia(videoEl);

    this.loop();
  }

  private initDemuxPipeline() {
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
      if (this.destroyed) return;
      if (d.type === 'video') {
        this.debugStats.videoPes++;
        this.handleVideoPes(d);
      } else if (d.type === 'audio') {
        this.debugStats.audioPes++;
        this.handleAudioPes(d);
      }
    });

    this.elementaryStream.on('error', (err: any) => {
      console.warn('[WebCodecsPlayer] demux error:', err);
      this.debugStats.lastError = String(err);
    });
  }

  private feedTsData(data: Uint8Array) {
    if (this.destroyed || !this.packetStream) return;
    try {
      this.packetStream.push(data);
      this.packetStream.flush();
    } catch (e) {
      console.warn('[WebCodecsPlayer] feedTs error:', e);
    }
  }

  private handleVideoPes(pes: any) {
    const pesData = pes.data;
    const pts = pes.pts != null ? pes.pts / 90000 : 0;
    if (!pesData || !(pesData instanceof Uint8Array) || pesData.length === 0) return;

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
      } else if (naluType === 1 || naluType === 2 || naluType === 3 || naluType === 4) {
        frameNalus.push(nalu);
      }
    }

    if (!this.videoConfig && this.spsNalu && this.ppsNalu) {
      const config = this.buildVideoConfig(this.spsNalu, this.ppsNalu);
      this.videoConfig = config;
      try {
        const cfg: any = {
          codec: config.codec,
          codedWidth: config.codedWidth,
          codedHeight: config.codedHeight,
          description: config.description,
          optimizeForLatency: false,
        };
        this.videoDecoder?.configure(cfg);
        console.log('[WebCodecsPlayer] video decoder configured:', config.codec, config.codedWidth + 'x' + config.codedHeight);
      } catch (e) {
        console.warn('[WebCodecsPlayer] video configure failed:', e);
      }
    }

    if (frameNalus.length === 0) return;

    const frameData = this.nalusToAvcc(frameNalus);
    this.encodedVideo.push({
      key: hasKeyFrame,
      timestamp: Math.round(pts * 1e6),
      duration: 33000,
      data: frameData,
    });
    this.debugStats.videoSamples++;
  }

  private handleAudioPes(pes: any) {
    const pesData = pes.data;
    const pts = pes.pts != null ? pes.pts / 90000 : 0;
    if (!pesData || !(pesData instanceof Uint8Array) || pesData.length === 0) return;

    const aacFrames = this.splitAdtsFrames(pesData);
    for (const frame of aacFrames) {
      if (!this.audioConfig && frame.length > 7) {
        const adts = this.parseAdts(frame);
        if (adts) {
          const desc = this.buildAacConfig(adts.sampleRate, adts.channels, adts.profile);
          this.audioConfig = {
            codec: 'mp4a.40.2',
            sampleRate: adts.sampleRate,
            numberOfChannels: adts.channels,
            description: desc,
          };
          try {
            this.audioDecoder?.configure({
              codec: 'mp4a.40.2',
              sampleRate: adts.sampleRate,
              numberOfChannels: adts.channels,
              description: desc,
            });
            console.log('[WebCodecsPlayer] audio decoder configured:', adts.sampleRate + 'Hz', adts.channels + 'ch');
          } catch (e) {
            console.warn('[WebCodecsPlayer] audio configure failed:', e);
          }
        }
      }

      const rawAac = frame.subarray(7);
      this.encodedAudio.push({
        key: true,
        timestamp: Math.round(pts * 1e6),
        duration: 23000,
        data: rawAac,
      });
      this.debugStats.audioSamples++;
    }
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
    if (!this.destroyed) {
      this.raf = requestAnimationFrame(this.loop);
    }
  };

  private tick() {
    try {
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
      }

      if (this.showDebug) {
        this.drawDebugOverlay();
      }
    } catch (e) {
      console.error('[WebCodecsPlayer] tick error:', e);
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
        for (let ch = 0; ch < channels; ch++) {
          const dest = new Float32Array(frames);
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
    ctx.fillRect(0, 0, w, 560);
    ctx.fillStyle = '#0f0';
    ctx.font = '13px monospace';
    const ds = this.debugStats;
    const lines = [
      `[WC] state: ${stats.state}`,
      `[WC] render: ${stats.renderFps} fps  decode: ${stats.decodeFps} fps`,
      `[WC] frameQueue: ${stats.queued}  inDecode: ${stats.decodeQueue}  dropped: ${stats.dropped}`,
      `[WC] ${stats.resolution} ${stats.codec}`,
      `[WC] t=${stats.currentSec}s  duration=${this.durationSec.toFixed(1)}s`,
      `[WC] decoded=${stats.decodedFrames} rendered=${stats.renderedFrames}`,
      `[WC] vBuf: ${stats.demuxVideoQueue}  aBuf: ${stats.demuxAudioQueue}`,
      `[WC] vCfg: ${this.videoConfig ? 'OK' : 'no'}  aCfg: ${this.audioConfig ? 'OK' : 'no'}`,
      `--- HLS ---`,
      `  state: ${ds.hlsState}  levels: ${ds.levelCount}  level: ${ds.currentLevel}`,
      `  frags: ${ds.fragLoaded}  bytes: ${(ds.bytesLoaded / 1024 / 1024).toFixed(2)}MB`,
      `--- Demux ---`,
      `  pmt: ${ds.pmtFound ? 'found' : 'waiting'}  vPES: ${ds.videoPes}  aPES: ${ds.audioPes}`,
      `  video samples: ${ds.videoSamples}  audio samples: ${ds.audioSamples}`,
      `  audioCtx: ${this.audioCtx?.state || 'none'}`,
      ds.error ? `  ERROR: ${ds.error}` : '',
      ds.lastError ? `  lastErr: ${ds.lastError}` : '',
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
        this.videoDecoder?.configure({
          codec: this.videoConfig.codec,
          codedWidth: this.videoConfig.codedWidth,
          codedHeight: this.videoConfig.codedHeight,
          description: this.videoConfig.description,
        });
      } catch {}
    }
    if (this.audioConfig) {
      try {
        this.audioDecoder?.configure({
          codec: this.audioConfig.codec,
          sampleRate: this.audioConfig.sampleRate,
          numberOfChannels: this.audioConfig.numberOfChannels,
          description: this.audioConfig.description,
        });
      } catch {}
    }

    if (this.hls) {
      try {
        this.hls.currentTime = t;
      } catch {}
    }

    this.initDemuxPipeline();
    this.setState('buffering');
  }

  private teardown() {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;

    if (this.hls) {
      try { this.hls.destroy(); } catch {}
      this.hls = null;
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
    this.spsNalu = null;
    this.ppsNalu = null;

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

    this.packetStream = null;
    this.parseStream = null;
    this.elementaryStream = null;
  }

  destroy() {
    this.destroyed = true;
    this.teardown();
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
      if (i + 4 <= len && data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 0 && data[i + 3] === 1) {
        startCodeLen = 4;
      } else if (i + 3 <= len && data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 1) {
        startCodeLen = 3;
      }

      if (startCodeLen > 0) {
        const start = i;
        i += startCodeLen;
        let end = i;
        while (end < len) {
          if (end + 4 <= len && data[end] === 0 && data[end + 1] === 0 && data[end + 2] === 0 && data[end + 3] === 1) break;
          if (end + 3 <= len && data[end] === 0 && data[end + 1] === 0 && data[end + 2] === 1) break;
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
    if (nalu[0] === 0 && nalu[1] === 0 && nalu[2] === 0 && nalu[3] === 1) startCodeLen = 4;
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
    if (sps[0] === 0 && sps[1] === 0 && sps[2] === 0 && sps[3] === 1) spsOffset = 4;
    else if (sps[0] === 0 && sps[1] === 0 && sps[2] === 1) spsOffset = 3;

    const profileIdc = sps[spsOffset + 1];
    const profileCompat = sps[spsOffset + 2];
    const levelIdc = sps[spsOffset + 3];
    const codec = `avc1.${this.hex(profileIdc)}${this.hex(profileCompat)}${this.hex(levelIdc)}`;

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
    if (nalu[0] === 0 && nalu[1] === 0 && nalu[2] === 0 && nalu[3] === 1) return nalu.subarray(4);
    if (nalu[0] === 0 && nalu[1] === 0 && nalu[2] === 1) return nalu.subarray(3);
    return nalu;
  }

  private splitAdtsFrames(data: Uint8Array): Uint8Array[] {
    const frames: Uint8Array[] = [];
    let i = 0;
    const len = data.length;

    while (i + 7 <= len) {
      if (data[i] === 0xff && (data[i + 1] & 0xf0) === 0xf0) {
        const frameLen = ((data[i + 3] & 0x03) << 11) | (data[i + 4] << 3) | ((data[i + 5] & 0xe0) >> 5);
        if (frameLen < 7 || i + frameLen > len) break;
        frames.push(data.subarray(i, i + frameLen));
        i += frameLen;
      } else {
        i++;
      }
    }

    return frames;
  }

  private parseAdts(data: Uint8Array): { sampleRate: number; channels: number; profile: number } | null {
    if (data[0] !== 0xff || (data[1] & 0xf0) !== 0xf0) return null;
    const sampleRates = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];
    const profile = ((data[2] & 0xc0) >> 6) + 1;
    const sampleRateIdx = (data[2] & 0x3c) >> 2;
    const channels = ((data[2] & 0x01) << 2) | ((data[3] & 0xc0) >> 6);
    return { sampleRate: sampleRates[sampleRateIdx] || 44100, channels, profile };
  }

  private buildAacConfig(sampleRate: number, channels: number, profile: number): Uint8Array {
    const sampleRates = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];
    let sampleRateIdx = sampleRates.indexOf(sampleRate);
    if (sampleRateIdx < 0) sampleRateIdx = 4;
    const audioObjectType = profile || 2;
    const asc = new Uint8Array(2);
    asc[0] = (audioObjectType << 3) | (sampleRateIdx >> 1);
    asc[1] = ((sampleRateIdx & 0x01) << 7) | (channels << 3);
    return asc;
  }
}
