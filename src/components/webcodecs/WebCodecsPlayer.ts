// @ts-nocheck
import { HLSTSDemuxer } from './HLSTSDemuxer';

export type PlayerState = 'idle' | 'buffering' | 'playing' | 'paused' | 'ended' | 'error';

export interface PlayerCallbacks {
  onTime?: (currentSec: number) => void;
  onDurationChange?: (durationSec: number) => void;
  onStateChange?: (state: PlayerState) => void;
  onError?: (message: string) => void;
}

const TIME_REPORT_INTERVAL_MS = 250;

const BUFFER_HIGH = 30;
const BUFFER_LOW = 15;
const MAX_OUTSTANDING_FRAMES = 30;
const VIDEO_STALL_MS = 4000;
const MAX_STALL_RECOVERIES = 3;

const AUDIO_AHEAD_LOW = 4;
const AUDIO_AHEAD_HIGH = 6;
const AUDIO_DECODE_AHEAD = 8;
const AUDIO_START_DELAY = 0.12;
const AUDIO_PRIME_BUFFER = 0.35;
const AUDIO_RESUME_BUFFER = 0.7;
const AUDIO_UNDERRUN_GUARD = 0.12;
const AUDIO_DISCONTINUITY_SEC = 0.25;
const AUDIO_BATCH_GAP_TOLERANCE_SEC = 0.002;
const AUDIO_TICK_MS = 250;

export class WebCodecsPlayer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private cb: PlayerCallbacks;

  private audioCtx: AudioContext;
  private gain: GainNode;
  private mediaDest: MediaStreamAudioDestinationNode;
  private audioEl: HTMLAudioElement;

  private videoDecoder: VideoDecoder | null = null;
  private audioDecoder: AudioDecoder | null = null;
  private videoConfig: VideoConfig | null = null;
  private audioConfig: AudioConfig | null = null;
  private videoDemuxer: HLSTSDemuxer | null = null;
  private audioDemuxer: HLSTSDemuxer | null = null;

  private encodedVideo: EncodedSample[] = [];
  private encodedAudio: EncodedSample[] = [];
  private vIdx = 0;
  private aIdx = 0;
  private videoDone = false;
  private audioDone = false;

  private frameQueue: VideoFrame[] = [];
  private decodedAudio: AudioData[] = [];
  private activeSources = new Set<AudioBufferSourceNode>();

  private state: PlayerState = 'idle';
  private durationSec = 0;
  private baseMediaTime = 0;
  private ctxStartTime: number | null = null;
  private lastAudioScheduledSec = 0;
  private nextAudioStartTime = 0;
  private volume = 1;
  private wantPlaying = true;
  private seeking = false;
  private needVideoKey = true;
  private lastVideoOutputAt = 0;
  private stallRecoveries = 0;
  private lastTimeReportMs = 0;
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

  private onVisibilityChange = () => {
    if (document.visibilityState === 'hidden') this.pauseForInterruption('document hidden');
  };
  private onPageHide = () => this.pauseForInterruption('pagehide');
  private onWindowBlur = () => this.pauseForInterruption('window blur');
  private onAudioElementPause = () => {
    if (this.destroyed || !this.wantPlaying) return;
    if (this.state === 'playing' || this.state === 'buffering') {
      this.pauseForInterruption('audio sink paused externally');
    }
  };

  constructor(canvas: HTMLCanvasElement, cb: PlayerCallbacks = {}) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('2d canvas context unavailable');
    this.ctx = ctx;
    this.cb = cb;
    this.audioCtx = createAudioContext();
    this.gain = this.audioCtx.createGain();
    this.mediaDest = this.audioCtx.createMediaStreamDestination();
    this.gain.connect(this.mediaDest);
    this.audioEl = document.createElement('audio');
    this.audioEl.srcObject = this.mediaDest.stream;
    this.audioEl.style.display = 'none';
    this.audioEl.addEventListener('pause', this.onAudioElementPause);
    document.body.appendChild(this.audioEl);
    this.installInterruptionHandlers();
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
    this.stallRecoveries = 0;
    this.lastTimeReportMs = 0;
    this.lastVideoOutputAt = performance.now();
    this.renderedFrames = 0;
    this.decodedFrames = 0;
    this.droppedFrames = 0;
    this.statsMark = { t: performance.now(), rendered: 0, decoded: 0 };
    this.setState('buffering');
    console.log('[WebCodecsPlayer] load startAt=' + startAt);

    this.setupDecoders();

    let durationFromVideo = 0;
    let configsReceived = 0;
    const checkReady = () => {
      configsReceived++;
      if (configsReceived === 2) {
        this.durationSec = Math.max(durationFromVideo, (this.videoDemuxer?.getDuration() || 0));
        this.cb.onDurationChange?.(this.durationSec);
      }
    };

    this.videoDemuxer = new HLSTSDemuxer({
      url,
      kind: 'video',
      onConfig: (c) => {
        this.configureVideo(c as VideoConfig);
        durationFromVideo = this.videoDemuxer?.getDuration() || 0;
        checkReady();
      },
      onSample: (s) => this.encodedVideo.push(s),
      onDone: () => (this.videoDone = true),
      onError: (e) => this.fail('video: ' + errMsg(e)),
      onEvent: (m) => console.warn('[WebCodecsPlayer] demux:', m),
    });

    this.audioDemuxer = new HLSTSDemuxer({
      url,
      kind: 'audio',
      onConfig: (c) => {
        this.configureAudio(c as AudioConfig);
        checkReady();
      },
      onSample: (s) => this.encodedAudio.push(s),
      onDone: () => (this.audioDone = true),
      onError: (e) => this.fail('audio: ' + errMsg(e)),
      onEvent: (m) => console.warn('[WebCodecsPlayer] demux:', m),
    });

    void this.videoDemuxer.start(startAt);
    void this.audioDemuxer.start(startAt);
    this.audioTimer = window.setInterval(() => this.tick(), AUDIO_TICK_MS);
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

  private configureVideo(c: VideoConfig) {
    this.videoConfig = c;
    console.log('[WebCodecsPlayer] video config', c.codec, c.codedWidth + 'x' + c.codedHeight);
    this.videoDecoder?.configure({
      codec: c.codec,
      codedWidth: c.codedWidth,
      codedHeight: c.codedHeight,
      description: c.description,
      optimizeForLatency: false,
    });
  }

  private configureAudio(c: AudioConfig) {
    this.audioConfig = c;
    console.log('[WebCodecsPlayer] audio config', c.codec, c.sampleRate + 'Hz', c.numberOfChannels + 'ch');
    this.audioDecoder?.configure({
      codec: c.codec,
      sampleRate: c.sampleRate,
      numberOfChannels: c.numberOfChannels,
      description: c.description,
    });
  }

  private matchAudioContextRate(rate: number) {
    const oldRate = this.audioCtx.sampleRate;
    let ctx: AudioContext;
    try {
      ctx = createAudioContext(rate);
      if (Math.abs(ctx.sampleRate - rate) > 1) {
        void ctx.close().catch(() => {});
        return;
      }
    } catch {
      return;
    }
    this.stopAllAudio();
    if (this.ctxStartTime !== null) {
      this.baseMediaTime = this.getMediaTime();
      this.ctxStartTime = null;
    }
    void this.audioCtx.close().catch(() => {});
    this.audioCtx = ctx;
    this.gain = ctx.createGain();
    this.gain.gain.value = this.volume;
    this.mediaDest = ctx.createMediaStreamDestination();
    this.gain.connect(this.mediaDest);
    this.audioEl.srcObject = this.mediaDest.stream;
    this.nextAudioStartTime = 0;
    console.log('[WebCodecsPlayer] audio graph rebuilt at', rate, 'Hz');
    if (this.wantPlaying) {
      void this.resumeAudioContext().catch(() => {});
      void this.audioEl.play().catch(() => {});
    }
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
        this.manageAudioContinuity(clock);
        this.presentVideo(clock);
        this.reportTime(clock);
        this.checkEnded(clock);
        this.watchdog();
      }

      if (this.showDebug) {
        this.drawDebugOverlay();
      }

      this.manageBackpressure();
    } catch (e) {
      console.error('[WebCodecsPlayer] tick error:', e);
    }
  }

  private watchdog() {
    if (this.state !== 'playing' || this.seeking) return;
    const pendingInput =
      this.vIdx < this.encodedVideo.length || (this.videoDecoder?.decodeQueueSize ?? 0) > 0 || !this.videoDone;
    if (!pendingInput || this.frameQueue.length > 0) return;
    const stalledMs = performance.now() - this.lastVideoOutputAt;
    if (stalledMs < VIDEO_STALL_MS) return;

    this.stallRecoveries++;
    this.lastVideoOutputAt = performance.now();
    if (this.stallRecoveries > MAX_STALL_RECOVERIES) {
      console.error('[WebCodecsPlayer] video decoder stalled repeatedly');
      this.fail('video decoder stalled repeatedly');
      return;
    }
    const at = this.getMediaTime();
    console.warn('[WebCodecsPlayer] video stalled, recovering at', at);
    void this.seek(at);
  }

  private pumpVideo() {
    const dec = this.videoDecoder;
    if (!dec || dec.state !== 'configured') return;
    while (
      this.vIdx < this.encodedVideo.length &&
      this.frameQueue.length + dec.decodeQueueSize < MAX_OUTSTANDING_FRAMES
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
    const clock = this.getMediaTime();
    while (
      this.aIdx < this.encodedAudio.length &&
      dec.decodeQueueSize < 64 &&
      this.audioReadyAheadSec(clock) < AUDIO_DECODE_AHEAD
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

  private audioReadyAheadSec(clock: number): number {
    return Math.max(0, Math.max(this.lastAudioScheduledSec, this.decodedAudioEndSec()) - clock);
  }

  private decodedAudioEndSec(): number {
    const last = this.decodedAudio[this.decodedAudio.length - 1];
    if (!last) return 0;
    return last.timestamp / 1e6 + last.numberOfFrames / last.sampleRate;
  }

  private maybePrime() {
    const haveVideo = this.frameQueue.length > 0;
    const haveAudio = this.audioDone || this.audioReadyAheadSec(this.baseMediaTime) >= AUDIO_PRIME_BUFFER;
    if (!haveVideo || !haveAudio) return;

    const first = this.decodedAudio[0];
    if (first && first.sampleRate !== this.audioCtx.sampleRate) {
      this.matchAudioContextRate(first.sampleRate);
    }

    this.ctxStartTime = this.audioCtx.currentTime + AUDIO_START_DELAY;
    if (this.wantPlaying) {
      this.resumeAudio();
    } else {
      this.pauseAudioOutput({ pauseSink: true });
      this.setState('paused');
    }
  }

  private resumeAudio() {
    this.resumeFetchers();
    Promise.all([this.resumeAudioContext(), this.audioEl.play()])
      .then(() => {
        if (this.audioCtx.state === 'running' && !this.audioEl.paused) {
          if (this.state !== 'ended') this.setState('playing');
        } else {
          this.setState('paused');
        }
      })
      .catch(() => this.setState('paused'));
  }

  private resumeAudioContext(): Promise<void> {
    return this.audioCtx.resume();
  }

  private pauseAudioOutput({ pauseSink }: { pauseSink: boolean }) {
    void this.audioCtx.suspend().catch(() => {});
    if (pauseSink && !this.audioEl.paused) {
      this.audioEl.pause();
    }
  }

  private pauseFetchers() {
    this.videoDemuxer?.pause();
    this.audioDemuxer?.pause();
  }

  private resumeFetchers() {
    this.videoDemuxer?.resume();
    this.audioDemuxer?.resume();
  }

  private drawFirstFrame() {
    const f = this.frameQueue[0];
    if (f) {
      this.ctx.drawImage(f, 0, 0, this.canvas.width, this.canvas.height);
      this.lastFrameDrawn = true;
    }
  }

  private getMediaTime(): number {
    if (this.ctxStartTime === null) return this.baseMediaTime;
    return this.baseMediaTime + (this.audioCtx.currentTime - this.ctxStartTime);
  }

  private scheduleAudio() {
    if (this.ctxStartTime === null) return;
    const now = this.audioCtx.currentTime;
    if (this.nextAudioStartTime !== 0 && this.nextAudioStartTime - now > AUDIO_AHEAD_LOW) return;

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
          const target = now + 0.05;
          this.ctxStartTime += target - idealWhen;
          when = target;
          console.warn('[WebCodecsPlayer] audio underrun - clock rebased');
        } else if (Math.abs(idealWhen - when) > AUDIO_DISCONTINUITY_SEC) {
          when = Math.max(idealWhen, this.nextAudioStartTime);
        }
      }

      if (when > now + AUDIO_AHEAD_HIGH) break;

      const batch: AudioData[] = [this.decodedAudio.shift()!];
      let frames = head.numberOfFrames;
      let endTs = headTs + headDuration;
      while (this.decodedAudio.length) {
        const next = this.decodedAudio[0];
        if (next.sampleRate !== rate || next.numberOfChannels !== channels) break;
        if (Math.abs(next.timestamp / 1e6 - endTs) > AUDIO_BATCH_GAP_TOLERANCE_SEC) break;
        if (when + frames / rate >= now + AUDIO_AHEAD_HIGH) break;
        this.decodedAudio.shift();
        batch.push(next);
        frames += next.numberOfFrames;
        endTs = next.timestamp / 1e6 + next.numberOfFrames / rate;
      }

      let buffer: AudioBuffer;
      try {
        buffer = this.audioCtx.createBuffer(channels, frames, rate);
        const channelData = Array.from({ length: channels }, () => new Float32Array(frames));
        let offset = 0;
        for (const data of batch) {
          for (let ch = 0; ch < channels; ch++) {
            const dest = channelData[ch].subarray(offset, offset + data.numberOfFrames);
            data.copyTo(dest, { planeIndex: ch, format: 'f32-planar' });
          }
          offset += data.numberOfFrames;
        }
        for (let ch = 0; ch < channels; ch++) buffer.copyToChannel(channelData[ch], ch);
      } finally {
        for (const data of batch) data.close();
      }

      const src = this.audioCtx.createBufferSource();
      src.buffer = buffer;
      src.connect(this.gain);
      src.start(when, startOffsetSec);
      this.activeSources.add(src);
      src.onended = () => this.activeSources.delete(src);
      this.nextAudioStartTime = when + (frames / rate - startOffsetSec);
      this.lastAudioScheduledSec = endTs;
    }
  }

  private manageAudioContinuity(clock: number) {
    if (!this.wantPlaying || this.ctxStartTime === null || this.state === 'ended' || this.state === 'error') return;

    const readyAhead = this.audioReadyAheadSec(clock);
    if (this.state === 'playing' && readyAhead < AUDIO_UNDERRUN_GUARD && !this.audioDone) {
      console.warn('[WebCodecsPlayer] audio underrun guard');
      this.pauseAudioOutput({ pauseSink: false });
      this.setState('buffering');
      return;
    }

    if (this.state === 'buffering' && readyAhead >= AUDIO_RESUME_BUFFER) {
      this.resumeAudio();
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

  private drawDebugOverlay() {
    const stats = this.getStats();
    const ctx = this.ctx;
    const w = this.canvas.width || 640;
    ctx.save();
    ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
    ctx.fillRect(0, 0, w, 360);
    ctx.fillStyle = '#0f0';
    ctx.font = '13px monospace';
    const vd = stats.vDemux || {};
    const ad = stats.aDemux || {};
    const lines = [
      `[WC] state: ${stats.state}`,
      `[WC] render: ${stats.renderFps} fps  decode: ${stats.decodeFps} fps`,
      `[WC] frameQueue: ${stats.queued}  inDecode: ${stats.decodeQueue}  dropped: ${stats.dropped}`,
      `[WC] buffer v${stats.bufferedVideoSec}s · a${stats.bufferedAudioSec}s`,
      `[WC] ${stats.resolution} ${stats.codec}`,
      `[WC] t=${stats.currentSec}s`,
      `[WC] decoded=${stats.decodedFrames} rendered=${stats.renderedFrames}`,
      `[WC] demux queue v${stats.demuxVideoQueue} a${stats.demuxAudioQueue}`,
      `--- V Demux ---`,
      `  m3u8: ${vd.m3u8Loaded ? 'OK' : 'pending'}  segs: ${vd.segmentCount || 0}`,
      `  dl: ${vd.segmentsDownloaded || 0}/${vd.segmentCount || 0}  ${Math.round((vd.bytesDownloaded || 0) / 1024)} KB`,
      `  transmux: ${Math.round((vd.transmuxBytesIn || 0) / 1024)} KB  mp4Ready: ${vd.mp4Ready ? 'YES' : 'no'}`,
      `  samples: ${vd.samplesOutput || 0}`,
      vd.error ? `  ERROR: ${vd.error}` : '',
      `--- A Demux ---`,
      `  m3u8: ${ad.m3u8Loaded ? 'OK' : 'pending'}  segs: ${ad.segmentCount || 0}`,
      `  dl: ${ad.segmentsDownloaded || 0}/${ad.segmentCount || 0}  ${Math.round((ad.bytesDownloaded || 0) / 1024)} KB`,
      `  transmux: ${Math.round((ad.transmuxBytesIn || 0) / 1024)} KB  mp4Ready: ${ad.mp4Ready ? 'YES' : 'no'}`,
      `  samples: ${ad.samplesOutput || 0}`,
      ad.error ? `  ERROR: ${ad.error}` : '',
    ].filter(Boolean);
    lines.forEach((line, i) => {
      ctx.fillText(line, 10, 18 + i * 16);
    });
    ctx.restore();
  }

  private reportTime(clock: number) {
    const now = performance.now();
    if (now - this.lastTimeReportMs < TIME_REPORT_INTERVAL_MS) return;
    this.lastTimeReportMs = now;
    this.cb.onTime?.(Math.min(clock, this.durationSec));
  }

  private checkEnded(clock: number) {
    if (
      this.videoDone &&
      this.audioDone &&
      this.vIdx >= this.encodedVideo.length &&
      this.aIdx >= this.encodedAudio.length &&
      this.frameQueue.length === 0 &&
      this.decodedAudio.length === 0 &&
      clock >= this.durationSec - 0.3
    ) {
      if (this.state !== 'ended') {
        this.setState('ended');
        this.pauseAudioOutput({ pauseSink: true });
      }
    }
  }

  private manageBackpressure() {
    if (this.seeking) return;
    if (!this.wantPlaying) {
      this.pauseFetchers();
      return;
    }
    const clock = this.getMediaTime();
    this.applyBackpressure(this.videoDemuxer, this.encodedVideo, clock);
    this.applyBackpressure(this.audioDemuxer, this.encodedAudio, clock);
    if (this.vIdx > 600) {
      this.encodedVideo.splice(0, this.vIdx);
      this.vIdx = 0;
    }
    if (this.aIdx > 1200) {
      this.encodedAudio.splice(0, this.aIdx);
      this.aIdx = 0;
    }
  }

  private applyBackpressure(dmx: HLSTSDemuxer | null, buf: EncodedSample[], clock: number) {
    if (!dmx) return;
    const last = buf[buf.length - 1];
    if (!last) return;
    const ahead = last.timestamp / 1e6 - clock;
    if (ahead > BUFFER_HIGH) dmx.pause();
    else if (ahead < BUFFER_LOW) dmx.resume();
  }

  private installInterruptionHandlers() {
    document.addEventListener('visibilitychange', this.onVisibilityChange);
    window.addEventListener('pagehide', this.onPageHide);
    window.addEventListener('blur', this.onWindowBlur);
  }

  private removeInterruptionHandlers() {
    document.removeEventListener('visibilitychange', this.onVisibilityChange);
    window.removeEventListener('pagehide', this.onPageHide);
    window.removeEventListener('blur', this.onWindowBlur);
  }

  play() {
    this.wantPlaying = true;
    this.resumeFetchers();
    if (this.ctxStartTime === null) {
      void this.resumeAudioContext().catch(() => {});
      void this.audioEl.play().catch(() => {});
      return;
    }
    if (this.state === 'ended') {
      void this.seek(0);
      return;
    }
    this.resumeAudio();
  }

  pause() {
    this.wantPlaying = false;
    this.pauseFetchers();
    if (this.ctxStartTime !== null || this.state === 'buffering') {
      this.pauseAudioOutput({ pauseSink: true });
      if (this.state !== 'ended' && this.state !== 'error') this.setState('paused');
    }
  }

  private pauseForInterruption(reason: string) {
    if (this.destroyed || (!this.wantPlaying && this.state !== 'playing' && this.state !== 'buffering')) return;
    console.log('[WebCodecsPlayer] pausing:', reason);
    this.wantPlaying = false;
    this.pauseFetchers();
    this.pauseAudioOutput({ pauseSink: true });
    if (this.state !== 'ended' && this.state !== 'error') {
      this.setState('paused');
    }
  }

  togglePlay() {
    if (this.state === 'playing') this.pause();
    else this.play();
  }

  setVolume(v: number) {
    this.volume = Math.max(0, Math.min(1, v));
    this.gain.gain.value = this.volume;
  }

  async seek(seconds: number) {
    if (!this.videoDemuxer || !this.audioDemuxer) return;
    const t = Math.max(0, Math.min(seconds, this.durationSec));
    this.seeking = true;
    this.setState('buffering');

    try {
      await Promise.all([this.videoDemuxer.pauseAndIdle(), this.audioDemuxer.pauseAndIdle()]);
      this.videoDemuxer.seekTo(t);
      this.audioDemuxer.seekTo(t);

      this.resetDecodeState();
      this.baseMediaTime = t;
      this.ctxStartTime = null;

      this.videoDemuxer.resume();
      this.audioDemuxer.resume();
    } finally {
      this.seeking = false;
    }
  }

  private resetDecodeState() {
    this.stopAllAudio();
    for (const f of this.frameQueue) f.close();
    this.frameQueue = [];
    for (const d of this.decodedAudio) d.close();
    this.decodedAudio = [];
    this.encodedVideo = [];
    this.encodedAudio = [];
    this.vIdx = 0;
    this.aIdx = 0;
    this.videoDone = false;
    this.audioDone = false;
    this.lastAudioScheduledSec = 0;
    this.nextAudioStartTime = 0;

    try {
      this.videoDecoder?.reset();
    } catch {
      // ignore
    }
    try {
      this.audioDecoder?.reset();
    } catch {
      // ignore
    }
    if (this.videoConfig) this.configureVideo(this.videoConfig);
    if (this.audioConfig) this.configureAudio(this.audioConfig);
    this.needVideoKey = true;
  }

  private stopAllAudio() {
    for (const src of this.activeSources) {
      try {
        src.onended = null;
        src.stop();
      } catch {
        // ignore
      }
    }
    this.activeSources.clear();
  }

  private teardownPipeline() {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    if (this.audioTimer) clearInterval(this.audioTimer);
    this.audioTimer = 0;
    this.videoDemuxer?.destroy();
    this.audioDemuxer?.destroy();
    this.videoDemuxer = null;
    this.audioDemuxer = null;
    this.stopAllAudio();
    for (const f of this.frameQueue) f.close();
    this.frameQueue = [];
    for (const d of this.decodedAudio) d.close();
    this.decodedAudio = [];
    this.encodedVideo = [];
    this.encodedAudio = [];
    this.vIdx = 0;
    this.aIdx = 0;
    this.videoDone = false;
    this.audioDone = false;
    this.canvasSized = false;
    try {
      if (this.videoDecoder && this.videoDecoder.state !== 'closed') this.videoDecoder.close();
    } catch {
      // ignore
    }
    try {
      if (this.audioDecoder && this.audioDecoder.state !== 'closed') this.audioDecoder.close();
    } catch {
      // ignore
    }
    this.videoDecoder = null;
    this.audioDecoder = null;
  }

  destroy() {
    this.destroyed = true;
    this.removeInterruptionHandlers();
    this.teardownPipeline();
    this.audioEl.removeEventListener('pause', this.onAudioElementPause);
    this.pauseAudioOutput({ pauseSink: true });
    this.audioEl.srcObject = null;
    this.audioEl.remove();
    void this.audioCtx.close();
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
    const lastV = this.encodedVideo[this.encodedVideo.length - 1];
    const vStats = this.videoDemuxer?.getStats?.();
    const aStats = this.audioDemuxer?.getStats?.();
    return {
      state: this.state,
      renderFps: Math.round(renderFps),
      decodeFps: Math.round(decodeFps),
      queued: this.frameQueue.length,
      decodeQueue: this.videoDecoder?.decodeQueueSize ?? 0,
      dropped: this.droppedFrames,
      bufferedVideoSec: lastV ? +Math.max(0, lastV.timestamp / 1e6 - clock).toFixed(1) : 0,
      bufferedAudioSec: +Math.max(0, this.lastAudioScheduledSec - clock).toFixed(1),
      resolution: this.videoConfig ? `${this.videoConfig.codedWidth}x${this.videoConfig.codedHeight}` : '',
      codec: this.videoConfig?.codec ?? '',
      currentSec: +clock.toFixed(1),
      decodedFrames: this.decodedFrames,
      renderedFrames: this.renderedFrames,
      demuxVideoQueue: this.encodedVideo.length - this.vIdx,
      demuxAudioQueue: this.encodedAudio.length - this.aIdx,
      vDemux: vStats,
      aDemux: aStats,
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

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function audioContextClass(): typeof AudioContext {
  return (
    window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
  );
}

function createAudioContext(sampleRate?: number): AudioContext {
  const Ctor = audioContextClass();
  const opts: AudioContextOptions = { latencyHint: 'playback' };
  if (sampleRate) opts.sampleRate = sampleRate;

  try {
    return new Ctor(opts);
  } catch {
    if (sampleRate) {
      try {
        return new Ctor({ sampleRate } as AudioContextOptions);
      } catch {
        // fall through
      }
    }
    return new Ctor();
  }
}
