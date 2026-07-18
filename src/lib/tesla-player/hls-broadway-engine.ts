/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * HlsBroadwayEngine
 *
 * 整合：拉 m3u8 → 拉 TS 分片 → TS demux → Broadway.js Decoder 软解 → YUVCanvas WebGL 渲染。
 *
 * 设计要点：
 *   - 不使用 <video> 元素，纯 Canvas 渲染，绕开特斯拉行驶中视频元素限制
 *   - 复用现有 /api/proxy-m3u8、/api/proxy/vod/m3u8、/api/proxy/segment 接口
 *   - 用 WebCrypto 处理 AES-128 加密段（如果有）
 *   - 用 Broadway Player（带 worker）软解 H.264
 *   - 暴露类似 HTMLMediaElement 的 API（play/pause/seek/duration/currentTime）
 *
 * 局限：
 *   - 仅 H.264（Broadway.js 限制）
 *   - 不解音频（特斯拉场景视频足够；音频需要 AAC 解码器，超出范围）
 *   - 帧率由解码速度决定，软解慢于实时会卡顿
 */

import {
  type M3U8Key,
  type M3U8Playlist,
  parseM3U8,
  pickVariant,
} from './m3u8-parser';
import { demuxTS } from './ts-demuxer';

// 通用事件回调类型
type EventListener = (payload?: any) => void;

// Broadway.js 通过全局脚本注入，类型无法静态推导
declare global {
  interface Window {
    Player?: any;
    YUVCanvas?: any;
    Decoder?: any;
  }
}

export type HlsBroadwayEventName =
  | 'ready'
  | 'playing'
  | 'pause'
  | 'ended'
  | 'error'
  | 'loading'
  | 'timeupdate'
  | 'durationchange'
  | 'buffering'
  | 'manifestParsed'
  | 'frameDecoded';

export interface HlsBroadwayError {
  type: 'network' | 'media' | 'decoder' | 'format';
  details: string;
  fatal: boolean;
  cause?: any;
}

interface HlsBroadwayOptions {
  /** m3u8 URL（已经过 /api/proxy-m3u8 或 /api/proxy/vod/m3u8 代理） */
  url: string;
  /** 渲染目标 canvas（可选；不传则自建） */
  canvas?: HTMLCanvasElement;
  /** 是否直播 */
  live?: boolean;
  /** Broadway worker 文件路径 */
  workerFile?: string;
  /** 是否启用 worker 解码（默认 true） */
  useWorker?: boolean;
  /** 是否启用 webgl 渲染（默认 auto） */
  webgl?: boolean | 'auto';
  /** 自动播放 */
  autoplay?: boolean;
  /** 初始 canvas 尺寸（会被实际帧覆盖） */
  size?: { width: number; height: number };
  /** 刷新直播 m3u8 的间隔（毫秒），默认 5000 */
  liveRefreshInterval?: number;
  /** 同时预下载的 segment 数量 */
  preloadCount?: number;
  /** 日志开关 */
  debug?: boolean;
}

export class HlsBroadwayEngine {
  private opts: Required<
    Omit<HlsBroadwayOptions, 'canvas'>
  > & { canvas?: HTMLCanvasElement };
  private player: any = null;
  private playlist: M3U8Playlist | null = null;
  private masterUrl: string;
  private mediaUrl: string;
  private keyCache = new Map<string, Uint8Array>();
  private segmentBuffers = new Map<number, Uint8Array>(); // 已下载但未喂入的 segment
  private currentSegmentIndex = 0;
  private feeding = false;
  private pendingSeek: number | null = null;

  private isPlaying = false;
  private isBuffering = false;
  private isManifestParsed = false;
  private isDestroyed = false;
  private currentTime = 0;
  private duration = 0;
  private lastFrameTime = 0;
  private playbackStartTime = 0;
  private playbackRate = 1;
  private renderTimer: number | null = null;

  private liveRefreshTimer: number | null = null;
  private eventListeners = new Map<HlsBroadwayEventName, Set<EventListener>>();

  constructor(options: HlsBroadwayOptions) {
    this.opts = {
      url: options.url,
      live: options.live ?? false,
      workerFile: options.workerFile ?? '/assets/broadway/Decoder.js',
      useWorker: options.useWorker ?? true,
      webgl: options.webgl ?? 'auto',
      autoplay: options.autoplay ?? true,
      size: options.size ?? { width: 1280, height: 720 },
      liveRefreshInterval: options.liveRefreshInterval ?? 5000,
      preloadCount: options.preloadCount ?? 2,
      debug: options.debug ?? false,
    };
    if (options.canvas) this.opts.canvas = options.canvas;
    this.masterUrl = options.url;
    this.mediaUrl = options.url;
  }

  // ============= 公开 API =============

  public on(event: HlsBroadwayEventName, handler: EventListener): void {
    if (!this.eventListeners.has(event)) {
      this.eventListeners.set(event, new Set());
    }
    this.eventListeners.get(event)!.add(handler);
  }

  public off(event: HlsBroadwayEventName, handler: EventListener): void {
    this.eventListeners.get(event)?.delete(handler);
  }

  private emit(event: HlsBroadwayEventName, payload?: any): void {
    this.eventListeners.get(event)?.forEach((h) => {
      try {
        h(payload);
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn('[HlsBroadwayEngine] event handler error', e);
      }
    });
  }

  public getCanvas(): HTMLCanvasElement | null {
    return this.player?.canvas ?? this.opts.canvas ?? null;
  }

  public getCurrentTime(): number {
    return this.currentTime;
  }

  public getDuration(): number {
    return this.duration;
  }

  public isReady(): boolean {
    return this.isManifestParsed && !this.isDestroyed;
  }

  public async load(): Promise<void> {
    if (this.isDestroyed) return;
    try {
      await this.loadManifest();
      this.isManifestParsed = true;
      this.emit('manifestParsed');
      this.emit('durationchange', this.duration);
      this.initBroadwayPlayer();
      if (this.opts.live) this.scheduleLiveRefresh();
      if (this.opts.autoplay) {
        await this.play();
      } else {
        this.startFeedingLoop();
      }
    } catch (e: any) {
      this.emitError('network', e?.message || '加载 m3u8 失败', true, e);
    }
  }

  public async play(): Promise<void> {
    if (this.isDestroyed) return;
    if (!this.isManifestParsed) {
      await this.load();
    }
    this.isPlaying = true;
    this.playbackStartTime = performance.now() - this.currentTime * 1000;
    this.startRenderClock();
    this.startFeedingLoop();
    this.emit('playing');
  }

  public pause(): void {
    this.isPlaying = false;
    this.stopRenderClock();
    this.emit('pause');
  }

  public getPaused(): boolean {
    return !this.isPlaying;
  }

  public setPlaybackRate(rate: number): void {
    this.playbackRate = rate;
    if (this.isPlaying) {
      this.playbackStartTime = performance.now() - this.currentTime * 1000 / rate;
    }
  }

  public getPlaybackRate(): number {
    return this.playbackRate;
  }

  public seek(time: number): void {
    if (this.isDestroyed || !this.playlist || this.opts.live) return;
    const clamped = Math.max(0, Math.min(time, this.duration));
    this.pendingSeek = clamped;
    this.currentTime = clamped;
    this.playbackStartTime = performance.now() - clamped * 1000 / this.playbackRate;
    // 找到对应的 segment
    const idx = this.findSegmentIndexByTime(clamped);
    if (idx >= 0) {
      this.currentSegmentIndex = idx;
      this.segmentBuffers.clear();
      this.feeding = false;
      // 重新喂入
      this.startFeedingLoop();
    }
    this.emit('timeupdate', this.currentTime);
  }

  public destroy(): void {
    this.isDestroyed = true;
    this.stopRenderClock();
    if (this.liveRefreshTimer) {
      window.clearInterval(this.liveRefreshTimer);
      this.liveRefreshTimer = null;
    }
    try {
      this.player?.destroy?.();
    } catch {
      // ignore
    }
    this.player = null;
    this.playlist = null;
    this.segmentBuffers.clear();
    this.keyCache.clear();
    this.eventListeners.clear();
  }

  // ============= 内部实现 =============

  private async loadManifest(): Promise<void> {
    let url = this.masterUrl;
    let text = await this.fetchText(url);
    let playlist = parseM3U8(text, url);

    if (playlist.isMaster) {
      const variant = pickVariant(playlist.variants);
      if (!variant) {
        throw new Error('Master playlist 无可用 variant');
      }
      url = variant.uri;
      this.mediaUrl = url;
      text = await this.fetchText(url);
      playlist = parseM3U8(text, url);
    }

    this.playlist = playlist;

    // 计算总时长
    if (playlist.endList) {
      this.duration = playlist.segments.reduce(
        (sum, s) => sum + s.duration,
        0
      );
    } else {
      this.duration = playlist.endList ? this.duration : Infinity;
    }

    if (this.opts.debug) {
      // eslint-disable-next-line no-console
      console.log('[HlsBroadwayEngine] playlist parsed', {
        segments: playlist.segments.length,
        duration: this.duration,
        type: playlist.type,
        endList: playlist.endList,
      });
    }
  }

  private async fetchText(url: string): Promise<string> {
    const res = await fetch(url, {
      credentials: 'same-origin',
      redirect: 'follow',
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText}: ${url}`);
    }
    return await res.text();
  }

  private async fetchSegment(url: string): Promise<Uint8Array> {
    const res = await fetch(url, {
      credentials: 'same-origin',
      redirect: 'follow',
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} 分片下载失败: ${url}`);
    }
    const buf = await res.arrayBuffer();
    return new Uint8Array(buf);
  }

  private async fetchKey(url: string): Promise<Uint8Array> {
    if (this.keyCache.has(url)) {
      return this.keyCache.get(url)!;
    }
    const res = await fetch(url, {
      credentials: 'same-origin',
      redirect: 'follow',
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} key 下载失败: ${url}`);
    }
    const buf = await res.arrayBuffer();
    const key = new Uint8Array(buf);
    this.keyCache.set(url, key);
    return key;
  }

  private async decryptSegment(
    data: Uint8Array,
    keyInfo: M3U8Key
  ): Promise<Uint8Array> {
    if (!keyInfo || keyInfo.method === 'NONE' || !keyInfo.uri) {
      return data;
    }
    if (keyInfo.method !== 'AES-128') {
      this.emitError(
        'format',
        `不支持的加密方式: ${keyInfo.method}`,
        false
      );
      return data;
    }
    const key = await this.fetchKey(keyInfo.uri);
    // IV：如果 playlist 没给 IV，默认用 segment sequence number 当 IV（大端 16 字节）
    let iv = keyInfo.iv;
    if (!iv) {
      iv = new Uint8Array(16);
      // segment sequence number 在 iv 的最后 8 字节
      const seq = this.currentSegmentIndex + (this.playlist?.mediaSequence || 0);
      const view = new DataView(iv.buffer);
      view.setUint32(8, 0);
      view.setUint32(12, seq);
    }
    try {
      const cryptoKey = await crypto.subtle.importKey(
        'raw',
        key,
        { name: 'AES-CBC' },
        false,
        ['decrypt']
      );
      const decrypted = await crypto.subtle.decrypt(
        { name: 'AES-CBC', iv },
        cryptoKey,
        data
      );
      return new Uint8Array(decrypted);
    } catch (e: any) {
      this.emitError('media', `AES-128 解密失败: ${e?.message}`, false, e);
      return data;
    }
  }

  private initBroadwayPlayer(): void {
    if (this.player) return;
    if (typeof window === 'undefined' || !window.Player) {
      this.emitError('decoder', 'Broadway Player 未加载', true);
      return;
    }
    const PlayerCtor = window.Player;
    this.player = new PlayerCtor({
      useWorker: this.opts.useWorker,
      workerFile: this.opts.workerFile,
      webgl: this.opts.webgl,
      size: this.opts.size,
      preserveDrawingBuffer: false,
    });
    this.player.onRenderFrameComplete = (frame: any) => {
      this.lastFrameTime = performance.now();
      this.emit('frameDecoded', frame);
    };
    if (this.opts.canvas) {
      // 用户提供的 canvas，替换 player 自建的
      const userCanvas = this.opts.canvas;
      const parent = userCanvas.parentElement;
      if (parent && this.player.canvas && this.player.canvas !== userCanvas) {
        // 把 player.canvas 内容转移到 userCanvas
        parent.removeChild(userCanvas);
        parent.appendChild(this.player.canvas);
        this.opts.canvas = this.player.canvas;
      }
    }
  }

  private startFeedingLoop(): void {
    if (this.feeding || this.isDestroyed || !this.playlist) return;
    this.feeding = true;
    this.feedNext().catch((e) => {
      this.emitError('media', `喂入分片失败: ${e?.message}`, false, e);
    });
  }

  private async feedNext(): Promise<void> {
    if (this.isDestroyed || !this.playlist) {
      this.feeding = false;
      return;
    }
    const segments = this.playlist.segments;
    // 判断是否需要继续喂：当前段还没喂完，或者下一段在缓冲窗口内
    const targetIndex = this.computeTargetSegmentIndex();
    if (targetIndex >= segments.length) {
      // 全部喂完
      this.feeding = false;
      // 如果是 VOD 且已播放到结尾，触发 ended
      if (this.playlist.endList && this.currentTime >= this.duration - 0.05) {
        this.emit('ended');
      }
      return;
    }
    if (targetIndex === this.currentSegmentIndex && this.isPlaying) {
      // 等待时间推进
      this.feeding = false;
      window.setTimeout(() => this.startFeedingLoop(), 50);
      return;
    }
    this.currentSegmentIndex = targetIndex;
    const seg = segments[targetIndex];
    if (!seg) {
      this.feeding = false;
      return;
    }
    try {
      this.setBuffering(true);
      let data = await this.fetchSegment(seg.url);
      data = await this.decryptSegment(data, seg.key || this.playlist.currentKey!);
      const result = demuxTS(data);
      if (result.h264Stream.length > 0 && this.player) {
        // Broadway Player.decode 接受 Uint8Array
        this.player.decode(result.h264Stream);
      }
      this.setBuffering(false);
      // 推进
      this.currentSegmentIndex = targetIndex + 1;
      this.feeding = false;
      // 立即继续下一段（如果需要）
      this.startFeedingLoop();
    } catch (e: any) {
      this.feeding = false;
      // 单个分片失败：跳过，继续下一段
      this.emitError('network', `分片 ${targetIndex} 加载失败: ${e?.message}`, false, e);
      this.currentSegmentIndex = targetIndex + 1;
      window.setTimeout(() => this.startFeedingLoop(), 200);
    }
  }

  /**
   * 根据当前 currentTime 计算需要喂入的 segment index
   * - 优先喂当前位置和后面的 preloadCount 个段
   */
  private computeTargetSegmentIndex(): number {
    if (!this.playlist || this.playlist.segments.length === 0) return 0;
    const segs = this.playlist.segments;
    const target = this.findSegmentIndexByTime(this.currentTime);
    // 当前已喂到 currentSegmentIndex，那么下一段应该是 currentSegmentIndex
    // 如果 currentSegmentIndex 已经 >= target + preloadCount，等待
    const maxPreload = Math.min(
      segs.length,
      target + this.opts.preloadCount + 1
    );
    if (this.currentSegmentIndex < maxPreload) {
      return this.currentSegmentIndex;
    }
    return segs.length; // 不需要继续喂
  }

  private findSegmentIndexByTime(time: number): number {
    if (!this.playlist) return 0;
    const segs = this.playlist.segments;
    for (let i = 0; i < segs.length; i++) {
      const s = segs[i];
      if (time >= s.startOffset && time < s.startOffset + s.duration) {
        return i;
      }
    }
    if (time >= segs[segs.length - 1].startOffset + segs[segs.length - 1].duration) {
      return segs.length - 1;
    }
    return 0;
  }

  private startRenderClock(): void {
    if (this.renderTimer != null) return;
    const tick = () => {
      if (!this.isPlaying || this.isDestroyed) {
        this.renderTimer = null;
        return;
      }
      const now = performance.now();
      this.currentTime = ((now - this.playbackStartTime) / 1000) * this.playbackRate;
      if (this.duration !== Infinity && this.currentTime >= this.duration) {
        this.currentTime = this.duration;
        this.emit('timeupdate', this.currentTime);
        this.emit('ended');
        this.isPlaying = false;
        this.renderTimer = null;
        return;
      }
      this.emit('timeupdate', this.currentTime);
      // 触发后续喂入检查
      this.startFeedingLoop();
      this.renderTimer = window.requestAnimationFrame(tick);
    };
    this.renderTimer = window.requestAnimationFrame(tick);
  }

  private stopRenderClock(): void {
    if (this.renderTimer != null) {
      window.cancelAnimationFrame(this.renderTimer);
      this.renderTimer = null;
    }
  }

  private setBuffering(b: boolean): void {
    if (this.isBuffering === b) return;
    this.isBuffering = b;
    this.emit('buffering', b);
  }

  private scheduleLiveRefresh(): void {
    if (this.liveRefreshTimer) window.clearInterval(this.liveRefreshTimer);
    this.liveRefreshTimer = window.setInterval(async () => {
      if (this.isDestroyed || this.opts.live === false) return;
      try {
        const text = await this.fetchText(this.mediaUrl);
        const newPlaylist = parseM3U8(text, this.mediaUrl);
        if (!newPlaylist.segments.length) return;
        // 合并：把 playlist 中没有的新 segment 追加
        const existingSeqs = new Set(
          this.playlist?.segments.map((s) => s.sequence) || []
        );
        const newSegs = newPlaylist.segments.filter(
          (s) => !existingSeqs.has(s.sequence)
        );
        if (this.playlist) {
          this.playlist.segments.push(...newSegs);
          this.playlist.endList = newPlaylist.endList;
          if (newPlaylist.endList) {
            if (this.liveRefreshTimer) {
              window.clearInterval(this.liveRefreshTimer);
              this.liveRefreshTimer = null;
            }
          }
        } else {
          this.playlist = newPlaylist;
        }
        this.startFeedingLoop();
      } catch (e: any) {
        if (this.opts.debug) {
          // eslint-disable-next-line no-console
          console.warn('[HlsBroadwayEngine] live refresh failed', e);
        }
      }
    }, this.opts.liveRefreshInterval);
  }

  private emitError(
    type: HlsBroadwayError['type'],
    details: string,
    fatal: boolean,
    cause?: any
  ): void {
    const err: HlsBroadwayError = { type, details, fatal, cause };
    if (this.opts.debug) {
      // eslint-disable-next-line no-console
      console.error('[HlsBroadwayEngine] error', err);
    }
    this.emit('error', err);
  }
}

/**
 * 探测当前浏览器是否为特斯拉车机浏览器
 *
 * 特斯拉 MCU 浏览器 UA 特征（来自社区资料）：
 *   - Mozilla/5.0 (X11; GNU/Linux) AppleWebKit/601.1 (KHTML, like Gecko) Tesla QtCarBrowser Safari/601.1
 *   - Mozilla/5.0 (Linux; Android 10; ...) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/... Tesla/...
 *   - 含 "Tesla" 或 "QtCarBrowser" 字样
 */
export function isTeslaBrowser(): boolean {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent || '';
  if (/Tesla/i.test(ua)) return true;
  if (/QtCarBrowser/i.test(ua)) return true;
  return false;
}

/**
 * 探测当前浏览器是否支持 MSE（不支持时也需要降级到 Broadway+Canvas）
 */
export function isMSESupported(): boolean {
  if (typeof window === 'undefined') return false;
  return (
    typeof MediaSource !== 'undefined' &&
    typeof MediaSource.isTypeSupported === 'function'
  );
}

/**
 * 综合判断：是否应该启用 Broadway+Canvas 模式
 */
export function shouldUseBroadwayMode(): boolean {
  if (typeof window === 'undefined') return false;
  if (isTeslaBrowser()) return true;
  // 非 Tesla：MSE 不可用时也降级
  if (!isMSESupported()) return true;
  return false;
}
