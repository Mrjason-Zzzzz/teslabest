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

export class WebCodecsPlayer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private cb: PlayerCallbacks;

  private hls: any = null;
  private videoEl: HTMLVideoElement | null = null;
  private audioEl: HTMLAudioElement | null = null;

  private packetStream: any = null;
  private parseStream: any = null;
  private elementaryStream: any = null;

  private videoDecoder: VideoDecoder | null = null;
  private videoConfig: any = null;

  private encodedVideo: any[] = [];
  private vIdx = 0;

  private frameQueue: VideoFrame[] = [];
  private videoTimeOffset: number = 0;
  private hasOffset = false;

  private state: PlayerState = 'idle';
  private destroyed = false;
  private raf = 0;
  private canvasSized = false;
  private showDebug = false;
  private needVideoKey = true;
  private lastTimeReportMs = 0;
  private lastRenderTime = 0;

  private spsNalu: Uint8Array | null = null;
  private ppsNalu: Uint8Array | null = null;

  private renderedFrames = 0;
  private decodedFrames = 0;
  private droppedFrames = 0;
  private statsMark = { t: 0, rendered: 0, decoded: 0 };

  private debugStats = {
    hlsState: 'init',
    levelCount: 0,
    currentLevel: -1,
    fragLoaded: 0,
    bytesLoaded: 0,
    videoPes: 0,
    videoSamples: 0,
    pmtFound: false,
    error: '',
    lastError: '',
    videoReady: false,
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
    return typeof VideoDecoder === 'function';
  }

  async load(url: string, startAt = 0): Promise<void> {
    this.teardown();
    this.renderedFrames = 0;
    this.decodedFrames = 0;
    this.droppedFrames = 0;
    this.statsMark = { t: performance.now(), rendered: 0, decoded: 0 };
    this.setState('buffering');
    console.log('[WebCodecsPlayer] load url=' + url + ' startAt=' + startAt);

    this.setupVideoDecoder();
    this.initDemuxPipeline();

    if (!Hls.isSupported()) {
      this.fail('hls.js not supported');
      return;
    }

    const videoEl = document.createElement('video');
    videoEl.style.display = 'none';
    videoEl.style.position = 'absolute';
    videoEl.style.width = '1px';
    videoEl.style.height = '1px';
    videoEl.style.opacity = '0.001';
    videoEl.style.pointerEvents = 'none';
    videoEl.muted = false;
    videoEl.playsInline = true;
    videoEl.crossOrigin = 'anonymous';
    document.body.appendChild(videoEl);
    this.videoEl = videoEl;

    videoEl.addEventListener('timeupdate', () => {
      if (this.destroyed) return;
      this.cb.onTime?.(videoEl.currentTime);
    });

    videoEl.addEventListener('durationchange', () => {
      if (this.destroyed) return;
      this.cb.onDurationChange?.(videoEl.duration || 0);
    });

    videoEl.addEventListener('play', () => {
      if (this.destroyed) return;
      if (this.state !== 'ended' && this.state !== 'error') {
        this.setState('playing');
      }
    });

    videoEl.addEventListener('pause', () => {
      if (this.destroyed) return;
      if (this.state !== 'ended' && this.state !== 'error') {
        this.setState('paused');
      }
    });

    videoEl.addEventListener('waiting', () => {
      if (this.destroyed) return;
      if (this.state !== 'error') this.setState('buffering');
    });

    videoEl.addEventListener('playing', () => {
      if (this.destroyed) return;
      if (this.state !== 'ended' && this.state !== 'error') {
        this.setState('playing');
      }
    });

    videoEl.addEventListener('ended', () => {
      if (this.destroyed) return;
      this.setState('ended');
      setTimeout(() => this.cb.onStateChange?.('ended'), 500);
    });

    videoEl.addEventListener('error', () => {
      if (this.destroyed) return;
      console.warn('[WebCodecsPlayer] video element error:', videoEl.error);
    });

    const hls = new Hls({
      enableWorker: false,
      lowLatencyMode: false,
      autoStartLoad: true,
      startPosition: startAt,
      maxBufferLength: 60,
      maxMaxBufferLength: 120,
      backBufferLength: 60,
    });

    this.hls = hls;

    hls.on(Hls.Events.MANIFEST_PARSED, (_evt: any, data: any) => {
      this.debugStats.hlsState = 'manifest-parsed';
      this.debugStats.levelCount = data.levels?.length || 0;
      console.log('[WebCodecsPlayer] MANIFEST_PARSED, levels:', data.levels?.length);
    });

    hls.on(Hls.Events.LEVEL_LOADED, (_evt: any, data: any) => {
      this.debugStats.hlsState = 'level-loaded';
      this.debugStats.currentLevel = data.level;
    });

    hls.on(Hls.Events.FRAG_LOADED, (_evt: any, data: any) => {
      this.debugStats.fragLoaded++;
      const frag = data.frag;
      const payload = frag?.data || data.payload;
      if (payload && payload.byteLength) {
        this.debugStats.bytesLoaded += payload.byteLength;
        this.feedTsData(new Uint8Array(payload));
      }
    });

    hls.on(Hls.Events.ERROR, (_evt: any, data: any) => {
      console.warn('[WebCodecsPlayer] HLS ERROR:', data.type, data.details);
      this.debugStats.lastError = data.details || data.type;
      if (data.fatal) {
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
          try { hls.startLoad(); } catch {}
        } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
          try { hls.recoverMediaError(); } catch {}
        } else {
          this.fail('hls: ' + (data.details || data.type));
        }
      }
    });

    hls.attachMedia(videoEl);
    hls.loadSource(url);

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
        this.debugStats.videoReady = true;
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

  private setupVideoDecoder() {
    this.needVideoKey = true;
    this.videoDecoder = new VideoDecoder({
      output: (frame) => this.onVideoFrame(frame),
      error: (e) => this.fail('video decoder: ' + e.message),
    });
  }

  private onVideoFrame(frame: VideoFrame) {
    this.decodedFrames++;
    if (!this.canvasSized) {
      this.canvas.width = frame.displayWidth;
      this.canvas.height = frame.displayHeight;
      this.canvasSized = true;
    }

    this.frameQueue.push(frame);
    while (this.frameQueue.length > 80) {
      const old = this.frameQueue.shift()!;
      old.close();
      this.droppedFrames++;
    }
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

      const clock = this.videoEl?.currentTime ?? 0;
      this.presentVideo(clock);

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
    const MAX_OUTSTANDING = 50;
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

  private presentVideo(clock: number) {
    if (this.frameQueue.length === 0) return;

    const now = performance.now();
    const minFrameInterval = 1000 / 65;

    if (now - this.lastRenderTime < minFrameInterval) {
      return;
    }

    let toDraw: VideoFrame | null = null;

    if (!this.hasOffset && this.frameQueue.length > 0) {
      const firstFrame = this.frameQueue[0];
      const firstPts = firstFrame.timestamp / 1e6;
      this.videoTimeOffset = clock - firstPts;
      this.hasOffset = true;
      console.log('[WebCodecsPlayer] sync: firstPts=' + firstPts.toFixed(2) + 's clock=' + clock.toFixed(2) + 's offset=' + this.videoTimeOffset.toFixed(2) + 's');
    }

    while (this.frameQueue.length > 0) {
      const first = this.frameQueue[0];
      const frameTime = first.timestamp / 1e6 + this.videoTimeOffset;
      const diff = frameTime - clock;

      if (diff < -0.1) {
        if (toDraw) {
          toDraw.close();
          this.droppedFrames++;
        }
        toDraw = this.frameQueue.shift()!;
      } else if (diff <= 0.034) {
        if (toDraw) {
          toDraw.close();
          this.droppedFrames++;
        }
        toDraw = this.frameQueue.shift()!;
        break;
      } else {
        break;
      }
    }

    if (toDraw) {
      this.ctx.drawImage(toDraw, 0, 0, this.canvas.width, this.canvas.height);
      toDraw.close();
      this.renderedFrames++;
      this.lastRenderTime = now;
    }
  }

  private drawDebugOverlay() {
    const stats = this.getStats();
    const ctx = this.ctx;
    const w = this.canvas.width || 640;
    ctx.save();
    ctx.fillStyle = 'rgba(0, 0, 0, 0.8)';
    ctx.fillRect(0, 0, w, 480);
    ctx.fillStyle = '#0f0';
    ctx.font = '13px monospace';
    const ds = this.debugStats;
    const lines = [
      `[WC] state: ${stats.state}`,
      `[WC] render: ${stats.renderFps} fps  decode: ${stats.decodeFps} fps`,
      `[WC] frameQueue: ${stats.queued}  inDecode: ${stats.decodeQueue}  dropped: ${stats.dropped}`,
      `[WC] ${stats.resolution} ${stats.codec}`,
      `[WC] t=${stats.currentSec}s`,
      `[WC] decoded=${stats.decodedFrames} rendered=${stats.renderedFrames}`,
      `[WC] vBuf: ${stats.demuxVideoQueue}`,
      `[WC] vCfg: ${this.videoConfig ? 'OK' : 'no'}  offset: ${this.hasOffset ? this.videoTimeOffset.toFixed(2) + 's' : 'pending'}`,
      `--- HLS ---`,
      `  state: ${ds.hlsState}  levels: ${ds.levelCount}  level: ${ds.currentLevel}`,
      `  frags: ${ds.fragLoaded}  bytes: ${(ds.bytesLoaded / 1024 / 1024).toFixed(2)}MB`,
      `--- Demux ---`,
      `  pmt: ${ds.pmtFound ? 'found' : 'waiting'}  vPES: ${ds.videoPes}`,
      `  video samples: ${ds.videoSamples}`,
      `  audio: via hls.js + video element`,
      ds.error ? `  ERROR: ${ds.error}` : '',
      ds.lastError ? `  lastErr: ${ds.lastError}` : '',
    ].filter(Boolean);
    lines.forEach((line, i) => {
      ctx.fillText(line, 10, 18 + i * 16);
    });
    ctx.restore();
  }

  play() {
    if (this.videoEl) {
      this.videoEl.play().catch((e) => console.warn('[WebCodecsPlayer] play failed:', e));
    }
  }

  pause() {
    if (this.videoEl) {
      this.videoEl.pause();
    }
  }

  togglePlay() {
    if (!this.videoEl) return;
    if (this.videoEl.paused) this.play();
    else this.pause();
  }

  setVolume(v: number) {
    if (this.videoEl) {
      this.videoEl.volume = Math.max(0, Math.min(1, v));
    }
  }

  setPlaybackRate(r: number) {
    if (this.videoEl) {
      this.videoEl.playbackRate = Math.max(0.25, Math.min(4, r));
    }
  }

  async seek(seconds: number) {
    const t = Math.max(0, seconds);
    console.log('[WebCodecsPlayer] seek to:', t);

    this.encodedVideo = [];
    this.vIdx = 0;
    this.needVideoKey = true;
    this.videoTimeOffset = 0;
    this.hasOffset = false;

    for (const f of this.frameQueue) f.close();
    this.frameQueue = [];

    try { this.videoDecoder?.reset(); } catch {}
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

    this.initDemuxPipeline();

    if (this.videoEl) {
      this.videoEl.currentTime = t;
    }
  }

  private teardown() {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;

    if (this.hls) {
      try { this.hls.destroy(); } catch {}
      this.hls = null;
    }

    if (this.videoEl) {
      this.videoEl.removeAttribute('src');
      this.videoEl.load();
      this.videoEl.remove();
      this.videoEl = null;
    }

    for (const f of this.frameQueue) f.close();
    this.frameQueue = [];
    this.encodedVideo = [];
    this.vIdx = 0;
    this.canvasSized = false;
    this.spsNalu = null;
    this.ppsNalu = null;

    try {
      if (this.videoDecoder && this.videoDecoder.state !== 'closed') this.videoDecoder.close();
    } catch {}
    this.videoDecoder = null;

    this.packetStream = null;
    this.parseStream = null;
    this.elementaryStream = null;
  }

  destroy() {
    this.destroyed = true;
    this.teardown();
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

    const clock = this.videoEl?.currentTime ?? 0;
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
      demuxAudioQueue: 0,
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
}
