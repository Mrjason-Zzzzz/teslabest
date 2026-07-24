// @ts-nocheck
/**
 * WebCodecsPlayer — 纯 WebCodecs 解码模式
 *
 * 架构（完全绕过 <video> 元素）：
 *   HLSTSDemuxer (mux.js) → H.264/AAC 编码样本
 *   VideoDecoder → VideoFrame → Canvas 渲染
 *   AudioDecoder → AudioData → Web Audio API → 隐藏 <audio> 输出
 *   同步：AudioContext.currentTime 为主时钟
 *
 * 借鉴 WebCodecsPlayerHls 架构，但用 HLSTSDemuxer 替代 hls.js FRAG_PARSED
 */
import { HLSTSDemuxer, type EncodedSample, type VideoConfig, type AudioConfig } from './HLSTSDemuxer';

export type PlayerState = 'idle' | 'buffering' | 'playing' | 'paused' | 'ended' | 'error';

export interface PlayerCallbacks {
  onTime?: (currentSec: number) => void;
  onDurationChange?: (durationSec: number) => void;
  onStateChange?: (state: PlayerState) => void;
  onError?: (message: string) => void;
}

const TIME_REPORT_INTERVAL_MS = 250;
const AUDIO_SCHEDULE_INTERVAL_MS = 200;

export class WebCodecsPlayer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private cb: PlayerCallbacks;

  // 解复用器
  private demuxer: HLSTSDemuxer | null = null;

  // 解码器
  private videoDecoder: VideoDecoder | null = null;
  private audioDecoder: AudioDecoder | null = null;
  private videoConfig: any = null;
  private audioConfig: any = null;

  // 编码样本队列
  private encodedVideo: EncodedSample[] = [];
  private encodedAudio: EncodedSample[] = [];
  private vIdx = 0;
  private aIdx = 0;

  // 解码帧队列
  private frameQueue: VideoFrame[] = [];
  private decodedAudio: AudioData[] = [];

  // 状态
  private state: PlayerState = 'idle';
  private durationSec = 0;
  private wantPlaying = true;
  private destroyed = false;
  private raf = 0;
  private audioScheduleTimer = 0;
  private canvasSized = false;
  private showDebug = false;

  // 统计
  private renderedFrames = 0;
  private decodedFrames = 0;
  private droppedFrames = 0;
  private statsMark = { t: 0, rendered: 0, decoded: 0 };
  private lastTimeReportMs = 0;

  // Web Audio
  private audioCtx: AudioContext | null = null;
  private gain: GainNode | null = null;
  private mediaDest: MediaStreamAudioDestinationNode | null = null;
  private audioEl: HTMLAudioElement | null = null;
  private activeSources = new Set<AudioBufferSourceNode>();

  // 主时钟
  private baseMediaTime = 0;
  private ctxStartTime: number | null = null;
  private lastAudioScheduledSec = 0;
  private nextAudioStartTime = 0;

  // 解码控制
  private needVideoKey = true;
  private volume = 1;

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
    this.destroyed = false;
    this.baseMediaTime = startAt;
    this.ctxStartTime = null;
    this.lastAudioScheduledSec = 0;
    this.nextAudioStartTime = 0;
    this.renderedFrames = 0;
    this.decodedFrames = 0;
    this.droppedFrames = 0;
    this.statsMark = { t: performance.now(), rendered: 0, decoded: 0 };
    this.setState('buffering');
    console.log('[WebCodecsPlayer] load url=' + url + ' startAt=' + startAt);

    // 建立音频图
    this.setupAudioGraph();

    // 初始化解码器
    this.setupDecoders();

    // 创建 HLSTSDemuxer
    this.demuxer = new HLSTSDemuxer({
      url,
      onVideoConfig: (config: VideoConfig) => {
        if (this.destroyed) return;
        this.configureVideoDecoder(config);
      },
      onAudioConfig: (config: AudioConfig) => {
        if (this.destroyed) return;
        this.configureAudioDecoder(config);
      },
      onVideoSample: (sample: EncodedSample) => {
        if (this.destroyed) return;
        this.encodedVideo.push(sample);
      },
      onAudioSample: (sample: EncodedSample) => {
        if (this.destroyed) return;
        this.encodedAudio.push(sample);
      },
      onDuration: (dur: number) => {
        if (this.destroyed) return;
        this.durationSec = dur;
        this.cb.onDurationChange?.(dur);
      },
      onError: (e: unknown) => {
        if (this.destroyed) return;
        this.fail(String(e));
      },
    });

    await this.demuxer.start(startAt);

    // 启动渲染循环和音频调度
    this.loop();
    // Keep audio fed when RAF cadence fluctuates, but do not run the complete
    // video/render tick twice. Duplicate ticks were a major source of CPU load.
    this.audioScheduleTimer = window.setInterval(() => {
      try {
        this.pumpAudio();
        this.scheduleAudio();
      } catch (e) {
        console.error('[WebCodecsPlayer] audio schedule error:', e);
      }
    }, AUDIO_SCHEDULE_INTERVAL_MS);
  }

  // ===== 解码器 =====

  private setupDecoders() {
    this.needVideoKey = true;
    this.videoDecoder = new VideoDecoder({
      output: (frame: VideoFrame) => this.onVideoFrame(frame),
      error: (e: Error) => {
        console.warn('[WebCodecsPlayer] video decoder error:', e.message);
        this.needVideoKey = true;
      },
    });
    this.audioDecoder = new AudioDecoder({
      output: (data: AudioData) => this.decodedAudio.push(data),
      error: (e: Error) => {
        console.warn('[WebCodecsPlayer] audio decoder error:', e.message);
      },
    });
  }

  private configureVideoDecoder(config: VideoConfig) {
    this.videoConfig = config;
    console.log('[WebCodecsPlayer] video config:', config.codec, config.codedWidth + 'x' + config.codedHeight);

    try {
      this.videoDecoder?.configure({
        codec: config.codec,
        codedWidth: config.codedWidth,
        codedHeight: config.codedHeight,
        description: config.description,
        optimizeForLatency: false,
      });
    } catch (e: any) {
      console.warn('[WebCodecsPlayer] video decoder configure failed:', e.message);
    }
  }

  private configureAudioDecoder(config: AudioConfig) {
    this.audioConfig = config;
    console.log('[WebCodecsPlayer] audio config:', config.codec, config.sampleRate + 'Hz', config.numberOfChannels + 'ch');

    try {
      this.audioDecoder?.configure({
        codec: config.codec,
        sampleRate: config.sampleRate,
        numberOfChannels: config.numberOfChannels,
        description: config.description,
      });
    } catch (e: any) {
      console.warn('[WebCodecsPlayer] audio decoder configure failed:', e.message);
    }
  }

  private onVideoFrame(frame: VideoFrame) {
    this.decodedFrames++;
    if (!this.canvasSized) {
      this.canvas.width = frame.displayWidth;
      this.canvas.height = frame.displayHeight;
      this.canvasSized = true;
    }
    this.frameQueue.push(frame);
    // Bound VideoFrame memory on the low-power vehicle browser. If rendering
    // falls behind, preserving latency is more useful than retaining old frames.
    const MAX_FRAME_QUEUE = 18;
    while (this.frameQueue.length > MAX_FRAME_QUEUE) {
      this.frameQueue.shift()!.close();
      this.droppedFrames++;
    }
  }

  // ===== Web Audio =====

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

  // ===== 渲染循环 =====

  private loop = () => {
    this.tick();
    if (!this.destroyed) {
      this.raf = requestAnimationFrame(this.loop);
    }
  };

  private tick() {
    try {
      this.compactConsumedSamples();
      this.updateDemuxBackpressure();
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

  // ===== 解码投喂 =====

  private pumpVideo() {
    const dec = this.videoDecoder;
    if (!dec || dec.state !== 'configured') return;
    const MAX_OUTSTANDING = 18;
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
      } catch (e: any) {
        console.warn('[WebCodecsPlayer] video decode error:', e.message);
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
      } catch (e: any) {
        console.warn('[WebCodecsPlayer] audio decode error:', e.message);
      }
    }
  }

  // ===== 同步 =====

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
      .catch(() => {});
  }

  private drawFirstFrame() {
    const f = this.frameQueue[0];
    if (f) {
      this.ctx.drawImage(f, 0, 0, this.canvas.width, this.canvas.height);
    }
  }

  /** 主时钟：AudioContext.currentTime */
  private getMediaTime(): number {
    if (this.ctxStartTime === null || !this.audioCtx) return this.baseMediaTime;
    return this.baseMediaTime + (this.audioCtx.currentTime - this.ctxStartTime);
  }

  /** 将解码后的音频调度到 AudioContext 时间线上 */
  private scheduleAudio() {
    if (this.ctxStartTime === null || !this.audioCtx || !this.gain) return;
    const now = this.audioCtx.currentTime;
    if (this.nextAudioStartTime !== 0 && this.nextAudioStartTime - now > 4) return;

    let scheduledThisTick = 0;
    while (this.decodedAudio.length && scheduledThisTick < 12) {
      const head = this.decodedAudio[0];
      const rate = head.sampleRate;
      const channels = head.numberOfChannels;
      const headTs = head.timestamp / 1e6;
      const headDuration = head.numberOfFrames / rate;

      // 跳过已过期音频
      let startOffsetSec = 0;
      if (this.nextAudioStartTime === 0) {
        if (headTs + headDuration <= this.baseMediaTime) {
          this.decodedAudio.shift()!.close();
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
        if (when < now) when = now + 0.05;
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
        this.decodedAudio.shift()!.close();
      }

      const src = this.audioCtx.createBufferSource();
      src.buffer = buffer;
      src.connect(this.gain);
      src.start(when, startOffsetSec);
      this.activeSources.add(src);
      src.onended = () => this.activeSources.delete(src);
      this.nextAudioStartTime = when + (frames / rate - startOffsetSec);
      this.lastAudioScheduledSec = headTs + headDuration;
      scheduledThisTick++;
    }
  }

  /**
   * Stop the demuxer from parsing the whole title as fast as the network allows.
   * This removes CPU spikes and keeps memory bounded on the vehicle browser.
   */
  private updateDemuxBackpressure() {
    const pendingVideo = this.encodedVideo.length - this.vIdx;
    if (pendingVideo > 240) this.demuxer?.pause();
    else if (pendingVideo < 90) this.demuxer?.resume();
  }

  /** Release references to samples that have already been submitted. */
  private compactConsumedSamples() {
    if (this.vIdx > 600) {
      this.encodedVideo.splice(0, this.vIdx);
      this.vIdx = 0;
    }
    if (this.aIdx > 1200) {
      this.encodedAudio.splice(0, this.aIdx);
      this.aIdx = 0;
    }
  }

  /** 以主时钟为准，呈现视频帧 */
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
    if (now - this.lastTimeReportMs < TIME_REPORT_INTERVAL_MS) return;
    this.lastTimeReportMs = now;
    this.cb.onTime?.(Math.min(clock, this.durationSec || Infinity));
  }

  // ===== 播放控制 =====

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

  setMuted(m: boolean) {
    if (this.gain) this.gain.gain.value = m ? 0 : this.volume;
  }

  unmute() {
    if (this.gain) this.gain.gain.value = this.volume;
  }

  setPlaybackRate(_r: number) {
    // Web Audio API 不直接支持变速，需要重采样
    console.warn('[WebCodecsPlayer] playbackRate not supported in webcodecs mode');
  }

  seek(seconds: number) {
    if (this.demuxer) {
      // 清空管线
      this.flushPipeline();
      // Drop decoder-internal work as well as our JS queues. Without reset(),
      // frames from before the seek may arrive after the new position starts.
      try { this.videoDecoder?.reset(); } catch {}
      try { this.audioDecoder?.reset(); } catch {}
      this.baseMediaTime = seconds;
      this.ctxStartTime = null;
      this.lastAudioScheduledSec = 0;
      this.nextAudioStartTime = 0;
      // 重新定位 demuxer
      this.demuxer.seekTo(seconds);
    }
  }

  private flushPipeline() {
    for (const f of this.frameQueue) f.close();
    this.frameQueue = [];
    for (const d of this.decodedAudio) d.close();
    this.decodedAudio = [];
    this.encodedVideo = [];
    this.encodedAudio = [];
    this.vIdx = 0;
    this.aIdx = 0;
    this.needVideoKey = true;

    for (const src of this.activeSources) {
      try { src.stop(); } catch {}
    }
    this.activeSources.clear();
  }

  setShowDebug(s: boolean) {
    this.showDebug = s;
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

  getStats() {
    const now = performance.now();
    const dt = Math.max(1, (now - this.statsMark.t) / 1000);
    const renderFps = Math.round((this.renderedFrames - this.statsMark.rendered) / dt);
    const decodeFps = Math.round((this.decodedFrames - this.statsMark.decoded) / dt);
    this.statsMark = { t: now, rendered: this.renderedFrames, decoded: this.decodedFrames };

    const clock = this.getMediaTime();
    return {
      state: this.state,
      renderFps,
      decodeFps,
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
      audioCtx: this.audioCtx?.state || 'none',
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
      `[WebCodecs] t=${stats.currentSec}s  audioCtx=${stats.audioCtx}`,
      `[WebCodecs] decoded=${stats.decodedFrames}  rendered=${stats.renderedFrames}`,
      `[WebCodecs] demux v${stats.demuxVideoQueue} a${stats.demuxAudioQueue}`,
      `[WebCodecs] videoConfig: ${this.videoConfig ? 'YES' : 'no'}  audioConfig: ${this.audioConfig ? 'YES' : 'no'}`,
    ];
    lines.forEach((line, i) => ctx.fillText(line, 10, 20 + i * 18));
    ctx.restore();
  }

  // ===== 生命周期 =====

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

    if (this.raf) { cancelAnimationFrame(this.raf); this.raf = 0; }
    if (this.audioScheduleTimer) { clearInterval(this.audioScheduleTimer); this.audioScheduleTimer = 0; }

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

    try { this.videoDecoder?.close(); } catch {}
    try { this.audioDecoder?.close(); } catch {}
    this.videoDecoder = null;
    this.audioDecoder = null;
    this.videoConfig = null;
    this.audioConfig = null;

    for (const src of this.activeSources) {
      try { src.stop(); } catch {}
    }
    this.activeSources.clear();

    try { this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height); } catch {}
  }

  destroy() {
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
}