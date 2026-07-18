'use client';

/* eslint-disable @typescript-eslint/no-explicit-any */

import Hls from 'hls.js';
import { Loader2, Maximize, Minimize, Pause, Play, RotateCcw, SkipForward, SkipBack, MonitorPlay } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { setTeslaOptOut } from '@/components/TeslaAutoRedirect';

interface TeslaPlayerProps {
  url: string;
  title?: string;
  poster?: string;
  live?: boolean;
  onBackToOriginal?: () => void;
  onEnded?: () => void;
  playRecordKey?: string;
}

const PLAYBACK_RATES = [0.5, 0.75, 1, 1.25, 1.5, 2, 3];

function filterAdsFromM3U8(m3u8Content: string): string {
  if (!m3u8Content) return '';
  const adKeywords = ['sponsor', '/ad/', '/ads/', 'advert', 'advertisement', '/adjump', 'redtraffic'];
  const lines = m3u8Content.split('\n');
  const filteredLines: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (line.includes('#EXT-X-DISCONTINUITY')) {
      i++;
      continue;
    }

    if (line.includes('#EXTINF:') && i + 1 < lines.length) {
      const nextLine = lines[i + 1];
      const isAd = adKeywords.some((keyword) => nextLine.toLowerCase().includes(keyword));
      if (isAd) {
        i += 2;
        continue;
      }
    }

    filteredLines.push(line);
    i++;
  }

  return filteredLines.join('\n');
}

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const hh = h > 0 ? `${h}:` : '';
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m);
  const ss = String(s).padStart(2, '0');
  return `${hh}${mm}:${ss}`;
}

const PROGRESS_SAVE_INTERVAL = 3000;

function getSavedProgress(key: string): number {
  if (typeof window === 'undefined') return 0;
  try {
    const saved = localStorage.getItem(`tesla_progress_${key}`);
    return saved ? parseFloat(saved) : 0;
  } catch {
    return 0;
  }
}

function saveProgress(key: string, time: number): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(`tesla_progress_${key}`, String(time));
  } catch {
    // ignore
  }
}

export default function TeslaPlayer({ url, title, poster, live = false, onBackToOriginal, onEnded: onEndedCallback, playRecordKey }: TeslaPlayerProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const hlsRef = useRef<Hls | null>(null);
  const hideControlsTimerRef = useRef<number | null>(null);
  const progressSaveTimerRef = useRef<number | null>(null);
  const rafRef = useRef<number | null>(null);

  const audioContextRef = useRef<AudioContext | null>(null);
  const audioSourceRef = useRef<MediaElementAudioSourceNode | null>(null);
  const gainNodeRef = useRef<GainNode | null>(null);

  const [loading, setLoading] = useState(true);
  const [buffering, setBuffering] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [rate, setRate] = useState(1);
  const [showRateMenu, setShowRateMenu] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [showControls, setShowControls] = useState(true);
  const [quality, setQuality] = useState<string>('auto');
  const [showQualityMenu, setShowQualityMenu] = useState(false);
  const [qualities, setQualities] = useState<Array<{ label: string; value: string }>>([]);
  const [seekToTime, setSeekToTime] = useState<number | null>(null);

  const savedProgress = useMemo(() => {
    if (!playRecordKey) return 0;
    return getSavedProgress(playRecordKey);
  }, [playRecordKey]);

  useEffect(() => {
    if (savedProgress > 0 && duration > 0 && seekToTime === null) {
      const progressRatio = savedProgress / duration;
      if (progressRatio > 0.05 && progressRatio < 0.95) {
        setSeekToTime(savedProgress);
      }
    }
  }, [savedProgress, duration, seekToTime]);

  useEffect(() => {
    if (seekToTime !== null && videoRef.current) {
      videoRef.current.currentTime = seekToTime;
      setSeekToTime(null);
    }
  }, [seekToTime]);

  const seek = useCallback((t: number) => {
    const v = videoRef.current;
    if (v) v.currentTime = t;
    setCurrentTime(t);
  }, []);

  const togglePlay = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) v.play();
    else v.pause();
  }, []);

  const toggleFullscreen = useCallback(() => {
    if (!containerRef.current) return;
    if (!document.fullscreenElement) {
      containerRef.current.requestFullscreen().catch(() => { });
    } else {
      document.exitFullscreen().catch(() => { });
    }
  }, []);

  useEffect(() => {
    const onFullscreenChange = () => {
      setIsFullscreen(!!document.fullscreenElement);
    };
    document.addEventListener('fullscreenchange', onFullscreenChange);
    return () => { document.removeEventListener('fullscreenchange', onFullscreenChange); };
  }, []);

  const setPlaybackRate = useCallback((r: number) => {
    const v = videoRef.current;
    if (v) v.playbackRate = r;
    setRate(r);
    setShowRateMenu(false);
  }, []);

  const switchQuality = useCallback((q: string) => {
    if (!hlsRef.current) return;
    const hls = hlsRef.current;
    if (q === 'auto') hls.currentLevel = -1;
    else hls.currentLevel = parseInt(q, 10);
    setQuality(q);
    setShowQualityMenu(false);
  }, []);

  const backToOriginal = useCallback(() => {
    setTeslaOptOut();
    onBackToOriginal?.();
  }, [onBackToOriginal]);

  const resetControlsTimer = useCallback(() => {
    if (hideControlsTimerRef.current) clearTimeout(hideControlsTimerRef.current);
    setShowControls(true);
    hideControlsTimerRef.current = window.setTimeout(() => {
      if (playing && !showRateMenu && !showQualityMenu) setShowControls(false);
    }, 3000);
  }, [playing, showRateMenu, showQualityMenu]);

  useEffect(() => {
    if (playRecordKey) {
      progressSaveTimerRef.current = window.setInterval(() => {
        if (playing) saveProgress(playRecordKey, currentTime);
      }, PROGRESS_SAVE_INTERVAL);
    }
    return () => {
      if (progressSaveTimerRef.current) clearInterval(progressSaveTimerRef.current);
    };
  }, [playRecordKey, playing, currentTime]);

  // ===== Canvas 帧绘制循环（核心：绕过特斯拉 video 画面限制）=====
  const drawVideoFrameToCanvas = useCallback(() => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas) {
      rafRef.current = window.requestAnimationFrame(drawVideoFrameToCanvas);
      return;
    }

    const ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });
    if (!ctx) {
      rafRef.current = window.requestAnimationFrame(drawVideoFrameToCanvas);
      return;
    }

    // 确保 canvas 尺寸匹配 video
    if (video.readyState >= 2 && (canvas.width !== video.videoWidth || canvas.height !== video.videoHeight)) {
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
    }

    // 绘制视频帧到 canvas
    if (video.readyState >= 2) {
      try {
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      } catch (e) {
        // drawImage 可能因为 CORS 或其他原因失败，忽略
      }
    }

    rafRef.current = window.requestAnimationFrame(drawVideoFrameToCanvas);
  }, []);

  // ===== Web Audio API 音频初始化 =====
  const initializeAudio = useCallback(() => {
    const video = videoRef.current;
    if (!video || audioContextRef.current) return;

    try {
      audioContextRef.current = new AudioContext();
      audioSourceRef.current = audioContextRef.current.createMediaElementSource(video);
      gainNodeRef.current = audioContextRef.current.createGain();
      gainNodeRef.current.gain.value = 1;
      audioSourceRef.current.connect(gainNodeRef.current);
      gainNodeRef.current.connect(audioContextRef.current.destination);
      console.log('[TeslaPlayer] Web Audio API initialized');
    } catch (e) {
      console.error('[TeslaPlayer] Audio initialization failed:', e);
    }
  }, []);

  // ===== 视频初始化 =====
  useEffect(() => {
    let destroyed = false;
    const video = videoRef.current;
    if (!video) return;

    const onLoadedMetadata = () => { if (!destroyed) { setLoading(false); setDuration(video.duration || 0); } };
    const onTimeUpdate = () => { if (!destroyed) setCurrentTime(video.currentTime); };
    const onPlay = () => { if (!destroyed) { setPlaying(true); setLoading(false); } };
    const onPause = () => { if (!destroyed) setPlaying(false); };
    const onWaiting = () => { if (!destroyed) setBuffering(true); };
    const onPlaying = () => {
      if (destroyed) return;
      setBuffering(false);
      setLoading(false);
      // 首次播放时初始化音频
      if (!audioContextRef.current) {
        initializeAudio();
      }
      // 恢复音频上下文（需要用户交互后才能恢复）
      if (audioContextRef.current?.state === 'suspended') {
        audioContextRef.current.resume().catch(() => { });
      }
    };
    const onEnded = () => {
      if (destroyed) return;
      setPlaying(false);
      if (playRecordKey) saveProgress(playRecordKey, video.duration || 0);
      setTimeout(() => onEndedCallback?.(), 500);
    };
    const onError = () => {
      if (destroyed) return;
      const code = video.error?.code;
      setError(`视频错误 (code ${code ?? 'unknown'})`);
      setLoading(false);
    };

    video.addEventListener('loadedmetadata', onLoadedMetadata);
    video.addEventListener('timeupdate', onTimeUpdate);
    video.addEventListener('play', onPlay);
    video.addEventListener('pause', onPause);
    video.addEventListener('waiting', onWaiting);
    video.addEventListener('playing', onPlaying);
    video.addEventListener('ended', onEnded);
    video.addEventListener('error', onError);

    // 判断是否为 m3u8
    const isM3u8 = url.toLowerCase().includes('.m3u') || url.toLowerCase().includes('/m3u8');

    // 5秒超时兜底
    const loadTimeout = window.setTimeout(() => {
      if (!destroyed) {
        console.warn('[TeslaPlayer] manifest load timeout, forcing loading=false');
        setLoading(false);
      }
    }, 5000);

    if (isM3u8 && Hls.isSupported()) {
      const AdFilterLoader = class extends Hls.DefaultConfig.loader {
        constructor(config: any) {
          super(config);
          const load = this.load.bind(this);
          this.load = (context: any, cfg: any, callbacks: any) => {
            if (context?.type === 'manifest' || context?.type === 'level') {
              const onSuccess = callbacks.onSuccess;
              callbacks.onSuccess = (response: any, stats: any, ctx: any, networkDetails: any) => {
                if (typeof response?.data === 'string') {
                  const filtered = filterAdsFromM3U8(response.data);
                  console.log('[TeslaPlayer] 广告过滤: 原始长度', response.data.length, '过滤后', filtered.length);
                  response.data = filtered;
                }
                return onSuccess(response, stats, ctx, networkDetails);
              };
            }
            load(context, cfg, callbacks);
          };
        }
      };

      const hls = new Hls({
        enableWorker: true,
        lowLatencyMode: live,
        backBufferLength: live ? 10 : 30,
        loader: AdFilterLoader,
      });

      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        if (destroyed) return;
        const levels = hls.levels || [];
        const qs: Array<{ label: string; value: string }> = [{ label: '自动', value: 'auto' }];
        levels.forEach((l, i) => {
          const bw = l.bitrate ? `${Math.round(l.bitrate / 1000)}kbps` : '';
          const res = l.width && l.height ? `${l.width}x${l.height}` : '';
          qs.push({ label: `${res} ${bw}`.trim() || `清晰度 ${i + 1}`, value: String(i) });
        });
        setQualities(qs);
        console.log('[TeslaPlayer] manifest parsed, levels:', levels.length);
        // 清掉 loading 状态（元数据已加载）
        setLoading(false);
      });

      hls.on(Hls.Events.LEVEL_LOADED, (_evt, data: any) => {
        if (destroyed) return;
        console.log('[TeslaPlayer] level loaded, duration:', data?.details?.duration);
        if (data?.details?.duration) {
          setDuration(data.details.duration);
        }
      });

      hls.on(Hls.Events.ERROR, (_evt, data) => {
        if (destroyed) return;
        console.error('[TeslaPlayer] HLS ERROR:', data.type, data.details);
        if (data.fatal) {
          if (data.type === Hls.ErrorTypes.NETWORK_ERROR) hls.startLoad();
          else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) hls.recoverMediaError();
          else setError(`播放错误: ${data.details}`);
        }
      });

      hls.loadSource(url);
    hls.attachMedia(video);
    hlsRef.current = hls;

    if (!live) video.play().catch(() => { });
    } else {
      video.src = url;
      video.load();
      if (!live) video.play().catch(() => { });
    }

    // 启动 Canvas 帧绘制循环（始终运行）
    rafRef.current = window.requestAnimationFrame(drawVideoFrameToCanvas);

    return () => {
      destroyed = true;
      video.removeEventListener('loadedmetadata', onLoadedMetadata);
      video.removeEventListener('timeupdate', onTimeUpdate);
      video.removeEventListener('play', onPlay);
      video.removeEventListener('pause', onPause);
      video.removeEventListener('waiting', onWaiting);
      video.removeEventListener('playing', onPlaying);
      video.removeEventListener('ended', onEnded);
      video.removeEventListener('error', onError);
      if (rafRef.current) {
        window.cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      if (hlsRef.current) { hlsRef.current.destroy(); hlsRef.current = null; }
      if (audioContextRef.current) { audioContextRef.current.close(); audioContextRef.current = null; }
      clearTimeout(loadTimeout);
      video.removeAttribute('src');
      video.load();
    };
  }, [url, live, playRecordKey, onEndedCallback, initializeAudio, drawVideoFrameToCanvas]);

  return (
    <div
      ref={containerRef}
      className="relative w-full h-full bg-black"
      onMouseMove={resetControlsTimer}
      onClick={togglePlay}
    >
      {/* 隐藏的 video 元素（负责解码，特斯拉允许 - 视觉隐藏但仍在渲染树中） */}
      <video
        ref={videoRef}
        className="absolute inset-0 h-full w-full opacity-0 pointer-events-none"
        playsInline
        poster={poster}
      />

      {/* 可见的 canvas 元素（负责显示画面，特斯拉不阻止） */}
      <canvas
        ref={canvasRef}
        className="absolute inset-0 h-full w-full object-contain"
      />

      {/* 加载状态 */}
      {loading && !error && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/80">
          <Loader2 className="h-8 w-8 animate-spin text-green-500" />
        </div>
      )}

      {/* 缓冲状态 */}
      {buffering && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <Loader2 className="h-6 w-6 animate-spin text-white/50" />
        </div>
      )}

      {/* 错误提示 */}
      {error && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/80">
          <div className="text-center">
            <p className="text-red-400">{error}</p>
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); window.location.reload(); }}
              className="mt-2 rounded bg-green-500 px-4 py-1.5 text-sm text-white"
            >
              重试
            </button>
          </div>
        </div>
      )}

      {/* 暂停时的播放按钮 */}
      {!loading && !playing && !error && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); togglePlay(); }}
            className="pointer-events-auto rounded-full bg-black/40 p-4 backdrop-blur-sm hover:bg-black/60"
          >
            <Play className="h-8 w-8 text-white" />
          </button>
        </div>
      )}

      {/* 顶部条 */}
      <div className={`pointer-events-none absolute inset-x-0 top-0 flex items-start justify-between bg-gradient-to-b from-black/80 to-transparent p-4 transition-opacity duration-200 ${showControls ? 'opacity-100' : 'opacity-0'}`}>
        <div className="pointer-events-auto flex items-center gap-3">
          {onBackToOriginal && (
              <button type="button" onClick={backToOriginal} className="rounded-md bg-white/10 px-3 py-1.5 text-sm font-medium backdrop-blur hover:bg-white/20" title="返回原版播放器">
                <RotateCcw className="inline h-4 w-4" /> 原版
              </button>
            )}
          <h1 className="text-base font-semibold drop-shadow md:text-xl">
            {title || '播放中'}
            {live && <span className="ml-2 rounded bg-red-600 px-1.5 py-0.5 text-[10px] font-bold uppercase">LIVE</span>}
          </h1>
        </div>
        <div className="pointer-events-auto flex items-center gap-2">
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); }}
            className="flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium bg-green-500/30 text-green-300 ring-1 ring-green-400/50 backdrop-blur"
            title="Canvas 渲染模式（绕过特斯拉限制）"
          >
            <MonitorPlay className="h-3.5 w-3.5" />
            Canvas
          </button>
        </div>
      </div>

      {/* 底部控制条 */}
      <div className={`pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/90 via-black/50 to-transparent p-4 transition-opacity duration-200 ${showControls ? 'opacity-100' : 'opacity-0'}`}>
        {/* 进度条 */}
        <div className="pointer-events-auto mb-3">
          <div
            className="relative h-1 cursor-pointer rounded-full bg-white/20 hover:h-1.5 transition-all"
            onClick={(e) => {
              const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
              const percent = (e.clientX - rect.left) / rect.width;
              seek(percent * (duration || 1));
            }}
          >
            <div
              className="h-full rounded-full bg-green-500"
              style={{ width: `${duration > 0 ? (currentTime / duration) * 100 : 0}%` }}
            />
          </div>
          <div className="mt-1 flex justify-between text-xs text-white/70">
            <span>{formatTime(currentTime)}</span>
            <span>{formatTime(duration)}</span>
          </div>
        </div>

        {/* 控制按钮 */}
        <div className="pointer-events-auto flex items-center justify-between">
          <div className="flex items-center gap-2">
            <button type="button" onClick={(e) => { e.stopPropagation(); seek(Math.max(0, currentTime - 10)); }} className="rounded p-1.5 hover:bg-white/10">
              <SkipBack className="h-4 w-4" />
            </button>
            <button type="button" onClick={(e) => { e.stopPropagation(); togglePlay(); }} className="rounded-full bg-white/10 p-2 hover:bg-white/20">
              {playing ? <Pause className="h-5 w-5" /> : <Play className="h-5 w-5" />}
            </button>
            <button type="button" onClick={(e) => { e.stopPropagation(); seek(Math.min(duration || 1, currentTime + 10)); }} className="rounded p-1.5 hover:bg-white/10">
              <SkipForward className="h-4 w-4" />
            </button>
            <div className="relative ml-2">
              <button type="button" onClick={(e) => { e.stopPropagation(); setShowRateMenu(!showRateMenu); }} className="rounded px-2 py-1 text-xs font-medium hover:bg-white/10">
                {rate}x
              </button>
              {showRateMenu && (
                <div className="absolute bottom-full left-0 mb-2 rounded-md bg-gray-900/95 p-1 backdrop-blur">
                  {PLAYBACK_RATES.map((r) => (
                    <button
                      key={r}
                      type="button"
                      onClick={(e) => { e.stopPropagation(); setPlaybackRate(r); }}
                      className={`block w-full rounded px-3 py-1.5 text-sm ${rate === r ? 'bg-green-500 text-white' : 'text-gray-300 hover:bg-white/10'}`}
                    >
                      {r}x
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>

          <div className="flex items-center gap-2">
            {qualities.length > 1 && (
              <div className="relative">
                <button type="button" onClick={(e) => { e.stopPropagation(); setShowQualityMenu(!showQualityMenu); }} className="rounded px-2 py-1 text-xs font-medium hover:bg-white/10">
                  {qualities.find((q) => q.value === quality)?.label || '清晰度'}
                </button>
                {showQualityMenu && (
                  <div className="absolute bottom-full right-0 mb-2 rounded-md bg-gray-900/95 p-1 backdrop-blur">
                    {qualities.map((q) => (
                      <button
                        key={q.value}
                        type="button"
                        onClick={(e) => { e.stopPropagation(); switchQuality(q.value); }}
                        className={`block w-full rounded px-3 py-1.5 text-sm ${quality === q.value ? 'bg-green-500 text-white' : 'text-gray-300 hover:bg-white/10'}`}
                      >
                        {q.label}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
            <button type="button" onClick={(e) => { e.stopPropagation(); toggleFullscreen(); }} className="rounded p-1.5 hover:bg-white/10">
              {isFullscreen ? <Minimize className="h-4 w-4" /> : <Maximize className="h-4 w-4" />}
            </button>
          </div>
        </div>
      </div>

      {/* 样式覆盖 */}
      <style>{`
        canvas { display: block; }
      `}</style>
    </div>
  );
}
