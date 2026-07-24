// @ts-nocheck
import * as muxjs from 'mux.js';

export interface VideoConfig {
  kind: 'video';
  codec: string;
  codedWidth: number;
  codedHeight: number;
  description: Uint8Array;
}

export interface AudioConfig {
  kind: 'audio';
  codec: string;
  sampleRate: number;
  numberOfChannels: number;
  description: Uint8Array;
}

export interface EncodedSample {
  key: boolean;
  timestamp: number;
  duration: number;
  data: Uint8Array;
}

interface DemuxerOptions {
  url: string;
  onVideoConfig: (config: VideoConfig) => void;
  onAudioConfig: (config: AudioConfig) => void;
  onVideoSample: (sample: EncodedSample) => void;
  onAudioSample: (sample: EncodedSample) => void;
  onDuration: (durationSec: number) => void;
  onError: (e: unknown) => void;
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
  private opts: DemuxerOptions;

  private segments: Segment[] = [];
  private durationSec = 0;
  private currentSegmentIndex = 0;
  private paused = false;
  private aborted = false;
  private gen = 0;
  private resumeResolve: (() => void) | null = null;

  private packetStream: any = null;
  private parseStream: any = null;
  private elementaryStream: any = null;

  private spsNalu: Uint8Array | null = null;
  private ppsNalu: Uint8Array | null = null;
  private videoConfigSent = false;
  private audioConfigSent = false;
  private lastVideoPts = 0;
  private lastAudioPts = 0;
  private videoFrameDuration = 0;
  private audioFrameDuration = 0;

  private videoCodec = '';
  private videoWidth = 0;
  private videoHeight = 0;
  private audioSampleRate = 0;
  private audioChannels = 0;

  private stats = {
    m3u8Loaded: false,
    isMasterPlaylist: false,
    masterRedirects: 0,
    m3u8Preview: '',
    segmentCount: 0,
    currentSegment: 0,
    segmentsDownloaded: 0,
    bytesDownloaded: 0,
    videoSamples: 0,
    audioSamples: 0,
    videoPesCount: 0,
    audioPesCount: 0,
    pmtFound: false,
    error: '',
    lastError: '',
  };

  constructor(opts: DemuxerOptions) {
    this.opts = opts;
    this.url = opts.url;
  }

  async start(startSec = 0): Promise<void> {
    this.gen++;
    const g = this.gen;
    this.aborted = false;

    try {
      let m3u8Content = await this.fetchM3U8(this.url);
      if (this.aborted || g !== this.gen) return;
      this.stats.m3u8Preview = m3u8Content.slice(0, 200).replace(/\n/g, ' | ');

      let currentUrl = this.url;
      if (this.isMasterPlaylist(m3u8Content)) {
        this.stats.isMasterPlaylist = true;
        const firstMedia = this.parseFirstMediaPlaylist(m3u8Content, currentUrl);
        if (!firstMedia) {
          this.stats.error = 'Master playlist: no media playlist found';
          this.opts.onError(new Error('No media playlist in master m3u8'));
          return;
        }
        this.stats.masterRedirects = 1;
        currentUrl = firstMedia;
        m3u8Content = await this.fetchM3U8(currentUrl);
        if (this.aborted || g !== this.gen) return;
      }

      this.segments = this.parseSegments(m3u8Content, currentUrl);
      this.durationSec = this.segments.reduce((sum, s) => sum + s.duration, 0);
      this.stats.m3u8Loaded = true;
      this.stats.segmentCount = this.segments.length;

      if (this.segments.length === 0) {
        this.stats.error = 'No segments found in m3u8';
        this.opts.onError(new Error('No segments found in m3u8'));
        return;
      }

      this.opts.onDuration(this.durationSec);
      this.currentSegmentIndex = this.findSegmentIndex(startSec);
      this.initStreams();

      void this.downloadLoop(g);
    } catch (e) {
      if (!this.aborted && g === this.gen) {
        this.stats.error = String(e);
        this.stats.lastError = String(e);
        this.opts.onError(e);
      }
    }
  }

  private isMasterPlaylist(content: string): boolean {
    return /#EXT-X-STREAM-INF/i.test(content);
  }

  private parseFirstMediaPlaylist(content: string, baseUrl: string): string | null {
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (line.startsWith('#EXT-X-STREAM-INF:')) {
        for (let j = i + 1; j < lines.length; j++) {
          const next = lines[j].trim();
          if (next && !next.startsWith('#')) {
            return this.resolveUrl(next, baseUrl);
          }
        }
      }
    }
    return null;
  }

  private initStreams() {
    const mp2t = muxjs.mp2t;

    this.packetStream = new mp2t.TransportPacketStream();
    this.parseStream = new mp2t.TransportParseStream();
    this.elementaryStream = new mp2t.ElementaryStream();

    this.packetStream.pipe(this.parseStream);
    this.parseStream.pipe(this.elementaryStream);

    this.parseStream.on('data', (data: any) => {
      if (data.type === 'pmt') {
        this.stats.pmtFound = true;
      }
    });

    this.elementaryStream.on('data', (data: any) => {
      if (this.aborted) return;

      if (data.type === 'video') {
        this.stats.videoPesCount++;
        this.handleVideoData(data);
      } else if (data.type === 'audio') {
        this.stats.audioPesCount++;
        this.handleAudioData(data);
      } else if (data.type === 'metadata') {
        // PMT metadata, ignore
      }
    });

    this.elementaryStream.on('error', (err: any) => {
      console.warn('[HLSTSDemuxer] elementary stream error:', err);
      this.stats.lastError = String(err);
    });
  }

  private handleVideoData(videoData: any) {
    const pesData = videoData.data;
    const pts = videoData.pts != null ? videoData.pts / 90000 : (this.lastVideoPts + this.videoFrameDuration);

    if (!pesData || !(pesData instanceof Uint8Array) || pesData.length === 0) return;

    const nalus = this.splitNalus(pesData);
    if (nalus.length === 0) return;

    let hasKeyFrame = false;
    const frameNalus: Uint8Array[] = [];

    for (const naluData of nalus) {
      const naluType = this.getNaluType(naluData);
      if (naluType === 7) {
        this.spsNalu = naluData;
        this.parseSPS(naluData);
      } else if (naluType === 8) {
        this.ppsNalu = naluData;
      } else if (naluType === 5) {
        hasKeyFrame = true;
        frameNalus.push(naluData);
      } else if (naluType === 1 || naluType === 2 || naluType === 3 || naluType === 4) {
        frameNalus.push(naluData);
      }
    }

    if (frameNalus.length === 0) {
      if (this.spsNalu && this.ppsNalu && !this.videoConfigSent) {
        const description = this.buildAvccDescription(this.spsNalu, this.ppsNalu);
        this.opts.onVideoConfig({
          kind: 'video',
          codec: this.videoCodec || 'avc1.4d401f',
          codedWidth: this.videoWidth || 1920,
          codedHeight: this.videoHeight || 1080,
          description,
        });
        this.videoConfigSent = true;
      }
      return;
    }

    if (!this.videoConfigSent && this.spsNalu && this.ppsNalu) {
      const description = this.buildAvccDescription(this.spsNalu, this.ppsNalu);
      this.opts.onVideoConfig({
        kind: 'video',
        codec: this.videoCodec || 'avc1.4d401f',
        codedWidth: this.videoWidth || 1920,
        codedHeight: this.videoHeight || 1080,
        description,
      });
      this.videoConfigSent = true;
    }

    const frameData = this.concatNalusWithStartCodes(frameNalus);
    const duration = this.videoFrameDuration || 0.033;

    this.opts.onVideoSample({
      key: hasKeyFrame,
      timestamp: Math.round(pts * 1e6),
      duration: Math.round(duration * 1e6),
      data: frameData,
    });

    this.stats.videoSamples++;
    this.lastVideoPts = pts;
  }

  private splitNalus(data: Uint8Array): Uint8Array[] {
    const nalus: Uint8Array[] = [];
    let i = 0;
    const len = data.length;

    while (i < len - 4) {
      if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 0 && data[i + 3] === 1) {
        const start = i;
        i += 4;
        while (i < len - 4) {
          if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 0 && data[i + 3] === 1) {
            break;
          }
          i++;
        }
        nalus.push(data.subarray(start, i));
      } else if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 1) {
        const start = i;
        i += 3;
        while (i < len - 3) {
          if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 1) {
            break;
          }
          i++;
        }
        nalus.push(data.subarray(start, i));
      } else {
        i++;
      }
    }

    return nalus;
  }

  private handleAudioData(audioData: any) {
    const frame = audioData.data || audioData.frame || audioData;
    if (!frame) return;

    const pts = audioData.pts != null ? audioData.pts / 90000 : (this.lastAudioPts + this.audioFrameDuration);
    const duration = audioData.duration ? audioData.duration / 90000 : (this.audioFrameDuration || 0.023);

    let aacData: Uint8Array;
    if (frame instanceof Uint8Array) {
      aacData = frame;
    } else if (frame.data instanceof Uint8Array) {
      aacData = frame.data;
    } else {
      return;
    }

    if (!this.audioConfigSent && aacData.length > 7) {
      const config = this.parseAdtsHeader(aacData);
      if (config) {
        const description = this.buildAacDescription(config.sampleRate, config.channels, config.profile);
        this.opts.onAudioConfig({
          kind: 'audio',
          codec: 'mp4a.40.2',
          sampleRate: config.sampleRate,
          numberOfChannels: config.channels,
          description,
        });
        this.audioConfigSent = true;
        this.audioSampleRate = config.sampleRate;
        this.audioChannels = config.channels;
      }
    }

    let rawAac: Uint8Array;
    if (this.isAdts(aacData)) {
      const headerLen = 7;
      rawAac = aacData.subarray(headerLen);
    } else {
      rawAac = aacData;
    }

    this.opts.onAudioSample({
      key: true,
      timestamp: Math.round(pts * 1e6),
      duration: Math.round(duration * 1e6),
      data: rawAac,
    });

    this.stats.audioSamples++;
    this.lastAudioPts = pts;
    if (audioData.duration) this.audioFrameDuration = audioData.duration / 90000;
  }

  private getNaluType(nalu: Uint8Array): number {
    let startCodeLen = 0;
    if (nalu[0] === 0 && nalu[1] === 0 && nalu[2] === 0 && nalu[3] === 1) {
      startCodeLen = 4;
    } else if (nalu[0] === 0 && nalu[1] === 0 && nalu[2] === 1) {
      startCodeLen = 3;
    }
    if (nalu.length <= startCodeLen) return 0;
    return nalu[startCodeLen] & 0x1f;
  }

  private parseSPS(sps: Uint8Array) {
    try {
      let startOffset = 0;
      if (sps[0] === 0 && sps[1] === 0 && sps[2] === 0 && sps[3] === 1) startOffset = 4;
      else if (sps[0] === 0 && sps[1] === 0 && sps[2] === 1) startOffset = 3;

      const profileIdc = sps[startOffset + 1];
      const constraintSet = sps[startOffset + 2];
      const levelIdc = sps[startOffset + 3];
      this.videoCodec = `avc1.${this.toHex(profileIdc)}${this.toHex(constraintSet)}${this.toHex(levelIdc)}`;
    } catch {
      // ignore
    }
  }

  private toHex(b: number): string {
    return b.toString(16).padStart(2, '0').toUpperCase();
  }

  private isAdts(data: Uint8Array): boolean {
    return data.length >= 2 && data[0] === 0xff && (data[1] & 0xf0) === 0xf0;
  }

  private parseAdtsHeader(data: Uint8Array): { sampleRate: number; channels: number; profile: number } | null {
    if (!this.isAdts(data)) return null;
    const sampleRates = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];
    const profile = ((data[2] & 0xc0) >> 6) + 1;
    const sampleRateIdx = (data[2] & 0x3c) >> 2;
    const channels = ((data[2] & 0x01) << 2) | ((data[3] & 0xc0) >> 6);
    const sampleRate = sampleRates[sampleRateIdx] || 44100;
    return { sampleRate, channels, profile };
  }

  private buildAvccDescription(sps: Uint8Array, pps: Uint8Array): Uint8Array {
    const spsRaw = this.stripStartCode(sps);
    const ppsRaw = this.stripStartCode(pps);

    let spsOffset = 0;
    if (sps[0] === 0 && sps[1] === 0 && sps[2] === 0 && sps[3] === 1) spsOffset = 4;
    else if (sps[0] === 0 && sps[1] === 0 && sps[2] === 1) spsOffset = 3;

    const profileIdc = sps[spsOffset + 1];
    const profileCompat = sps[spsOffset + 2];
    const levelIdc = sps[spsOffset + 3];

    const config = new Uint8Array(11 + spsRaw.length + ppsRaw.length);
    let i = 0;
    config[i++] = 1;
    config[i++] = profileIdc;
    config[i++] = profileCompat;
    config[i++] = levelIdc;
    config[i++] = 0xff;
    config[i++] = 0xe1;
    config[i++] = (spsRaw.length >> 8) & 0xff;
    config[i++] = spsRaw.length & 0xff;
    config.set(spsRaw, i);
    i += spsRaw.length;
    config[i++] = 1;
    config[i++] = (ppsRaw.length >> 8) & 0xff;
    config[i++] = ppsRaw.length & 0xff;
    config.set(ppsRaw, i);

    return config;
  }

  private buildAacDescription(sampleRate: number, channels: number, profile: number): Uint8Array {
    const sampleRates = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];
    let sampleRateIdx = sampleRates.indexOf(sampleRate);
    if (sampleRateIdx < 0) sampleRateIdx = 4;

    const audioObjectType = profile || 2;

    const asc = new Uint8Array(2);
    asc[0] = (audioObjectType << 3) | (sampleRateIdx >> 1);
    asc[1] = ((sampleRateIdx & 0x01) << 7) | (channels << 3);

    return asc;
  }

  private stripStartCode(nalu: Uint8Array): Uint8Array {
    if (nalu[0] === 0 && nalu[1] === 0 && nalu[2] === 0 && nalu[3] === 1) {
      return nalu.subarray(4);
    } else if (nalu[0] === 0 && nalu[1] === 0 && nalu[2] === 1) {
      return nalu.subarray(3);
    }
    return nalu;
  }

  private concatNalusWithStartCodes(nalus: Uint8Array[]): Uint8Array {
    let totalLen = 0;
    for (const n of nalus) totalLen += n.length;
    const result = new Uint8Array(totalLen);
    let offset = 0;
    for (const n of nalus) {
      result.set(n, offset);
      offset += n.length;
    }
    return result;
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
          this.packetStream.push(new Uint8Array(data));
          this.packetStream.flush();
        } catch (e) {
          console.warn('[HLSTSDemuxer] TS parse error:', e);
        }
      }

      this.currentSegmentIndex++;
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

  resume(): void {
    this.paused = false;
    if (this.resumeResolve) {
      this.resumeResolve();
      this.resumeResolve = null;
    }
  }

  seekTo(seconds: number): void {
    // Invalidate any in-flight segment request from the previous position.
    // The old loop will exit after its fetch resolves and cannot feed stale
    // samples into the newly-created parser.
    this.gen++;
    const g = this.gen;
    this.currentSegmentIndex = this.findSegmentIndex(seconds);
    this.spsNalu = null;
    this.ppsNalu = null;
    this.videoConfigSent = false;
    this.audioConfigSent = false;
    this.lastVideoPts = 0;
    this.lastAudioPts = 0;
    this.initStreams();
    void this.downloadLoop(g);
  }

  destroy(): void {
    this.aborted = true;
    this.gen++;
    this.resume();
    this.packetStream = null;
    this.parseStream = null;
    this.elementaryStream = null;
  }

  getDuration(): number {
    return this.durationSec;
  }

  getStats() {
    return { ...this.stats, duration: this.durationSec };
  }

  getSegments(): Segment[] {
    return this.segments;
  }
}
