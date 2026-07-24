'use client';

/* eslint-disable @typescript-eslint/no-explicit-any */

import Hls from 'hls.js';
import {
  Cpu,
  Loader2,
  Maximize,
  Minimize,
  MonitorPlay,
  Pause,
  Play,
  RotateCcw,
  Volume2,
  VolumeX,
  Rewind,
  FastForward,
  Maximize2,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { WebCodecsPlayer } from '@/components/webcodecs/WebCodecsPlayer';

type PlayMode = 'video' | 'webcodecs';

interface TeslaPlayerProps {
  url: string;
  title?: string;
  poster?: string;
  live?: boolean;
  defaultMode?: PlayMode;
  onBackToOriginal?: () => void;
  onEnded?: () => void;
  playRecordKey?: string;
  onPlaybackReady?: () => void;
  onPlaybackError?: (message: string) => void;
}

const PLAYBACK_RATES = [0.5, 0.75, 1, 1.25, 1.5, 2, 3];

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

function getInitialMode(wanted: PlayMode): PlayMode {
  if (wanted === 'webcodecs' && WebCodecsPlayer.isSupported()) return 'webcodecs';
  return 'video';
}

function getUrlKind(url: string): 'hls' | 'flv' | 'file' | 'unknown' {
  const clean = url.toLowerCase().split('#')[0];
  if (clean.includes('.m3u8') || clean.includes('.m3u?') || clean.includes('/m3u8')) return 'hls';
  if (/\.flv(?:\?|$)/.test(clean)) return 'flv';
  if (/\.(?:mp4|webm|mov|m4v|mkv|avi)(?:\?|$)/.test(clean)) return 'file';
  return 'unknown';
}

export default function TeslaPlayer({
  url,
  title,
  poster,
  live = false,
  defaultMode: defaultModeProp = 'webcodecs',
  onBackToOriginal,
  onEnded: onEndedCallback,
  playRecordKey,
  onPlaybackReady,
  onPlaybackError,
}: TeslaPlayerProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const wcPlayerRef = useRef<WebCodecsPlayer | null>(null);
  const hlsRef = useRef<any>(null);
  const hideControlsTimerRef = useRef<number | null>(null);
  const progressSaveTimerRef = useRef<number | null>(null);
  const bufferingTimeoutRef = useRef<number | null>(null);
  const canvasRafRef = useRef<number>(0);
  const playbackReadyReportedRef = useRef(false);
  const playbackErrorReportedRef = useRef(false);

  const [loading, setLoading] = useState(true);
  const [buffering, setBuffering] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [rate, setRate] = useState(1);
  const [showRateMenu, setShowRateMenu] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [isWebFullscreen, setIsWebFullscreen] = useState(false);
  const [showControls, setShowControls] = useState(true);
  const [seekToTime, setSeekToTime] = useState<number | null>(null);
  const [showDebug] = useState(false);
  const [debugInfo, setDebugInfo] = useState<any>(null);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const [engineLabel, setEngineLabel] = useState('兼容播放');

  const [mode, setMode] = useState<PlayMode>(() => getInitialMode(defaultModeProp));

  const reportPlaybackReady = useCallback(() => {
    if (playbackReadyReportedRef.current) return;
    playbackReadyReportedRef.current = true;
    onPlaybackReady?.();
  }, [onPlaybackReady]);

  const reportPlaybackError = useCallback((message: string) => {
    if (playbackErrorReportedRef.current) return;
    playbackErrorReportedRef.current = true;
    onPlaybackError?.(message);
  }, [onPlaybackError]);

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

  // ===== 播放控制（统一接口） =====

  const seek = useCallback((t: number) => {
    if (mode === 'webcodecs') {
      wcPlayerRef.current?.seek(t);
    } else if (videoRef.current) {
      videoRef.current.currentTime = t;
    }
    setCurrentTime(t);
  }, [mode]);

  const togglePlay = useCallback(() => {
    if (mode === 'webcodecs') {
      wcPlayerRef.current?.unmute();
      wcPlayerRef.current?.togglePlay();
    } else if (videoRef.current) {
      const v = videoRef.current;
      if (v.paused) {
        v.muted = false;
        v.play().catch(() => {});
      } else {
        v.pause();
      }
    }
  }, [mode]);

  const toggleFullscreen = useCallback(() => {
    if (!containerRef.current) return;
    if (!document.fullscreenElement) {
      containerRef.current.requestFullscreen?.()?.catch(() => {});
    } else {
      document.exitFullscreen?.()?.catch(() => {});
    }
  }, []);

  const toggleWebFullscreen = useCallback(() => {
    setIsWebFullscreen((prev) => !prev);
  }, []);

  useEffect(() => {
    const handler = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', handler);
    return () => document.removeEventListener('fullscreenchange', handler);
  }, []);

  const setPlaybackRate = useCallback((r: number) => {
    if (mode === 'webcodecs') {
      wcPlayerRef.current?.setPlaybackRate(r);
    } else if (videoRef.current) {
      videoRef.current.playbackRate = r;
    }
    setRate(r);
    setShowRateMenu(false);
  }, [mode]);

  const toggleMute = useCallback(() => {
    const newMuted = !muted;
    if (mode === 'webcodecs') {
      wcPlayerRef.current?.setMuted(newMuted);
      if (!newMuted) wcPlayerRef.current?.setVolume(volume);
    } else if (videoRef.current) {
      videoRef.current.muted = newMuted;
      if (!newMuted) videoRef.current.volume = volume;
    }
    setMuted(newMuted);
  }, [muted, volume, mode]);

  const resetControlsTimer = useCallback(() => {
    if (hideControlsTimerRef.current) clearTimeout(hideControlsTimerRef.current);
    setShowControls(true);
    hideControlsTimerRef.current = window.setTimeout(() => {
      if (playing && !showRateMenu) setShowControls(false);
    }, 3000);
  }, [playing, showRateMenu]);

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

  const clearBufferingTimeout = useCallback(() => {
    if (bufferingTimeoutRef.current) {
      clearTimeout(bufferingTimeoutRef.current);
      bufferingTimeoutRef.current = null;
    }
  }, []);

  const startBufferingTimeout = useCallback(() => {
    clearBufferingTimeout();
    bufferingTimeoutRef.current = window.setTimeout(() => {
      const message = '播放持续缓冲，当前资源可能不稳定';
      setError(message);
      setLoading(false);
      reportPlaybackError(message);
    }, 20000);
  }, [clearBufferingTimeout, reportPlaybackError]);

  // ===== 原生 video 回退模式初始化 =====
  useEffect(() => {
    if (mode === 'webcodecs') return;

    const container = containerRef.current;
    if (!container) return;

    let destroyed = false;
    let flvPlayer: any = null;
    let directFallbackTried = false;
    setLoading(true);
    setError(null);

    // 创建 video 元素
    const videoEl = document.createElement('video');
    videoEl.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;object-fit:contain;z-index:1;';
    videoEl.muted = true;
    videoEl.playsInline = true;
    videoEl.setAttribute('playsinline', '');
    videoEl.setAttribute('x-webkit-airplay', 'deny');
    videoEl.crossOrigin = 'anonymous';
    if (poster) videoEl.poster = poster;

    container.insertBefore(videoEl, container.firstChild);
    videoRef.current = videoEl;

    const onTimeUpdate = () => { if (!destroyed) setCurrentTime(videoEl.currentTime); };
    const onDuration = () => { if (!destroyed && videoEl.duration > 0) { setDuration(videoEl.duration); setLoading(false); } };
    const onPlay = () => {
      if (!destroyed) {
        setPlaying(true);
        setBuffering(false);
        setLoading(false);
        clearBufferingTimeout();
        reportPlaybackReady();
      }
    };
    const onPause = () => { if (!destroyed) { setPlaying(false); setBuffering(false); } };
    const onWaiting = () => { if (!destroyed) { setBuffering(true); startBufferingTimeout(); } };
    const onPlaying = () => { if (!destroyed) { setPlaying(true); setBuffering(false); clearBufferingTimeout(); } };
    const onEnded = () => {
      if (destroyed) return;
      setPlaying(false);
      clearBufferingTimeout();
      if (playRecordKey) saveProgress(playRecordKey, duration || 0);
      setTimeout(() => onEndedCallback?.(), 500);
    };
    const onVideoError = () => {
      if (destroyed) return;
      const err = videoEl.error;
      const message = '当前资源格式不受浏览器支持：' + (err?.message || err?.code || '未知错误');
      setError(message);
      reportPlaybackError(message);
    };

    videoEl.addEventListener('timeupdate', onTimeUpdate);
    videoEl.addEventListener('durationchange', onDuration);
    videoEl.addEventListener('play', onPlay);
    videoEl.addEventListener('pause', onPause);
    videoEl.addEventListener('waiting', onWaiting);
    videoEl.addEventListener('playing', onPlaying);
    videoEl.addEventListener('ended', onEnded);
    videoEl.addEventListener('error', onVideoError);

    const attachDirectMedia = () => {
      if (destroyed) return;
      setEngineLabel('通用播放');
      videoEl.src = url;
      videoEl.load();
      videoEl.play().catch(() => {});
    };

    const initializeVideoEngine = async () => {
      const kind = getUrlKind(url);

      if (kind === 'flv') {
        try {
          const flvModule: any = await import('flv.js');
          const flvjs = flvModule.default || flvModule;
          if (!destroyed && flvjs.isSupported()) {
            setEngineLabel('FLV 兼容');
            flvPlayer = flvjs.createPlayer({ type: 'flv', url, isLive: live });
            flvPlayer.attachMediaElement(videoEl);
            flvPlayer.load();
            flvPlayer.play().catch(() => {});
            return;
          }
        } catch (e) {
          console.warn('[TeslaPlayer] flv.js initialization failed:', e);
        }
        attachDirectMedia();
        return;
      }

      if ((kind === 'hls' || kind === 'unknown') && Hls.isSupported()) {
        setEngineLabel('HLS 兼容');
        const hls = new Hls({
          enableWorker: true,
          lowLatencyMode: false,
          autoStartLoad: true,
          startPosition: seekToTime ?? savedProgress,
          maxBufferLength: live ? 12 : 30,
          maxMaxBufferLength: live ? 24 : 60,
          backBufferLength: live ? 6 : 15,
        });
        hlsRef.current = hls;

        hls.on(Hls.Events.ERROR, (_evt: any, data: any) => {
          if (destroyed || !data.fatal) return;

          // Extension-less MP4 endpoints are often mistaken for HLS. Try the
          // browser directly once before declaring the whole source broken.
          if (kind === 'unknown' && !directFallbackTried) {
            directFallbackTried = true;
            try { hls.destroy(); } catch {}
            hlsRef.current = null;
            attachDirectMedia();
            return;
          }

          const message = 'HLS 资源无法播放：' + (data.details || data.type);
          setError(message);
          reportPlaybackError(message);
        });

        hls.on(Hls.Events.MANIFEST_PARSED, () => {
          videoEl.play().catch(() => {});
        });

        hls.attachMedia(videoEl);
        hls.loadSource(url);
        return;
      }

      if (kind === 'hls' && videoEl.canPlayType('application/vnd.apple.mpegurl')) {
        setEngineLabel('系统 HLS');
      }
      attachDirectMedia();
    };

    initializeVideoEngine();

    return () => {
      destroyed = true;
      if (canvasRafRef.current) cancelAnimationFrame(canvasRafRef.current);
      if (flvPlayer) { try { flvPlayer.destroy(); } catch {} flvPlayer = null; }
      if (hlsRef.current) { try { hlsRef.current.destroy(); } catch {} hlsRef.current = null; }
      if (videoEl) {
        videoEl.pause();
        videoEl.removeAttribute('src');
        videoEl.load();
        if (videoEl.parentNode) videoEl.parentNode.removeChild(videoEl);
      }
      videoRef.current = null;
    };
  }, [url, mode, live, poster, reportPlaybackError, reportPlaybackReady]);

  // ===== webcodecs 模式初始化 =====
  useEffect(() => {
    if (mode !== 'webcodecs' || !canvasRef.current) return;

    const kind = getUrlKind(url);
    if (kind === 'flv' || kind === 'file') {
      setMode('video');
      return;
    }

    let destroyed = false;
    setLoading(true);
    setError(null);

    try {
      const player = new WebCodecsPlayer(canvasRef.current, {
        onTime: (t) => { if (!destroyed) setCurrentTime(t); },
        onDurationChange: (d) => { if (!destroyed) { setDuration(d); setLoading(false); } },
        onStateChange: (s) => {
          if (destroyed) return;
          if (s === 'playing') {
            setPlaying(true);
            setBuffering(false);
            setLoading(false);
            clearBufferingTimeout();
            setEngineLabel('特斯拉兼容');
            reportPlaybackReady();
          }
          else if (s === 'paused') { setPlaying(false); setBuffering(false); }
          else if (s === 'buffering') { setBuffering(true); startBufferingTimeout(); }
          else if (s === 'ended') {
            setPlaying(false);
            clearBufferingTimeout();
            if (playRecordKey) saveProgress(playRecordKey, duration || 0);
            setTimeout(() => onEndedCallback?.(), 500);
          }
        },
        onError: (msg) => {
          if (destroyed) return;
          console.warn('[TeslaPlayer] WebCodecs failed, falling back to native video:', msg);
          setError(null);
          setLoading(true);
          setMode('video');
        },
      });

      wcPlayerRef.current = player;
      player.setShowDebug(showDebug);

      const startPos = seekToTime !== null ? seekToTime : savedProgress;
      player.load(url, startPos).catch((e) => {
        if (destroyed) return;
        console.warn('[TeslaPlayer] WebCodecs load failed, falling back to native video:', e);
        setError(null);
        setLoading(true);
        setMode('video');
      });

      const statsTimer = window.setInterval(() => {
        if (showDebug && !destroyed) {
          try { setDebugInfo(player.getStats()); } catch {}
        }
      }, 500);

      return () => {
        destroyed = true;
        clearInterval(statsTimer);
        clearBufferingTimeout();
        player.destroy();
        wcPlayerRef.current = null;
      };
    } catch (e: any) {
      console.warn('[TeslaPlayer] WebCodecs initialization failed, falling back to native video:', e);
      setError(null);
      setLoading(true);
      setMode('video');
      return () => { destroyed = true; };
    }
  }, [url, mode]);

  useEffect(() => {
    wcPlayerRef.current?.setShowDebug(showDebug);
  }, [showDebug]);

  return (
    <div
      ref={containerRef}
      className={`relative w-full bg-black transition-all duration-300 ${
        isWebFullscreen ? 'fixed inset-0 z-[9999] h-screen w-screen rounded-none' : 'h-full'
      }`}
      style={isWebFullscreen ? { position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, zIndex: 9999 } : undefined}
      onMouseMove={resetControlsTimer}
      onTouchStart={resetControlsTimer}
      onClick={togglePlay}
    >
      {/* WebCodecs renders decoded VideoFrames directly to Canvas. */}
      {mode === 'webcodecs' && (
        <canvas
          ref={canvasRef}
          className="absolute inset-0 h-full w-full"
          style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', zIndex: 1 }}
        />
      )}

      {/* 调试信息 */}
      {showDebug && debugInfo && mode === 'webcodecs' && (
        <div className="absolute top-2 left-2 z-20 bg-black/70 p-2 text-xs text-green-400 font-mono pointer-events-none">
          <div>state: <b>{debugInfo.state}</b></div>
          <div>render: {debugInfo.renderFps} fps  decode: {debugInfo.decodeFps} fps</div>
          <div>queue: {debugInfo.queued}  dropped: {debugInfo.dropped}</div>
          <div>{debugInfo.resolution} {debugInfo.codec}</div>
          <div>t={debugInfo.currentSec}s  audioCtx={debugInfo.audioCtx}</div>
        </div>
      )}

      {/* 加载状态 */}
      {loading && !error && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/80 z-10">
          <Loader2 className="h-10 w-10 animate-spin text-green-500" />
        </div>
      )}

      {/* 缓冲状态 */}
      {buffering && !loading && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none z-10">
          <Loader2 className="h-8 w-8 animate-spin text-white/60" />
        </div>
      )}

      {/* 错误提示 */}
      {error && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/80 z-20">
          <div className="text-center px-4">
            <p className="text-red-400 text-sm">{error}</p>
            <div className="mt-3 flex gap-2 justify-center flex-wrap">
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); window.location.reload(); }}
                className="rounded bg-green-500 px-4 py-1.5 text-sm text-white"
              >
                重试
              </button>
              {onBackToOriginal && (
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); onBackToOriginal(); }}
                  className="rounded bg-blue-600 px-4 py-1.5 text-sm text-white"
                >
                  返回原版
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* 暂停播放按钮 */}
      {!loading && !playing && !error && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none z-10">
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); togglePlay(); }}
            className="pointer-events-auto rounded-full bg-black/40 p-5 backdrop-blur-sm hover:bg-black/60 transition-all active:scale-95"
          >
            <Play className="h-10 w-10 text-white md:h-12 md:w-12" />
          </button>
        </div>
      )}

      {/* 顶部标题栏 */}
      <div className={`pointer-events-none absolute inset-x-0 top-0 flex items-start justify-between bg-gradient-to-b from-black/60 to-transparent p-3 md:p-4 transition-opacity duration-200 z-10 ${showControls ? 'opacity-100' : 'opacity-0'}`}>
        <div className="pointer-events-auto">
          <h1 className="text-sm md:text-base font-semibold drop-shadow max-w-[60vw] md:max-w-[70vw] truncate">
            {title || '播放中'}
            {live && <span className="ml-2 rounded bg-red-600 px-1.5 py-0.5 text-[10px] font-bold uppercase">LIVE</span>}
          </h1>
        </div>
        <div className="pointer-events-auto flex items-center gap-1">
          <div className="rounded bg-green-500/20 px-2 py-1 text-xs text-green-300">
            {engineLabel}
          </div>
        </div>
      </div>

      {/* 底部控制条 */}
      <div className={`pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/90 via-black/60 to-transparent px-2 pb-2 pt-12 md:px-3 md:pb-3 md:pt-16 transition-opacity duration-200 z-10 ${showControls ? 'opacity-100' : 'opacity-0'}`}>
        {/* 进度条 */}
        <div className="pointer-events-auto mb-1 md:mb-2 group">
          <div
            className="relative h-1 group-hover:h-1.5 cursor-pointer rounded-full bg-white/20 transition-all"
            onClick={(e) => {
              e.stopPropagation();
              const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
              const percent = (e.clientX - rect.left) / rect.width;
              seek(percent * (duration || 1));
            }}
          >
            <div
              className="h-full rounded-full bg-green-500"
              style={{ width: `${duration > 0 ? (currentTime / duration) * 100 : 0}%` }}
            />
            <div
              className="absolute top-1/2 -translate-y-1/2 w-2.5 h-2.5 rounded-full bg-white shadow opacity-0 group-hover:opacity-100 transition-opacity"
              style={{ left: `calc(${duration > 0 ? (currentTime / duration) * 100 : 0}% - 5px)` }}
            />
          </div>
        </div>

        {/* 控制按钮行 */}
        <div className="pointer-events-auto flex items-center justify-between">
          <div className="flex items-center gap-0.5 md:gap-1">
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); seek(Math.max(0, currentTime - 10)); }}
              className="relative p-1.5 md:p-2 text-white/80 hover:text-white hover:bg-white/10 rounded transition-colors"
              title="快退10秒"
            >
              <Rewind className="h-5 w-5" />
              <span className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 text-[9px] font-bold">10</span>
            </button>

            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); togglePlay(); }}
              className="p-1.5 md:p-2 text-white hover:bg-white/10 rounded transition-colors"
            >
              {playing ? <Pause className="h-6 w-6" /> : <Play className="h-6 w-6" />}
            </button>

            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); seek(Math.min(duration || 1, currentTime + 10)); }}
              className="relative p-1.5 md:p-2 text-white/80 hover:text-white hover:bg-white/10 rounded transition-colors"
              title="快进10秒"
            >
              <FastForward className="h-5 w-5" />
              <span className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 text-[9px] font-bold">10</span>
            </button>

            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); toggleMute(); }}
              className="p-1.5 md:p-2 text-white/80 hover:text-white hover:bg-white/10 rounded transition-colors"
            >
              {muted ? <VolumeX className="h-5 w-5" /> : <Volume2 className="h-5 w-5" />}
            </button>

            <div className="text-xs text-white/70 ml-1">
              {formatTime(currentTime)} / {formatTime(duration)}
            </div>

            {/* 倍速仅在原生回退模式可用 */}
            {mode !== 'webcodecs' && (
              <div className="relative ml-1">
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); setShowRateMenu(!showRateMenu); }}
                  className="px-2 py-1 text-xs text-white/80 hover:text-white hover:bg-white/10 rounded transition-colors"
                >
                  {rate}x
                </button>
                {showRateMenu && (
                  <div className="absolute bottom-full left-0 mb-1 rounded bg-black/90 backdrop-blur p-1 z-20 min-w-[80px]">
                    {PLAYBACK_RATES.map((r) => (
                      <button
                        key={r}
                        type="button"
                        onClick={(e) => { e.stopPropagation(); setPlaybackRate(r); }}
                        className={`block w-full rounded px-2 py-1 text-xs text-left ${rate === r ? 'bg-green-500 text-white' : 'text-gray-300 hover:bg-white/10'}`}
                      >
                        {r}x
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>

          <div className="flex items-center gap-0.5 md:gap-1">
            {onBackToOriginal && (
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); onBackToOriginal(); }}
                className="flex items-center gap-1 px-2 py-1 text-xs text-white/80 hover:text-white hover:bg-white/10 rounded transition-colors"
                title="返回原版播放器"
              >
                <RotateCcw className="h-4 w-4" />
                原版
              </button>
            )}

            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); toggleWebFullscreen(); }}
              className="p-1.5 md:p-2 text-white/80 hover:text-white hover:bg-white/10 rounded transition-colors"
              title={isWebFullscreen ? '退出网页全屏' : '网页全屏'}
            >
              <Maximize2 className="h-5 w-5" />
            </button>

            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); toggleFullscreen(); }}
              className="p-1.5 md:p-2 text-white/80 hover:text-white hover:bg-white/10 rounded transition-colors"
              title={isFullscreen ? '退出全屏' : '全屏'}
            >
              {isFullscreen ? <Minimize className="h-5 w-5" /> : <Maximize className="h-5 w-5" />}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}