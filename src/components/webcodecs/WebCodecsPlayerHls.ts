// @ts-nocheck
import Hls from 'hls.js';

export type PlayerState = 'idle' | 'buffering' | 'playing' | 'paused' | 'ended' | 'error';

export interface PlayerCallbacks {
  onTime?: (currentSec: number) => void;
  onDurationChange?: (durationSec: number) => void;
  onStateChange?: (state: PlayerState) => void;
  onError?: (message: string) => void;
}

const TIME_REPORT_INTERVAL_MS = 250;
const AUDIO_TICK_MS = 250;

export class WebCodecsPlayer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private cb: PlayerCallbacks;

  private hls: any = null;
  private videoEl: HTMLVideoElement | null = null;

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
  private audioTimer = 0;
  private canvasSized = false;
  private showDebug = false;
  private lastFrameDrawn = false;

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
  private needVideoKey = true;
  private lastVideoOutputAt = 0;
  private volume = 1;

  constructor(canvas: HTMLCanvasElement, cb: PlayerCallbacks = {}) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('2d canvas context unavailable');
    this.ctx = ctx;
    this.cb = cb;
  }

  static isSupported(): boolean {
    return typeof VideoDecoder === 'function' && typeof AudioDecoder === 'function' && Hls.isSupported();
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

    if (!Hls.isSupported()) {
      this.fail('hls.js not supported');
      return;
    }

    const hls = new Hls({
      enableWorker: true,
      lowLatencyMode: false,
      backBufferLength: 90,
    });

    this.hls = hls;

    hls.on(Hls.Events.ERROR, (_evt: any, data: any) => {
      if (data.fatal) {
        console.error('[WebCodecsPlayer] HLS fatal error:', data.type, data.details);
        this.fail('hls: ' + data.details);
      }
    });

    hls.on(Hls.Events.MANIFEST_PARSED, (_evt: any, data: any) => {
      console.log('[WebCodecsPlayer] manifest parsed, levels:', data.levels?.length || 0);
    });

    hls.on(Hls.Events.FRAG_LOADED, (_evt: any, data: any) => {
      console.log('[WebCodecsPlayer] frag loaded:', data.frag?.sn, data.frag?.duration);
    });

    hls.on(Hls.Events.FRAG_PARSED, (_evt: any, data: any) => {
      const frag = data.frag;
      const payload = data.payload || {};
      console.log('[WebCodecsPlayer] frag parsed:', frag?.sn, 'video samples:', payload.video?.samples?.length || 0, 'audio samples:', payload.audio?.samples?.length || 0);

      if (payload.video?.samples?.length && !this.videoConfig) {
        this.configureVideoFromPayload(payload.video);
      }
      if (payload.audio?.samples?.length && !this.audioConfig) {
        this.configureAudioFromPayload(payload.audio);
      }

      if (payload.video?.samples?.length) {
        this.ingestVideoSamples(payload.video.samples);
      }
      if (payload.audio?.samples?.length) {
        this.ingestAudioSamples(payload.audio.samples);
      }
    });

    hls.on(Hls.Events.LEVEL_LOADED, (_evt: any, data: any) => {
      const dur = data.details?.totalduration || 0;
      if (dur > 0) {
        this.durationSec = dur;
        this.cb.onDurationChange?.(dur);
      }
    });

    hls.loadSource(url);
    // 不 attach 到 video，我们自己解码渲染

    this.loop();
    this.audioTimer = window.setInterval(() => this.tick(), AUDIO_TICK_MS);
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

  private configureVideoFromPayload(videoPayload: any) {
    const codec = videoPayload.codec || 'avc1.4d401f';
    const width = videoPayload.width || 1920;
    const height = videoPayload.height || 1080;
    let description: Uint8Array | undefined = undefined;

    if (videoPayload.initSegment?.data) {
      description = new Uint8Array(videoPayload.initSegment.data);
    } else if (videoPayload.track?.initSegment) {
      description = new Uint8Array(videoPayload.track.initSegment);
    }

    this.videoConfig = { codec, codedWidth: width, codedHeight: height, description };
    console.log('[WebCodecsPlayer] video config:', codec, width + 'x' + height);

    try {
      const config: any = {
        codec: codec,
        codedWidth: width,
        codedHeight: height,
        optimizeForLatency: false,
      };
      if (description) config.description = description;
      this.videoDecoder?.configure(config);
    } catch (e) {
      console.warn('[WebCodecsPlayer] video decoder configure failed:', e);
    }
  }

  private configureAudioFromPayload(audioPayload: any) {
    const codec = audioPayload.codec || 'mp4a.40.2';
    const sampleRate = audioPayload.sampleRate || 44100;
    const channels = audioPayload.channelCount || 2;
    let description: Uint8Array | undefined = undefined;

    if (audioPayload.initSegment?.data) {
      description = new Uint8Array(audioPayload.initSegment.data);
    } else if (audioPayload.track?.initSegment) {
      description = new Uint8Array(audioPayload.track.initSegment);
    }

    this.audioConfig = { codec, sampleRate, numberOfChannels: channels, description };
    console.log('[WebCodecsPlayer] audio config:', codec, sampleRate + 'Hz', channels + 'ch');

    try {
      const config: any = {
        codec: codec,
        sampleRate: sampleRate,
        numberOfChannels: channels,
      };
      if (description) config.description = description;
      this.audioDecoder?.configure(config);
    } catch (e) {
      console.warn('[WebCodecsPlayer] audio decoder configure failed:', e);
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

  private ingestAudioSamples(samples: any[]) {
    for (const s of samples) {
      this.encodedAudio.push({
        key: true,
        timestamp: Math.round((s.pts ?? 0) * 1e6),
        duration: Math.round((s.duration || 0) * 1e6),
        data: s.data || s.unit || s,
      });
    }
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
    const audioReady = this.decodedAudio.length > 0;
    const haveAudio = audioReady;
    if (!haveVideo || !haveAudio) return;

    const first = this.decodedAudio[0];
    if (first && this.audioCtx && first.sampleRate !== this.audioCtx.sampleRate) {
      // 重建 audio context
    }

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

  private reportTime(clock: number) {
    const now = performance.now();
    if (now - this.lastTimeReportMs < TIME_REPORT_INTERVAL_MS) return;
    this.lastTimeReportMs = now;
    this.cb.onTime?.(Math.min(clock, this.durationSec));
  }

  private drawDebugOverlay() {
    const stats = this.getStats();
    const ctx = this.ctx;
    const w = this.canvas.width || 640;
    ctx.save();
    ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
    ctx.fillRect(0, 0, w, 280);
    ctx.fillStyle = '#0f0';
    ctx.font = '13px monospace';
    const lines = [
      `[HLS-WC] state: ${stats.state}`,
      `[HLS-WC] render: ${stats.renderFps} fps  decode: ${stats.decodeFps} fps`,
      `[HLS-WC] frameQueue: ${stats.queued}  inDecode: ${stats.decodeQueue}  dropped: ${stats.dropped}`,
      `[HLS-WC] ${stats.resolution} ${stats.codec}`,
      `[HLS-WC] t=${stats.currentSec}s`,
      `[HLS-WC] decoded=${stats.decodedFrames} rendered=${stats.renderedFrames}`,
      `[HLS-WC] demux queue v${stats.demuxVideoQueue} a${stats.demuxAudioQueue}`,
      `[HLS-WC] videoConfig: ${this.videoConfig ? 'YES' : 'no'}  audioConfig: ${this.audioConfig ? 'YES' : 'no'}`,
      `[HLS-WC] audioCtx: ${this.audioCtx?.state || 'none'}`,
    ];
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
    // TODO: seek 逻辑
    console.warn('[WebCodecsPlayer] seek not implemented yet');
  }

  private teardownPipeline() {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    if (this.audioTimer) clearInterval(this.audioTimer);
    this.audioTimer = 0;

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
