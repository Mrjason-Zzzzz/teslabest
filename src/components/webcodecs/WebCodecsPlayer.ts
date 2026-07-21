// @ts-nocheck
import Hls from 'hls.js';

export type PlayerState = 'idle' | 'buffering' | 'playing' | 'paused' | 'ended' | 'error';

export interface QualityLevel {
  index: number;
  height: number;
  width: number;
  bitrate: number;
  label: string;
}

export interface PlayerCallbacks {
  onTime?: (currentSec: number) => void;
  onDurationChange?: (durationSec: number) => void;
  onStateChange?: (state: PlayerState) => void;
  onError?: (message: string) => void;
  onLevelsChange?: (levels: QualityLevel[]) => void;
  onLevelSwitch?: (level: QualityLevel) => void;
  onBandwidth?: (bps: number) => void;
}

/**
 * WebCodecsPlayer
 *
 * 架构：
 *   音频：HLS.js → <video> 元素 → 浏览器原生音频管线（成熟稳定，不卡）
 *   视频：HLS.js FRAG_PARSED → VideoDecoder(硬解码) → Canvas 渲染（绕过特斯拉 <video> 画面限制）
 *   同步：video.currentTime 为主时钟，视频帧按此时钟呈现
 */
export class WebCodecsPlayer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private cb: PlayerCallbacks;

  // 音频路径：video 元素
  private hls: any = null;
  private videoEl: HTMLVideoElement | null = null;

  // 视频路径：WebCodecs
  private videoDecoder: VideoDecoder | null = null;
  private videoConfig: any = null;
  private encodedVideo: any[] = [];
  private vIdx = 0;
  private frameQueue: VideoFrame[] = [];
  private needVideoKey = true;

  // 状态
  private state: PlayerState = 'idle';
  private destroyed = false;
  private raf = 0;
  private showDebug = false;
  private playbackRate = 1;
  private audioMuted = true;
  private durationSec = 0;
  private lastTimeReportMs = 0;

  // 统计
  private renderedFrames = 0;
  private decodedFrames = 0;
  private droppedFrames = 0;
  private statsMark = { t: 0, rendered: 0, decoded: 0 };

  // 带宽
  private bandwidthBps = 0;

  // 清晰度
  private _levels: QualityLevel[] = [];

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
    return typeof VideoDecoder === 'function' && Hls.isSupported();
  }

  async load(url: string, startAt = 0): Promise<void> {
    this.teardownPipeline();
    this.destroyed = false;
    this.renderedFrames = 0;
    this.decodedFrames = 0;
    this.droppedFrames = 0;
    this.statsMark = { t: performance.now(), rendered: 0, decoded: 0 };
    this.audioMuted = true;
    this.bandwidthBps = 0;
    this._levels = [];
    this.setState('buffering');
    console.log('[WebCodecsPlayer] load url=' + url + ' startAt=' + startAt);

    if (!Hls.isSupported()) {
      this.fail('hls.js not supported');
      return;
    }

    const parent = this.canvas.parentElement;
    if (!parent) {
      this.fail('canvas has no parent element');
      return;
    }

    // 确保父容器有 position: relative
    if (window.getComputedStyle(parent).position === 'static') {
      parent.style.position = 'relative';
    }

    // 创建 video 元素 — 负责音频播放 + 提供主时钟
    const videoEl = document.createElement('video');
    videoEl.style.cssText =
      'position:absolute;top:0;left:0;width:100%;height:100%;object-fit:contain;z-index:0;';
    videoEl.muted = true; // 初始静音满足自动播放策略
    videoEl.playsInline = true;
    videoEl.setAttribute('playsinline', '');
    videoEl.setAttribute('x-webkit-airplay', 'deny');
    videoEl.crossOrigin = 'anonymous';

    parent.insertBefore(videoEl, this.canvas);
    this.videoEl = videoEl;

    // canvas 样式由 React JSX 管理（position/inset/zIndex），这里不覆盖
    // 初始化 VideoDecoder
    this.setupVideoDecoder();

    // HLS.js 配置
    const hls = new Hls({
      enableWorker: true,
      lowLatencyMode: false,
      autoStartLoad: true,
      startPosition: startAt,
      abrEwmaDefaultEstimate: 500000,
      abrBandWidthFactor: 0.95,
      abrBandWidthUpFactor: 0.7,
      maxBufferLength: 60,
      maxMaxBufferLength: 120,
      backBufferLength: 30,
    });

    this.hls = hls;

    // MANIFEST_PARSED → 清晰度列表 + 自动播放
    hls.on(Hls.Events.MANIFEST_PARSED, (_evt: any, data: any) => {
      if (this.destroyed) return;
      console.log('[WebCodecsPlayer] MANIFEST_PARSED, levels:', data.levels?.length);

      const levels: QualityLevel[] = (data.levels || []).map((l: any, i: number) => ({
        index: i,
        height: l.height || 0,
        width: l.width || 0,
        bitrate: l.bitrate || 0,
        label: l.height ? `${l.height}p` : `码率 ${i + 1}`,
      }));
      this._levels = levels;
      this.cb.onLevelsChange?.(levels);

      // 尝试自动播放（muted）
      videoEl.play().catch(() => {
        console.warn('[WebCodecsPlayer] autoplay blocked');
      });
    });

    // FRAG_PARSED → 视频样本 → VideoDecoder
    hls.on(Hls.Events.FRAG_PARSED, (_evt: any, data: any) => {
      if (this.destroyed) return;
      const payload = data.payload || {};
      const videoPayload = payload.video;

      if (videoPayload?.samples?.length) {
        // 首次配置 VideoDecoder
        if (!this.videoConfig) {
          this.configureVideoDecoder(videoPayload);
        }

        // 摄入视频样本
        this.ingestVideoSamples(videoPayload.samples);
      }
    });

    // LEVEL_SWITCHED
    hls.on(Hls.Events.LEVEL_SWITCHED, (_evt: any, data: any) => {
      if (this.destroyed) return;
      const level = hls.levels[data.level];
      if (level) {
        this.cb.onLevelSwitch?.({
          index: data.level,
          height: level.height || 0,
          width: level.width || 0,
          bitrate: level.bitrate || 0,
          label: level.height ? `${level.height}p` : `码率 ${data.level + 1}`,
        });
      }
    });

    // 带宽估算
    hls.on(Hls.Events.FRAG_LOADED, (_evt: any, data: any) => {
      if (this.destroyed) return;
      if (data.frag && data.stats) {
        const loadTime = data.stats.loading.end - data.stats.loading.start;
        const size = data.stats.total;
        if (loadTime > 0 && size > 0) {
          const instantBps = (size * 8 * 1000) / loadTime;
          this.bandwidthBps = this.bandwidthBps
            ? Math.round(this.bandwidthBps * 0.7 + instantBps * 0.3)
            : Math.round(instantBps);
          this.cb.onBandwidth?.(this.bandwidthBps);
        }
      }
    });

    // 错误处理
    hls.on(Hls.Events.ERROR, (_evt: any, data: any) => {
      if (this.destroyed) return;
      console.warn('[WebCodecsPlayer] HLS ERROR:', data.type, data.details);
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

    // video 元素事件
    videoEl.addEventListener('timeupdate', this.onVideoTimeUpdate);
    videoEl.addEventListener('durationchange', this.onVideoDurationChange);
    videoEl.addEventListener('play', this.onVideoPlay);
    videoEl.addEventListener('pause', this.onVideoPause);
    videoEl.addEventListener('waiting', this.onVideoWaiting);
    videoEl.addEventListener('playing', this.onVideoPlaying);
    videoEl.addEventListener('ended', this.onVideoEnded);
    videoEl.addEventListener('error', this.onVideoError);

    hls.attachMedia(videoEl);
    hls.loadSource(url);

    // 启动渲染循环
    this.loop();
  }

  // ===== VideoDecoder =====

  private setupVideoDecoder() {
    this.needVideoKey = true;
    this.videoConfig = null;
    try {
      this.videoDecoder?.close();
    } catch {}
    this.videoDecoder = new VideoDecoder({
      output: (frame: VideoFrame) => this.onVideoFrame(frame),
      error: (e: Error) => {
        console.warn('[WebCodecsPlayer] video decoder error:', e.message);
        this.needVideoKey = true;
      },
    });
  }

  private configureVideoDecoder(videoPayload: any) {
    const codec = videoPayload.codec || 'avc1.4d401f';
    const width = videoPayload.width || 1920;
    const height = videoPayload.height || 1080;
    let description: Uint8Array | undefined;

    if (videoPayload.initSegment?.data) {
      description = new Uint8Array(videoPayload.initSegment.data);
    } else if (videoPayload.track?.initSegment) {
      description = new Uint8Array(videoPayload.track.initSegment);
    }

    this.videoConfig = { codec, codedWidth: width, codedHeight: height, description };
    console.log('[WebCodecsPlayer] video config:', codec, width + 'x' + height);

    try {
      const config: any = {
        codec,
        codedWidth: width,
        codedHeight: height,
        optimizeForLatency: false,
      };
      if (description) config.description = description;
      this.videoDecoder?.configure(config);
    } catch (e: any) {
      console.warn('[WebCodecsPlayer] video decoder configure failed:', e.message);
    }
  }

  private ingestVideoSamples(samples: any[]) {
    for (const s of samples) {
      this.encodedVideo.push({
        key: s.key || s.is_sync || false,
        timestamp: Math.round((s.pts ?? s.cts ?? 0) * 1e6),
        duration: Math.round((s.duration || 0) * 1e6),
        data: s.data || s.unit || s,
      });
    }
  }

  private onVideoFrame(frame: VideoFrame) {
    this.decodedFrames++;
    if (this.canvas.width !== frame.displayWidth || this.canvas.height !== frame.displayHeight) {
      this.canvas.width = frame.displayWidth;
      this.canvas.height = frame.displayHeight;
    }
    this.frameQueue.push(frame);
  }

  // ===== 渲染循环 =====

  private loop = () => {
    this.tick();
    if (!this.destroyed) {
      this.raf = requestAnimationFrame(this.loop);
    }
  };

  private tick() {
    try {
      this.pumpDecoder();
      this.renderFrame();
      if (this.showDebug) this.drawDebugOverlay();
    } catch (e) {
      console.error('[WebCodecsPlayer] tick error:', e);
    }
  }

  /** 向 VideoDecoder 投喂编码数据 */
  private pumpDecoder() {
    const dec = this.videoDecoder;
    if (!dec || dec.state !== 'configured') return;

    const MAX_OUTSTANDING = 30;
    while (
      this.vIdx < this.encodedVideo.length &&
      this.frameQueue.length + dec.decodeQueueSize < MAX_OUTSTANDING
    ) {
      const s = this.encodedVideo[this.vIdx++];
      // 跳过非关键帧直到收到第一个关键帧
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
      } catch (e: any) {
        console.warn('[WebCodecsPlayer] video decode error:', e.message);
        this.needVideoKey = true;
      }
    }
  }

  /** 以 video.currentTime 为主时钟，呈现匹配的视频帧 */
  private renderFrame() {
    if (!this.videoEl) return;
    const clock = this.videoEl.currentTime;
    if (clock <= 0 && this.frameQueue.length === 0) return;

    // 丢弃过期帧（timestamp < clock），保留最近一帧用于绘制
    let toDraw: VideoFrame | null = null;
    while (this.frameQueue.length > 0) {
      const f = this.frameQueue[0];
      const frameTs = f.timestamp / 1e6;
      if (frameTs <= clock + 0.05) {
        // 帧时间 <= 当前时钟，可以用
        if (toDraw) {
          toDraw.close();
          this.droppedFrames++;
        }
        toDraw = this.frameQueue.shift()!;
      } else {
        // 帧时间 > 当前时钟，保留在队列中
        break;
      }
    }

    if (toDraw) {
      this.ctx.drawImage(toDraw, 0, 0, this.canvas.width, this.canvas.height);
      toDraw.close();
      this.renderedFrames++;
    }

    // 上报时间
    const now = performance.now();
    if (now - this.lastTimeReportMs >= 250) {
      this.lastTimeReportMs = now;
      this.cb.onTime?.(Math.min(clock, this.durationSec || Infinity));
    }
  }

  // ===== video 元素事件 =====

  private onVideoTimeUpdate = () => {
    // 时间通过 renderFrame 中的 reportTime 上报
  };

  private onVideoDurationChange = () => {
    if (this.destroyed || !this.videoEl) return;
    const d = this.videoEl.duration;
    if (d > 0 && Number.isFinite(d)) {
      this.durationSec = d;
      this.cb.onDurationChange?.(d);
    }
  };

  private onVideoPlay = () => {
    if (this.destroyed) return;
    if (this.state !== 'ended' && this.state !== 'error') {
      this.setState('playing');
    }
  };

  private onVideoPause = () => {
    if (this.destroyed) return;
    if (this.state !== 'ended' && this.state !== 'error') {
      this.setState('paused');
    }
  };

  private onVideoWaiting = () => {
    if (this.destroyed) return;
    if (this.state !== 'error') this.setState('buffering');
  };

  private onVideoPlaying = () => {
    if (this.destroyed) return;
    if (this.state !== 'ended' && this.state !== 'error') {
      this.setState('playing');
    }
  };

  private onVideoEnded = () => {
    if (this.destroyed) return;
    this.setState('ended');
    setTimeout(() => this.cb.onStateChange?.('ended'), 500);
  };

  private onVideoError = () => {
    if (this.destroyed || !this.videoEl) return;
    const err = this.videoEl.error;
    console.warn('[WebCodecsPlayer] video element error:', err);
    if (err) {
      this.fail('video error: ' + (err.message || err.code));
    }
  };

  // ===== 播放控制 =====

  play(): void {
    if (this.videoEl) {
      this.videoEl.play().catch(() => {});
    }
  }

  pause(): void {
    if (this.videoEl) {
      this.videoEl.pause();
    }
  }

  togglePlay(): void {
    if (this.videoEl) {
      if (this.videoEl.paused) {
        this.videoEl.play().catch(() => {});
      } else {
        this.videoEl.pause();
      }
    }
  }

  seek(t: number): void {
    if (this.videoEl) {
      // 清空视频解码管线
      this.flushVideoPipeline();
      // 定位 video 元素（音频 + 主时钟）
      this.videoEl.currentTime = Math.max(0, t);
    }
  }

  private flushVideoPipeline() {
    // 清空帧队列
    for (const f of this.frameQueue) f.close();
    this.frameQueue = [];
    // 清空编码数据
    this.encodedVideo = [];
    this.vIdx = 0;
    this.needVideoKey = true;

    // 重建 VideoDecoder
    try { this.videoDecoder?.close(); } catch {}
    this.videoDecoder = null;
    this.videoConfig = null;
    this.setupVideoDecoder();
  }

  setVolume(v: number): void {
    if (this.videoEl) {
      this.videoEl.volume = Math.max(0, Math.min(1, v));
      if (v > 0 && this.audioMuted) {
        this.videoEl.muted = false;
        this.audioMuted = false;
      }
    }
  }

  setMuted(m: boolean): void {
    if (this.videoEl) {
      this.videoEl.muted = m;
      this.audioMuted = m;
    }
  }

  unmute(): void {
    if (this.videoEl && this.audioMuted) {
      this.videoEl.muted = false;
      this.audioMuted = false;
    }
  }

  setPlaybackRate(r: number): void {
    if (this.videoEl) {
      this.videoEl.playbackRate = r;
    }
    this.playbackRate = r;
  }

  setShowDebug(s: boolean): void {
    this.showDebug = s;
    if (!s) {
      this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    }
  }

  // ===== 清晰度 / 换源 =====

  getLevels(): QualityLevel[] {
    return this._levels;
  }

  setLevel(index: number): void {
    if (!this.hls) return;
    if (index === -1) {
      this.hls.currentLevel = -1;
    } else if (index >= 0 && index < this.hls.levels.length) {
      this.hls.currentLevel = index;
    }
  }

  getCurrentLevel(): number {
    return this.hls?.currentLevel ?? -1;
  }

  getBandwidth(): number {
    return this.bandwidthBps;
  }

  getCurrentTime(): number {
    return this.videoEl?.currentTime || 0;
  }

  getDuration(): number {
    return this.videoEl?.duration || 0;
  }

  getState(): PlayerState {
    return this.state;
  }

  getStats() {
    const now = performance.now();
    const dt = Math.max(1, (now - this.statsMark.t) / 1000);
    const renderFps = Math.round((this.renderedFrames - this.statsMark.rendered) / dt);
    const decodeFps = Math.round((this.decodedFrames - this.statsMark.decoded) / dt);
    this.statsMark = { t: now, rendered: this.renderedFrames, decoded: this.decodedFrames };

    const v = this.videoEl;
    const cl = this.hls?.currentLevel ?? -1;
    const levels = this.hls?.levels || [];
    const levelLabel = cl >= 0 && levels[cl]
      ? `${levels[cl].height}p @ ${this.formatBitrate(levels[cl].bitrate)}`
      : cl === -1 ? 'auto' : '--';

    return {
      state: this.state,
      renderFps,
      decodeFps,
      queued: this.frameQueue.length,
      decodeQueue: this.videoDecoder?.decodeQueueSize ?? 0,
      dropped: this.droppedFrames,
      bufferedVideoSec: v?.buffered?.length ? v.buffered.end(v.buffered.length - 1) - (v.currentTime || 0) : 0,
      bufferedAudioSec: 0,
      resolution: this.videoConfig ? `${this.videoConfig.codedWidth}x${this.videoConfig.codedHeight}` : '',
      codec: this.videoConfig?.codec ?? '',
      currentSec: +(v?.currentTime || 0).toFixed(1),
      renderedFrames: this.renderedFrames,
      decodedFrames: this.decodedFrames,
      demuxVideoQueue: this.encodedVideo.length - this.vIdx,
      demuxAudioQueue: 0,
      bandwidth: this.formatBitrate(this.bandwidthBps),
      level: levelLabel,
      levels: levels.length,
    };
  }

  // ===== 调试 =====

  private drawDebugOverlay() {
    const stats = this.getStats();
    const ctx = this.ctx;
    const w = this.canvas.width || 640;
    ctx.save();
    ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
    ctx.fillRect(0, 0, Math.min(400, w), 220);
    ctx.fillStyle = '#0f0';
    ctx.font = '13px monospace';

    const lines = [
      `[WebCodecs] state: ${stats.state}`,
      `[WebCodecs] render: ${stats.renderFps} fps  decode: ${stats.decodeFps} fps`,
      `[WebCodecs] queue: ${stats.queued}  inDecode: ${stats.decodeQueue}  dropped: ${stats.dropped}`,
      `[WebCodecs] ${stats.resolution} ${stats.codec}`,
      `[WebCodecs] t=${stats.currentSec}s  rate=${this.playbackRate.toFixed(2)}x`,
      `[WebCodecs] decoded=${stats.decodedFrames}  rendered=${stats.renderedFrames}`,
      `[WebCodecs] demux queue: ${stats.demuxVideoQueue}`,
      `[WebCodecs] bandwidth: ${stats.bandwidth}  level: ${stats.level}`,
    ];
    lines.forEach((line, i) => {
      ctx.fillText(line, 10, 20 + i * 18);
    });
    ctx.restore();
  }

  private formatBitrate(bps: number): string {
    if (bps <= 0) return '--';
    if (bps >= 1_000_000) return (bps / 1_000_000).toFixed(1) + ' Mbps';
    if (bps >= 1_000) return (bps / 1_000).toFixed(0) + ' Kbps';
    return bps + ' bps';
  }

  // ===== 状态管理 =====

  private setState(s: PlayerState) {
    if (this.state !== s) {
      this.state = s;
      this.cb.onStateChange?.(s);
    }
  }

  private fail(msg: string) {
    console.error('[WebCodecsPlayer] fail:', msg);
    this.setState('error');
    this.cb.onError?.(msg);
  }

  private teardownPipeline() {
    this.destroyed = true;

    if (this.raf) {
      cancelAnimationFrame(this.raf);
      this.raf = 0;
    }

    if (this.hls) {
      try { this.hls.destroy(); } catch {}
      this.hls = null;
    }

    if (this.videoEl) {
      this.videoEl.pause();
      this.videoEl.removeAttribute('src');
      this.videoEl.load();
      if (this.videoEl.parentNode) {
        this.videoEl.parentNode.removeChild(this.videoEl);
      }
      this.videoEl = null;
    }

    for (const f of this.frameQueue) f.close();
    this.frameQueue = [];
    this.encodedVideo = [];
    this.vIdx = 0;

    try { this.videoDecoder?.close(); } catch {}
    this.videoDecoder = null;
    this.videoConfig = null;

    try { this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height); } catch {}

    this.state = 'idle';
    this.bandwidthBps = 0;
    this._levels = [];
  }

  destroy(): void {
    this.teardownPipeline();
  }
}