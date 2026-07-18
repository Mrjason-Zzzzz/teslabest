// @ts-nocheck
import * as muxjs from 'mux.js';
import {
  createFile,
  DataStream,
} from 'mp4box';

export type TrackKind = 'video' | 'audio';

export interface VideoConfig {
  kind: 'video';
  codec: string;
  codedWidth: number;
  codedHeight: number;
  description?: Uint8Array;
}

export interface AudioConfig {
  kind: 'audio';
  codec: string;
  sampleRate: number;
  numberOfChannels: number;
  description?: Uint8Array;
}

export type StreamConfig = VideoConfig | AudioConfig;

export interface EncodedSample {
  key: boolean;
  timestamp: number;
  duration: number;
  data: Uint8Array;
}

interface DemuxerOptions {
  url: string;
  kind: TrackKind;
  onConfig: (config: StreamConfig) => void;
  onSample: (sample: EncodedSample) => void;
  onDone: () => void;
  onError: (e: unknown) => void;
  onEvent?: (msg: string) => void;
}

const FETCH_TIMEOUT_MS = 15000;
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 500;

interface Segment {
  url: string;
  duration: number;
  startTime: number;
}

export class HLSTSDemuxer {
  private url: string;
  private kind: TrackKind;
  private opts: DemuxerOptions;

  private segments: Segment[] = [];
  private durationSec = 0;
  private currentSegmentIndex = 0;
  private paused = false;
  private aborted = false;
  private eofSignaled = false;
  private gen = 0;
  private resumeResolve: (() => void) | null = null;

  private mp4: MP4File | null = null;
  private trackId = -1;
  private transmuxer: any = null;
  private initSegmentAppended = false;
  private mp4ByteOffset = 0;

  private stats = {
    m3u8Loaded: false,
    segmentCount: 0,
    currentSegment: 0,
    segmentsDownloaded: 0,
    bytesDownloaded: 0,
    transmuxBytesIn: 0,
    mp4Ready: false,
    samplesOutput: 0,
    error: '',
  };

  constructor(opts: DemuxerOptions) {
    this.opts = opts;
    this.url = opts.url;
    this.kind = opts.kind;
  }

  async start(startSec = 0): Promise<void> {
    this.gen++;
    const g = this.gen;
    this.aborted = false;
    this.eofSignaled = false;

    try {
      const m3u8Content = await this.fetchM3U8(this.url);
      if (this.aborted || g !== this.gen) return;

      this.segments = this.parseSegments(m3u8Content, this.url);
      this.durationSec = this.segments.reduce((sum, s) => sum + s.duration, 0);
      this.stats.m3u8Loaded = true;
      this.stats.segmentCount = this.segments.length;

      if (this.segments.length === 0) {
        this.stats.error = 'No segments found in m3u8';
        this.opts.onError(new Error('No segments found in m3u8'));
        return;
      }

      this.currentSegmentIndex = this.findSegmentIndex(startSec);
      this.initTransmuxer();
      this.initMP4Box();

      void this.downloadLoop(g);
    } catch (e) {
      if (!this.aborted && g === this.gen) {
        this.opts.onError(e);
      }
    }
  }

  private initTransmuxer() {
    this.transmuxer = new muxjs.mp4.Transmuxer({
      keepOriginalTimestamps: true,
      remux: true,
    });

    this.transmuxer.on('data', (segment: any) => {
      if (this.aborted) return;

      if (segment.initSegment && !this.initSegmentAppended) {
        this.initSegmentAppended = true;
        this.stats.transmuxBytesIn += segment.initSegment.byteLength || 0;
        this.appendToMP4Box(segment.initSegment);
      }

      if (segment.data) {
        this.stats.transmuxBytesIn += segment.data.byteLength || 0;
        this.appendToMP4Box(segment.data);
      }
    });

    this.transmuxer.on('done', () => {
      // segment transmux done
    });
  }

  private initMP4Box() {
    this.mp4 = createFile();
    this.mp4ByteOffset = 0;
    this.mp4.onError = (e: any) => this.opts.onError(e);
    this.mp4.onReady = (info: MP4Info) => this.onReady(info);
    this.mp4.onSamples = (_id: number, _user: any, samples: MP4Sample[]) =>
      this.onSamples(samples);
  }

  private appendToMP4Box(data: Uint8Array | ArrayBuffer) {
    if (!this.mp4) return;
    const u8 = data instanceof Uint8Array ? data : new Uint8Array(data);
    const ab = u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as MP4ArrayBuffer;
    ab.fileStart = this.mp4ByteOffset;
    this.mp4ByteOffset += ab.byteLength;
    this.mp4.appendBuffer(ab);
  }

  private onReady(info: MP4Info) {
    this.stats.mp4Ready = true;
    const track = this.kind === 'video' ? info.videoTracks[0] : info.audioTracks[0];
    if (!track) {
      this.stats.error = `no ${this.kind} track in stream`;
      this.opts.onError(new Error(`no ${this.kind} track in stream`));
      return;
    }
    this.trackId = track.id;

    if (this.kind === 'video') {
      const v = info.videoTracks[0];
      this.opts.onConfig({
        kind: 'video',
        codec: v.codec,
        codedWidth: v.video.width,
        codedHeight: v.video.height,
        description: this.videoDescription(v.id),
      });
    } else {
      const a = info.audioTracks[0];
      this.opts.onConfig({
        kind: 'audio',
        codec: a.codec,
        sampleRate: a.audio.sample_rate,
        numberOfChannels: a.audio.channel_count,
        description: this.audioDescription(a.id),
      });
    }

    this.mp4?.setExtractionOptions(this.trackId, null, { nbSamples: 100 });
    this.mp4?.start();
  }

  private onSamples(samples: MP4Sample[]) {
    this.stats.samplesOutput += samples.length;
    for (const s of samples) {
      this.opts.onSample({
        key: s.is_sync,
        timestamp: (s.cts / s.timescale) * 1e6,
        duration: (s.duration / s.timescale) * 1e6,
        data: s.data,
      });
    }
    const last = samples[samples.length - 1];
    if (last && this.mp4) {
      this.mp4.releaseUsedSamples(this.trackId, last.number);
    }
  }

  private videoDescription(trackId: number): Uint8Array | undefined {
    if (!this.mp4) return undefined;
    const trak = this.mp4.getTrackById(trackId);
    for (const entry of trak?.mdia?.minf?.stbl?.stsd?.entries ?? []) {
      const box = (entry as any).avcC || (entry as any).hvcC || (entry as any).av1C || (entry as any).vpcC;
      if (box) {
        const ds = new DataStream(undefined, 0, DataStream.BIG_ENDIAN);
        box.write(ds);
        return new Uint8Array(ds.buffer, 8);
      }
    }
    return undefined;
  }

  private audioDescription(trackId: number): Uint8Array | undefined {
    if (!this.mp4) return undefined;
    const trak = this.mp4.getTrackById(trackId);
    for (const entry of trak?.mdia?.minf?.stbl?.stsd?.entries ?? []) {
      const esds = (entry as any).esds;
      if (!esds) continue;
      const findData = (node: unknown): Uint8Array | undefined => {
        const n = node as { data?: Uint8Array; descs?: unknown[] };
        if (n?.data) return n.data;
        for (const child of n?.descs ?? []) {
          const found = findData(child);
          if (found) return found;
        }
        return undefined;
      };
      const asc = findData(esds.esd);
      if (asc) return asc;
    }
    return undefined;
  }

  private async downloadLoop(g: number) {
    while (!this.aborted && g === this.gen && this.currentSegmentIndex < this.segments.length) {
      await this.waitWhilePaused();
      if (this.aborted || g !== this.gen) break;

      const seg = this.segments[this.currentSegmentIndex];
      if (!seg) break;
      this.stats.currentSegment = this.currentSegmentIndex;

      let data: ArrayBuffer | null = null;
      try {
        data = await this.fetchSegment(seg.url);
      } catch (err) {
        if (this.aborted || g !== this.gen) break;
        this.stats.error = String(err);
        this.opts.onError(err);
        return;
      }
      if (this.aborted || g !== this.gen) break;

      if (data) {
        this.stats.segmentsDownloaded++;
        this.stats.bytesDownloaded += data.byteLength;
        try {
          this.transmuxer.push(new Uint8Array(data));
          this.transmuxer.flush();
          // 每个分片转封装完成后，flush mp4box 强制解析
          if (this.mp4 && this.initSegmentAppended) {
            try {
              this.mp4.flush();
            } catch (e) {
              console.warn('[HLSTSDemuxer] mp4 flush error:', e);
            }
          }
        } catch (e) {
          console.warn('[HLSTSDemuxer] transmux error:', e);
        }
      }

      this.currentSegmentIndex++;
    }

    if (!this.aborted && g === this.gen && !this.eofSignaled) {
      this.eofSignaled = true;
      this.opts.onDone();
    }
  }

  private async fetchM3U8(url: string): Promise<string> {
    const ctrl = new AbortController();
    const timer = window.setTimeout(() => ctrl.abort(new Error('m3u8 timeout')), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(url, { signal: ctrl.signal });
      if (!res.ok) throw new Error(`m3u8 fetch ${res.status}`);
      return await res.text();
    } finally {
      clearTimeout(timer);
    }
  }

  private async fetchSegment(url: string): Promise<ArrayBuffer> {
    let lastErr: unknown = null;
    for (let i = 0; i < MAX_RETRIES; i++) {
      const ctrl = new AbortController();
      const timer = window.setTimeout(() => ctrl.abort(new Error('segment timeout')), FETCH_TIMEOUT_MS);
      try {
        const res = await fetch(url, { signal: ctrl.signal });
        if (!res.ok) throw new Error(`segment fetch ${res.status}`);
        return await res.arrayBuffer();
      } catch (e) {
        lastErr = e;
        if (i < MAX_RETRIES - 1) {
          await new Promise((r) => setTimeout(r, RETRY_DELAY_MS * (i + 1)));
        }
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastErr || new Error('segment fetch failed');
  }

  private parseSegments(m3u8Content: string, baseUrl: string): Segment[] {
    const lines = m3u8Content.split('\n');
    const segs: Segment[] = [];
    let currentTime = 0;
    let currentDuration = 0;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (line.startsWith('#EXTINF:')) {
        const match = line.match(/#EXTINF:([\d.]+)/);
        currentDuration = match ? parseFloat(match[1]) : 0;
      } else if (line && !line.startsWith('#')) {
        const url = this.resolveUrl(line, baseUrl);
        segs.push({
          url,
          duration: currentDuration,
          startTime: currentTime,
        });
        currentTime += currentDuration;
        currentDuration = 0;
      }
    }

    return segs;
  }

  private resolveUrl(target: string, base: string): string {
    if (target.startsWith('http://') || target.startsWith('https://')) return target;
    try {
      return new URL(target, base).href;
    } catch {
      return target;
    }
  }

  private findSegmentIndex(seconds: number): number {
    for (let i = 0; i < this.segments.length; i++) {
      const seg = this.segments[i];
      if (seg.startTime + seg.duration > seconds) {
        return Math.max(0, i);
      }
    }
    return Math.max(0, this.segments.length - 1);
  }

  private waitWhilePaused(): Promise<void> | void {
    if (!this.paused) return;
    return new Promise<void>((resolve) => {
      this.resumeResolve = resolve;
    });
  }

  pause(): void {
    this.paused = true;
  }

  pauseAndIdle(): Promise<void> {
    this.paused = true;
    return Promise.resolve();
  }

  seekTo(seconds: number): void {
    this.currentSegmentIndex = this.findSegmentIndex(seconds);
    this.eofSignaled = false;

    this.initSegmentAppended = false;
    if (this.mp4) {
      try {
        this.mp4.stop();
      } catch {
        // ignore
      }
      this.mp4 = null;
    }
    this.initMP4Box();
    if (this.transmuxer) {
      try {
        this.transmuxer.reset?.();
      } catch {
        // ignore
      }
    }
  }

  resume(): void {
    this.paused = false;
    if (this.resumeResolve) {
      this.resumeResolve();
      this.resumeResolve = null;
    }
  }

  destroy(): void {
    this.aborted = true;
    this.gen++;
    this.resume();
    if (this.transmuxer) {
      try {
        this.transmuxer.reset?.();
      } catch {
        // ignore
      }
      this.transmuxer = null;
    }
    if (this.mp4) {
      try {
        this.mp4.stop();
      } catch {
        // ignore
      }
      this.mp4 = null;
    }
  }

  getDuration(): number {
    return this.durationSec;
  }

  getStats() {
    return { ...this.stats };
  }

  getSegments(): Segment[] {
    return this.segments;
  }
}
