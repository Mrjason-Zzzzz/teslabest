// @ts-nocheck
import Hls from 'hls.js';

export type PlayerState = 'idle' | 'buffering' | 'playing' | 'paused' | 'ended' | 'error';

export interface PlayerCallbacks {
  onTime?: (currentSec: number) => void;
  onDurationChange?: (durationSec: number) => void;
  onStateChange?: (state: PlayerState) => void;
  onError?: (message: string) => void;
}

/**
 * WebCodecsPlayer — 单管道视频渲染播放器
 *
 * 架构：HLS.js → <video>（音视频同源，100% 同步）→ Canvas.drawImage（渲染）
 * 去掉了 mux.js + VideoDecoder 双管道，从根本上解决音画不同步。
 */
export class WebCodecsPlayer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private cb: PlayerCallbacks;

  private hls: any = null;
  private videoEl: HTMLVideoElement | null = null;

  private state: PlayerState = 'idle';
  private destroyed = false;
  private raf = 0;
  private showDebug = false;
  private playbackRate = 1;
  private audioMuted = true;

  // 帧率统计
  private renderedFrames = 0;
  private fps = 0;
  private fpsFrames = 0;
  private fpsLastTime = 0;

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
    return typeof Hls !== 'undefined' && Hls.isSupported();
  }

  async load(url: string, startAt = 0): Promise<void> {
    this.teardown();
    this.renderedFrames = 0;
    this.fps = 0;
    this.fpsFrames = 0;
    this.fpsLastTime = performance.now();
    this.audioMuted = true;
    this.setState('buffering');
    console.log('[WebCodecsPlayer] load url=' + url + ' startAt=' + startAt);

    if (!Hls.isSupported()) {
      this.fail('hls.js not supported');
      return;
    }

    // 将 video 元素插入 canvas 的父容器，藏在 canvas 后面
    // 这样浏览器会正常解码视频帧（不会因为 1px 尺寸而跳过解码）
    const parent = this.canvas.parentElement;
    const videoEl = document.createElement('video');
    videoEl.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;object-fit:contain;z-index:0;pointer-events:none;';
    videoEl.muted = true;
    videoEl.playsInline = true;
    videoEl.setAttribute('playsinline', '');
    videoEl.setAttribute('x-webkit-airplay', 'deny');
    videoEl.crossOrigin = 'anonymous';
    
    if (parent) {
      parent.insertBefore(videoEl, this.canvas);
      // 确保 canvas 在 video 上面
      this.canvas.style.position = 'relative';
      this.canvas.style.zIndex = '1';
    }
    this.videoEl = videoEl;

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
      maxBufferLength: 60,
      maxMaxBufferLength: 120,
      backBufferLength: 30,
    });

    this.hls = hls;

    hls.on(Hls.Events.MANIFEST_PARSED, (_evt: any, data: any) => {
      if (this.destroyed) return;
      console.log('[WebCodecsPlayer] MANIFEST_PARSED, levels:', data.levels?.length);
      // muted 状态下尝试自动播放
      videoEl.play().catch(() => {
        console.warn('[WebCodecsPlayer] autoplay blocked, waiting for user gesture');
      });
    });

    hls.on(Hls.Events.FRAG_BUFFERED, () => {
      if (this.destroyed) return;
      // 有缓冲数据了，可以开始渲染
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

    this.loop();
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
    if (v.videoWidth && v.videoHeight) {
      this.canvas.width = v.videoWidth;
      this.canvas.height = v.videoHeight;
    }
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

  // ===== 渲染循环 =====

  private loop = () => {
    this.tick();
    if (!this.destroyed) {
      this.raf = requestAnimationFrame(this.loop);
    }
  };

  private tick() {
    try {
      if (this.videoEl && this.videoEl.readyState >= 2) {
        const v = this.videoEl;
        if (v.videoWidth && v.videoHeight) {
          // 同步 canvas 尺寸
          const cw = this.canvas.width;
          const ch = this.canvas.height;
          if (cw !== v.videoWidth || ch !== v.videoHeight) {
            this.canvas.width = v.videoWidth;
            this.canvas.height = v.videoHeight;
          }
          // 从 video 元素捕获帧 — 音画天然同步
          this.ctx.drawImage(v, 0, 0, this.canvas.width, this.canvas.height);
          this.renderedFrames++;

          // 帧率统计
          const now = performance.now();
          this.fpsFrames++;
          if (now - this.fpsLastTime >= 1000) {
            this.fps = Math.round((this.fpsFrames * 1000) / (now - this.fpsLastTime));
            this.fpsFrames = 0;
            this.fpsLastTime = now;
          }
        }
      }

      if (this.showDebug) {
        this.drawDebugOverlay();
      }
    } catch (e) {
      console.error('[WebCodecsPlayer] tick error:', e);
    }
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
      // 用户设置音量 > 0 时取消静音
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
    return {
      state: this.state,
      renderFps: this.fps,
      decodeFps: this.fps,
      queued: 0,
      decodeQueue: 0,
      dropped: 0,
      bufferedVideoSec: this.videoEl?.buffered?.length
        ? this.videoEl.buffered.end(this.videoEl.buffered.length - 1) - this.videoEl.currentTime
        : 0,
      bufferedAudioSec: 0,
      resolution: this.videoEl
        ? `${this.videoEl.videoWidth}x${this.videoEl.videoHeight}`
        : '0x0',
      codec: 'native',
      currentSec: this.videoEl?.currentTime || 0,
      renderedFrames: this.renderedFrames,
      decodedFrames: this.renderedFrames,
      demuxVideoQueue: 0,
    };
  }

  // ===== 调试叠加层 =====

  private drawDebugOverlay() {
    const stats = this.getStats();
    const ctx = this.ctx;
    const w = this.canvas.width || 640;
    ctx.save();
    ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
    ctx.fillRect(0, 0, Math.min(380, w), 150);
    ctx.fillStyle = '#0f0';
    ctx.font = '13px monospace';

    const lines = [
      `[Native] state: ${stats.state}`,
      `[Native] render: ${stats.renderFps} fps`,
      `[Native] ${stats.resolution}`,
      `[Native] t=${stats.currentSec.toFixed(1)}s  rate=${this.playbackRate.toFixed(2)}x`,
      `[Native] buf=${stats.bufferedVideoSec.toFixed(1)}s`,
      `[Native] audio: ${this.audioMuted ? 'muted' : 'on'}`,
    ];
    lines.forEach((line, i) => {
      ctx.fillText(line, 10, 20 + i * 18);
    });
    ctx.restore();
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

    this.state = 'idle';
    this.renderedFrames = 0;
  }

  destroy(): void {
    this.teardown();
  }
}