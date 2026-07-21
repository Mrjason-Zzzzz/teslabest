// @ts-nocheck
import Hls from 'hls.js';

export type PlayerState = 'idle' | 'buffering' | 'playing' | 'paused' | 'ended' | 'error';

export interface QualityLevel {
  index: number;
  height: number;
  width: number;
  bitrate: number; // bps
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
 * 架构：HLS.js → <video> 直接显示（音视频 100% 同步，浏览器原生渲染管线）
 * Canvas 仅用于调试叠加层，不参与视频渲染。
 * 支持 HLS 多码率切换 + 带宽测速。
 */
export class WebCodecsPlayer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private cb: PlayerCallbacks;

  private hls: any = null;
  private videoEl: HTMLVideoElement | null = null;

  private state: PlayerState = 'idle';
  private destroyed = false;
  private showDebug = false;
  private playbackRate = 1;
  private audioMuted = true;

  // 带宽统计
  private bandwidthBps = 0;
  private lastFragmentLoadTime = 0;
  private lastFragmentSize = 0;

  // 调试定时器
  private debugTimer: number | null = null;

  constructor(canvas: HTMLCanvasElement, cb: PlayerCallbacks = {}) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d', { alpha: true });
    if (!ctx) throw new Error('2d canvas context unavailable');
    this.ctx = ctx;
    this.cb = cb;

    // canvas 初始设为透明，仅用于调试覆盖
    canvas.style.pointerEvents = 'none';
    if (!canvas.width || !canvas.height) {
      canvas.width = 1280;
      canvas.height = 720;
    }
  }

  static isSupported(): boolean {
    return typeof Hls !== 'undefined' && Hls.isSupported();
  }

  async load(url: string, startAt = 0): Promise<void> {
    this.teardown();
    // 关键：teardown 把 destroyed 设为 true，这里必须重置
    this.destroyed = false;
    this.audioMuted = true;
    this.bandwidthBps = 0;
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

    // 确保父容器有 position: relative 以便 video 绝对定位
    const parentPos = window.getComputedStyle(parent).position;
    if (parentPos === 'static') {
      parent.style.position = 'relative';
    }

    // 创建 video 元素 — 直接显示，不隐藏
    const videoEl = document.createElement('video');
    videoEl.style.cssText =
      'position:absolute;top:0;left:0;width:100%;height:100%;object-fit:contain;z-index:0;';
    videoEl.muted = true;
    videoEl.playsInline = true;
    videoEl.setAttribute('playsinline', '');
    videoEl.setAttribute('x-webkit-airplay', 'deny');
    videoEl.crossOrigin = 'anonymous';

    // video 插入在 canvas 前面（canvas 是透明覆盖层，z-index 更高）
    parent.insertBefore(videoEl, this.canvas);
    this.videoEl = videoEl;

    // 确保 canvas 在 video 上面，但透明不阻挡交互
    this.canvas.style.position = 'absolute';
    this.canvas.style.top = '0';
    this.canvas.style.left = '0';
    this.canvas.style.width = '100%';
    this.canvas.style.height = '100%';
    this.canvas.style.zIndex = '1';
    this.canvas.style.pointerEvents = 'none';

    // 事件监听
    videoEl.addEventListener('timeupdate', this.onTimeUpdate);
    videoEl.addEventListener('durationchange', this.onDurationChange);
    videoEl.addEventListener('loadedmetadata', this.onLoadedMetadata);
    videoEl.addEventListener('play', this.onPlay);
    videoEl.addEventListener('pause', this.onPause);
    videoEl.addEventListener('waiting', this.onWaiting);
    videoEl.addEventListener('playing', this.onPlaying);
    videoEl.addEventListener('ended', this.onEnded);
    videoEl.addEventListener('error', this.onVideoError);
    videoEl.addEventListener('ratechange', this.onRateChange);

    // HLS.js 配置
    const hls = new Hls({
      enableWorker: true,
      lowLatencyMode: false,
      autoStartLoad: true,
      startPosition: startAt,
      // 启用自适应码率 + 带宽估算
      abrEwmaDefaultEstimate: 500000,
      abrBandWidthFactor: 0.95,
      abrBandWidthUpFactor: 0.7,
      maxBufferLength: 60,
      maxMaxBufferLength: 120,
      backBufferLength: 30,
    });

    this.hls = hls;

    hls.on(Hls.Events.MANIFEST_PARSED, (_evt: any, data: any) => {
      if (this.destroyed) return;
      console.log('[WebCodecsPlayer] MANIFEST_PARSED, levels:', data.levels?.length);
      // 通知上层可用清晰度列表
      const levels = (data.levels || []).map((l: any, i: number) => ({
        index: i,
        height: l.height || 0,
        width: l.width || 0,
        bitrate: l.bitrate || 0,
        label: l.height ? `${l.height}p` : `码率 ${i + 1}`,
      }));
      this.cb.onLevelsChange?.(levels);

      // muted 自动播放
      videoEl.play().catch(() => {
        console.warn('[WebCodecsPlayer] autoplay blocked, waiting for user gesture');
      });
    });

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

    // 带宽估算：统计 fragment 加载速度
    hls.on(Hls.Events.FRAG_LOADED, (_evt: any, data: any) => {
      if (this.destroyed) return;
      if (data.frag && data.stats) {
        const loadTime = data.stats.loading.end - data.stats.loading.start;
        const size = data.stats.total;
        if (loadTime > 0 && size > 0) {
          // 计算瞬时带宽
          const instantBps = (size * 8 * 1000) / loadTime;
          // 平滑估算
          this.bandwidthBps = this.bandwidthBps
            ? Math.round(this.bandwidthBps * 0.7 + instantBps * 0.3)
            : Math.round(instantBps);
          this.cb.onBandwidth?.(this.bandwidthBps);
        }
      }
    });

    hls.on(Hls.Events.FRAG_BUFFERED, () => {
      if (this.destroyed) return;
      if (this.state === 'buffering' && videoEl.readyState >= 2) {
        this.setState('playing');
      }
    });

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

    hls.attachMedia(videoEl);
    hls.loadSource(url);

    // 启动调试覆盖层定时器
    this.startDebugOverlay();
  }

  // ===== 事件处理 =====

  private onTimeUpdate = () => {
    if (this.destroyed || !this.videoEl) return;
    this.cb.onTime?.(this.videoEl.currentTime);
  };

  private onDurationChange = () => {
    if (this.destroyed || !this.videoEl) return;
    this.cb.onDurationChange?.(this.videoEl.duration || 0);
  };

  private onLoadedMetadata = () => {
    if (this.destroyed || !this.videoEl) return;
    const v = this.videoEl;
    console.log('[WebCodecsPlayer] loadedmetadata:', v.videoWidth + 'x' + v.videoHeight, 'duration=' + v.duration);
  };

  private onPlay = () => {
    if (this.destroyed) return;
    if (this.state !== 'ended' && this.state !== 'error') {
      this.setState('playing');
    }
  };

  private onPause = () => {
    if (this.destroyed) return;
    if (this.state !== 'ended' && this.state !== 'error') {
      this.setState('paused');
    }
  };

  private onWaiting = () => {
    if (this.destroyed) return;
    if (this.state !== 'error') this.setState('buffering');
  };

  private onPlaying = () => {
    if (this.destroyed) return;
    if (this.state !== 'ended' && this.state !== 'error') {
      this.setState('playing');
    }
  };

  private onEnded = () => {
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

  private onRateChange = () => {
    if (this.destroyed || !this.videoEl) return;
    this.playbackRate = this.videoEl.playbackRate;
  };

  // ===== 调试覆盖层 =====

  private startDebugOverlay() {
    this.stopDebugOverlay();
    this.debugTimer = window.setInterval(() => {
      if (this.showDebug && !this.destroyed && this.videoEl) {
        this.drawDebugOverlay();
      } else if (!this.showDebug) {
        // 清空 canvas
        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
      }
    }, 500);
  }

  private stopDebugOverlay() {
    if (this.debugTimer !== null) {
      clearInterval(this.debugTimer);
      this.debugTimer = null;
    }
  }

  private drawDebugOverlay() {
    if (!this.videoEl) return;
    const v = this.videoEl;
    const ctx = this.ctx;
    const w = this.canvas.width || 640;
    const hlsLevels = this.hls?.levels || [];
    const currentLevel = this.hls?.currentLevel ?? -1;

    ctx.clearRect(0, 0, w, this.canvas.height);
    ctx.save();
    ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
    ctx.fillRect(0, 0, Math.min(400, w), 200);

    ctx.fillStyle = '#0f0';
    ctx.font = '13px monospace';

    const levelLabel = currentLevel >= 0 && hlsLevels[currentLevel]
      ? `${hlsLevels[currentLevel].height}p @ ${this.formatBitrate(hlsLevels[currentLevel].bitrate)}`
      : currentLevel === -1 ? 'auto' : 'none';

    const lines = [
      `state: ${this.state}`,
      `${v.videoWidth}x${v.videoHeight}  level: ${levelLabel}`,
      `t=${(v.currentTime || 0).toFixed(1)}s / ${(v.duration || 0).toFixed(1)}s`,
      `rate: ${this.playbackRate.toFixed(2)}x  audio: ${this.audioMuted ? 'muted' : 'on'}`,
      `bandwidth: ${this.formatBitrate(this.bandwidthBps)}`,
      `buf: ${this.getBufferEnd() > 0 ? (this.getBufferEnd() - v.currentTime).toFixed(1) : '0'}s`,
      `levels: ${hlsLevels.length}`,
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

  private getBufferEnd(): number {
    if (!this.videoEl?.buffered?.length) return 0;
    return this.videoEl.buffered.end(this.videoEl.buffered.length - 1);
  }

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
      this.videoEl.currentTime = Math.max(0, t);
    }
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

  /** 获取所有可用清晰度 */
  getLevels(): QualityLevel[] {
    if (!this.hls?.levels) return [];
    return this.hls.levels.map((l: any, i: number) => ({
      index: i,
      height: l.height || 0,
      width: l.width || 0,
      bitrate: l.bitrate || 0,
      label: l.height ? `${l.height}p` : `码率 ${i + 1}`,
    }));
  }

  /** 切换清晰度，-1 = 自动 */
  setLevel(index: number): void {
    if (!this.hls) return;
    if (index === -1) {
      this.hls.currentLevel = -1;
    } else if (index >= 0 && index < this.hls.levels.length) {
      this.hls.currentLevel = index;
    }
  }

  /** 获取当前清晰度 */
  getCurrentLevel(): number {
    return this.hls?.currentLevel ?? -1;
  }

  /** 获取当前带宽估算 */
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
    const v = this.videoEl;
    const levels = this.hls?.levels || [];
    const cl = this.hls?.currentLevel ?? -1;
    const levelLabel = cl >= 0 && levels[cl]
      ? `${levels[cl].height}p @ ${this.formatBitrate(levels[cl].bitrate)}`
      : cl === -1 ? 'auto' : '--';

    return {
      state: this.state,
      renderFps: 0,
      decodeFps: 0,
      queued: 0,
      decodeQueue: 0,
      dropped: 0,
      bufferedVideoSec: this.getBufferEnd() > 0 ? this.getBufferEnd() - (v?.currentTime || 0) : 0,
      bufferedAudioSec: 0,
      resolution: v ? `${v.videoWidth}x${v.videoHeight}` : '0x0',
      codec: 'native',
      currentSec: v?.currentTime || 0,
      renderedFrames: 0,
      decodedFrames: 0,
      demuxVideoQueue: 0,
      bandwidth: this.formatBitrate(this.bandwidthBps),
      level: levelLabel,
      levels: levels.length,
    };
  }

  // ===== 状态管理 =====

  private setState(s: PlayerState) {
    if (this.state !== s) {
      this.state = s;
      this.cb.onStateChange?.(s);
    }
  }

  private fail(msg: string) {
    console.error('[WebCodecsPlayer] fatal error:', msg);
    this.setState('error');
    this.cb.onError?.(msg);
  }

  teardown(): void {
    this.destroyed = true;
    this.stopDebugOverlay();

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

    // 清空 canvas
    try { this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height); } catch {}

    this.state = 'idle';
    this.bandwidthBps = 0;
  }

  destroy(): void {
    this.teardown();
  }
}