// @ts-nocheck
import Hls from 'hls.js';

export type PlayerState = 'idle' | 'buffering' | 'playing' | 'paused' | 'ended' | 'error';
export type RenderMode = 'webcodecs' | 'capture';

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

  private state: PlayerState = 'idle';
  private destroyed = false;
  private raf = 0;
  private showDebug = false;
  private playbackRate = 1;
  private renderMode: RenderMode = 'capture';

  private renderedFrames = 0;
  private lastRenderTime = 0;
  private fps = 0;
  private fpsLastTime = 0;
  private fpsFrames = 0;

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
    this.fps = 0;
    this.fpsFrames = 0;
    this.fpsLastTime = performance.now();
    this.setState('buffering');
    console.log('[WebCodecsPlayer] load url=' + url + ' startAt=' + startAt);

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

    videoEl.addEventListener('ratechange', () => {
      if (this.destroyed) return;
      this.playbackRate = videoEl.playbackRate;
    });

    videoEl.addEventListener('loadedmetadata', () => {
      if (this.destroyed) return;
      if (videoEl.videoWidth && videoEl.videoHeight) {
        this.canvas.width = videoEl.videoWidth;
        this.canvas.height = videoEl.videoHeight;
      }
    });

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
      console.log('[WebCodecsPlayer] MANIFEST_PARSED, levels:', data.levels?.length);
    });

    hls.on(Hls.Events.ERROR, (_evt: any, data: any) => {
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
          if (this.canvas.width !== v.videoWidth || this.canvas.height !== v.videoHeight) {
            this.canvas.width = v.videoWidth;
            this.canvas.height = v.videoHeight;
          }
          this.ctx.drawImage(v, 0, 0, this.canvas.width, this.canvas.height);
          this.renderedFrames++;

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
      this.videoEl.muted = v === 0;
    }
  }

  setMuted(m: boolean): void {
    if (this.videoEl) {
      this.videoEl.muted = m;
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
      bufferedVideoSec: this.videoEl?.buffered?.length ? this.videoEl.buffered.end(this.videoEl.buffered.length - 1) - this.videoEl.currentTime : 0,
      bufferedAudioSec: 0,
      resolution: this.videoEl ? `${this.videoEl.videoWidth}x${this.videoEl.videoHeight}` : '0x0',
      codec: 'capture',
      currentSec: this.videoEl?.currentTime || 0,
      renderedFrames: this.renderedFrames,
      decodedFrames: this.renderedFrames,
      demuxVideoQueue: 0,
    };
  }

  private drawDebugOverlay() {
    const stats = this.getStats();
    const ctx = this.ctx;
    const w = this.canvas.width || 640;
    ctx.save();
    ctx.fillStyle = 'rgba(0, 0, 0, 0.65)';
    ctx.fillRect(0, 0, Math.min(360, w), 180);
    ctx.fillStyle = '#0f0';
    ctx.font = '13px monospace';

    const lines = [
      `[Capture] state: ${stats.state}`,
      `[Capture] render: ${stats.renderFps} fps`,
      `[Capture] ${stats.resolution}`,
      `[Capture] t=${stats.currentSec.toFixed(1)}s  rate=${this.playbackRate.toFixed(2)}x`,
      `[Capture] buf=${stats.bufferedVideoSec.toFixed(1)}s`,
    ];
    lines.forEach((line, i) => {
      ctx.fillText(line, 10, 20 + i * 18);
    });
    ctx.restore();
  }

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
