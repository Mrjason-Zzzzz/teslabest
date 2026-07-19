'use client';

/* eslint-disable @typescript-eslint/no-explicit-any */

import Hls from 'hls.js';
import {
  Loader2,
  Maximize,
  Minimize,
  Pause,
  Play,
  RotateCcw,
  SkipForward,
  SkipBack,
  Cpu,
  MonitorPlay,
  Settings,
  Volume2,
  VolumeX,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { setTeslaOptOut } from '@/components/TeslaAutoRedirect';
import { WebCodecsPlayer } from '@/components/webcodecs/WebCodecsPlayer';

type PlayMode = 'webcodecs' | 'video';

interface TeslaPlayerProps {
  url: string;
  title?: string;
  poster?: string;
  live?: boolean;
  onBackToOriginal?: () => void;
  onEnded?: () => void;
  playRecordKey?: string;
  defaultMode?: PlayMode;
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

function getInitialMode(): PlayMode {
  if (typeof window === 'undefined') return 'webcodecs';
  const saved = localStorage.getItem('tesla_player_mode') as PlayMode | null;
  if (saved && ['webcodecs', 'video'].includes(saved)) return saved;
  return 'webcodecs';
}

export default function TeslaPlayer({
  url,
  title,
  poster,
  live = false,
  onBackToOriginal,
  onEnded: onEndedCallback,
  playRecordKey,
  defaultMode,
}: TeslaPlayerProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const hlsRef = useRef<Hls | null>(null);
  const wcPlayerRef = useRef<WebCodecsPlayer | null>(null);
  const hideControlsTimerRef = useRef<number | null>(null);
  const progressSaveTimerRef = useRef<number | null>(null);
  const bufferingTimeoutRef = useRef<number | null>(null);
  const loadTimeoutRef = useRef<number | null>(null);

  const [mode, setMode] = useState<PlayMode>(defaultMode || getInitialMode());
  const [showModeMenu, setShowModeMenu] = useState(false);
  const [wcSupported, setWcSupported] = useState(true);

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
  const [showDebug, setShowDebug] = useState(false);
  const [debugInfo, setDebugInfo] = useState<any>(null);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);

  const savedProgress = useMemo(() => {
    if (!playRecordKey) return 0;
    return getSavedProgress(playRecordKey);
  }, [playRecordKey]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const w = window as any;
    setWcSupported(typeof w.VideoDecoder === 'function' && typeof w.AudioDecoder === 'function');
  }, []);

  useEffect(() => {
    if (savedProgress > 0 && duration > 0 && seekToTime === null) {
      const progressRatio = savedProgress / duration;
      if (progressRatio > 0.05 && progressRatio < 0.95) {
        setSeekToTime(savedProgress);
      }
    }
  }, [savedProgress, duration, seekToTime]);

  const seek = useCallback((t: number) => {
    if (mode === 'webcodecs' && wcPlayerRef.current) {
      wcPlayerRef.current.seek(t);
      setCurrentTime(t);
    } else if (mode === 'video' && videoRef.current) {
      videoRef.current.currentTime = t;
      setCurrentTime(t);
    }
  }, [mode]);

  const togglePlay = useCallback(() => {
    if (mode === 'webcodecs' && wcPlayerRef.current) {
      wcPlayerRef.current.togglePlay();
    } else if (mode === 'video' && videoRef.current) {
      const v = videoRef.current;
      if (v.paused) v.play().catch(() => {});
      else v.pause();
    }
  }, [mode]);

  const toggleFullscreen = useCallback(() => {
    if (!containerRef.current) return;
    if (!document.fullscreenElement) {
      const el = containerRef.current;
      if (el.requestFullscreen) {
        el.requestFullscreen().catch(() => {});
      } else if ((el as any).webkitRequestFullscreen) {
        (el as any).webkitRequestFullscreen?.();
      } else if ((el as any).msRequestFullscreen) {
        (el as any).msRequestFullscreen?.();
      }
    } else {
      if (document.exitFullscreen) {
        document.exitFullscreen().catch(() => {});
      } else if ((document as any).webkitExitFullscreen) {
        (document as any).webkitExitFullscreen?.();
      } else if ((document as any).msExitFullscreen) {
        (document as any).msExitFullscreen?.();
      }
    }
  }, []);

  useEffect(() => {
    const onFullscreenChange = () => {
      setIsFullscreen(!!document.fullscreenElement);
    };
    document.addEventListener('fullscreenchange', onFullscreenChange);
    document.addEventListener('webkitfullscreenchange', onFullscreenChange);
    return () => {
      document.removeEventListener('fullscreenchange', onFullscreenChange);
      document.removeEventListener('webkitfullscreenchange', onFullscreenChange);
    };
  }, []);

  const setPlaybackRate = useCallback((r: number) => {
    if (mode === 'webcodecs') {
      wcPlayerRef.current?.setPlaybackRate(r);
      setRate(r);
    } else if (mode === 'video' && videoRef.current) {
      videoRef.current.playbackRate = r;
      setRate(r);
    }
    setShowRateMenu(false);
  }, [mode]);

  const toggleMute = useCallback(() => {
    if (mode === 'webcodecs' && wcPlayerRef.current) {
      const newMuted = !muted;
      wcPlayerRef.current.setVolume(newMuted ? 0 : volume);
      setMuted(newMuted);
    } else if (mode === 'video' && videoRef.current) {
      const v = videoRef.current;
      v.muted = !v.muted;
      setMuted(v.muted);
    }
  }, [mode, muted, volume]);

  const switchQuality = useCallback((q: string) => {
    setQuality(q);
    setShowQualityMenu(false);
    if (mode === 'video' && hlsRef.current) {
      const hls = hlsRef.current;
      if (q === 'auto') {
        hls.currentLevel = -1;
      } else {
        const level = parseInt(q, 10);
        if (!isNaN(level)) {
          hls.currentLevel = level;
        }
      }
    }
  }, [mode]);

  const switchMode = useCallback((newMode: PlayMode) => {
    if (newMode === 'webcodecs' && !wcSupported) return;
    setMode(newMode);
    setShowModeMenu(false);
    if (typeof window !== 'undefined') {
      localStorage.setItem('tesla_player_mode', newMode);
    }
  }, [wcSupported]);

  const backToOriginal = useCallback(() => {
    setTeslaOptOut();
    onBackToOriginal?.();
  }, [onBackToOriginal]);

  const resetControlsTimer = useCallback(() => {
    if (hideControlsTimerRef.current) clearTimeout(hideControlsTimerRef.current);
    setShowControls(true);
    hideControlsTimerRef.current = window.setTimeout(() => {
      if (playing && !showRateMenu && !showQualityMenu && !showModeMenu) setShowControls(false);
    }, 3000);
  }, [playing, showRateMenu, showQualityMenu, showModeMenu]);

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
      console.warn('[TeslaPlayer] buffering timeout after 30s');
      setError('缓冲超时，网络可能不稳定');
      setLoading(false);
    }, 30000);
  }, [clearBufferingTimeout]);

  // ===== Video 模式初始化（原生 video + hls.js 降级方案）=====
  useEffect(() => {
    if (mode !== 'video') return;
    if (!videoRef.current) return;

    let destroyed = false;
    setLoading(true);
    setError(null);
    setBuffering(false);

    const video = videoRef.current;
    const startPos = seekToTime !== null ? seekToTime : savedProgress;

    const onLoadedMetadata = () => {
      if (destroyed) return;
      setDuration(video.duration || 0);
      setLoading(false);
    };

    const onTimeUpdate = () => {
      if (!destroyed) setCurrentTime(video.currentTime);
    };

    const onPlay = () => {
      if (!destroyed) {
        setPlaying(true);
        setBuffering(false);
        setLoading(false);
      }
    };

    const onPause = () => {
      if (!destroyed) setPlaying(false);
    };

    const onWaiting = () => {
      if (destroyed) return;
      setBuffering(true);
      startBufferingTimeout();
    };

    const onPlaying = () => {
      if (destroyed) return;
      setBuffering(false);
      setLoading(false);
      clearBufferingTimeout();
    };

    const onEnded = () => {
      if (destroyed) return;
      setPlaying(false);
      if (playRecordKey) saveProgress(playRecordKey, video.duration || 0);
      setTimeout(() => onEndedCallback?.(), 500);
    };

    const onError = () => {
      if (destroyed) return;
      setError('播放错误，请尝试切换模式');
      setLoading(false);
    };

    const onRateChange = () => {
      if (!destroyed) setRate(video.playbackRate);
    };

    video.addEventListener('loadedmetadata', onLoadedMetadata);
    video.addEventListener('timeupdate', onTimeUpdate);
    video.addEventListener('play', onPlay);
    video.addEventListener('pause', onPause);
    video.addEventListener('waiting', onWaiting);
    video.addEventListener('playing', onPlaying);
    video.addEventListener('ended', onEnded);
    video.addEventListener('error', onError);
    video.addEventListener('ratechange', onRateChange);

    let hls: Hls | null = null;

    if (Hls.isSupported()) {
      hls = new Hls({
        enableWorker: true,
        lowLatencyMode: false,
        autoStartLoad: true,
        startPosition: startPos,
        maxBufferLength: 60,
        maxMaxBufferLength: 120,
        backBufferLength: 60,
        xhrSetup: (xhr: XMLHttpRequest, xhrUrl: string) => {
          if (xhrUrl.includes('.m3u8')) {
            xhr.addEventListener('load', () => {
              if (xhr.readyState === 4 && xhr.status === 200) {
                const original = xhr.responseText;
                const filtered = filterAdsFromM3U8(original);
                if (filtered !== original) {
                  Object.defineProperty(xhr, 'responseText', { value: filtered, writable: false });
                }
              }
            });
          }
        },
      });
      hlsRef.current = hls;

      hls.on(Hls.Events.MANIFEST_PARSED, (_evt, data) => {
        if (destroyed) return;
        const levels = data.levels || [];
        const qs: Array<{ label: string; value: string }> = [
          { label: '自动', value: 'auto' },
          ...levels.map((l: any, i: number) => ({
            label: l.height ? `${l.height}p` : `清晰度 ${i + 1}`,
            value: String(i),
          })),
        ];
        setQualities(qs);
      });

      hls.on(Hls.Events.LEVEL_LOADED, () => {
        if (destroyed) return;
        if (startPos > 0 && video.paused) {
          video.currentTime = startPos;
        }
      });

      hls.on(Hls.Events.ERROR, (_evt, data) => {
        if (destroyed) return;
        console.warn('[TeslaPlayer] HLS ERROR:', data.type, data.details);
        if (data.fatal) {
          if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
            try { hlsRef.current?.startLoad(); } catch {}
          } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
            try { hlsRef.current?.recoverMediaError(); } catch {}
          } else {
            setError('播放错误: ' + (data.details || data.type));
            setLoading(false);
          }
        }
      });

      hls.attachMedia(video);
      hls.loadSource(url);
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = url;
      if (startPos > 0) {
        video.currentTime = startPos;
      }
    } else {
      setError('当前浏览器不支持 HLS 播放');
      setLoading(false);
    }

    const loadTimeout = window.setTimeout(() => {
      if (!destroyed && !video.duration) {
        setLoading(false);
      }
    }, 10000);

    return () => {
      destroyed = true;
      clearTimeout(loadTimeout);
      clearBufferingTimeout();
      video.removeEventListener('loadedmetadata', onLoadedMetadata);
      video.removeEventListener('timeupdate', onTimeUpdate);
      video.removeEventListener('play', onPlay);
      video.removeEventListener('pause', onPause);
      video.removeEventListener('waiting', onWaiting);
      video.removeEventListener('playing', onPlaying);
      video.removeEventListener('ended', onEnded);
      video.removeEventListener('error', onError);
      video.removeEventListener('ratechange', onRateChange);
      if (hls) {
        try { hls.destroy(); } catch {}
        hlsRef.current = null;
      }
    };
  }, [mode, url, playRecordKey, onEndedCallback, savedProgress, seekToTime, startBufferingTimeout, clearBufferingTimeout]);

  // ===== WebCodecs 模式初始化 =====
  useEffect(() => {
    if (mode !== 'webcodecs') return;
    if (!canvasRef.current) return;
    if (!wcSupported) {
      setError('当前浏览器不支持 WebCodecs API');
      setLoading(false);
      return;
    }

    let destroyed = false;
    setLoading(true);
    setError(null);

    try {
      const player = new WebCodecsPlayer(canvasRef.current, {
        onTime: (t) => {
          if (!destroyed) setCurrentTime(t);
        },
        onDurationChange: (d) => {
          if (!destroyed) {
            setDuration(d);
            setLoading(false);
          }
        },
        onStateChange: (s) => {
          if (destroyed) return;
          if (s === 'playing') {
            setPlaying(true);
            setBuffering(false);
            setLoading(false);
            clearBufferingTimeout();
          } else if (s === 'paused') {
            setPlaying(false);
            setBuffering(false);
          } else if (s === 'buffering') {
            setBuffering(true);
            startBufferingTimeout();
          } else if (s === 'ended') {
            setPlaying(false);
            clearBufferingTimeout();
            if (playRecordKey) saveProgress(playRecordKey, duration || 0);
            setTimeout(() => onEndedCallback?.(), 500);
          } else if (s === 'error') {
            clearBufferingTimeout();
          }
        },
        onError: (msg) => {
          if (!destroyed) {
            setError(msg);
            setLoading(false);
            clearBufferingTimeout();
          }
        },
      });

      wcPlayerRef.current = player;
      player.setShowDebug(showDebug);

      const startPos = seekToTime !== null ? seekToTime : savedProgress;
      player.load(url, startPos).catch((e) => {
        if (!destroyed) {
          setError('加载失败: ' + (e?.message || String(e)));
          setLoading(false);
        }
      });

      const statsTimer = window.setInterval(() => {
        if (showDebug && player) {
          try {
            setDebugInfo(player.getStats());
          } catch {
            // ignore
          }
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
      setError('播放器初始化失败: ' + (e?.message || String(e)));
      setLoading(false);
      return () => { destroyed = true; };
    }
  }, [mode, url, wcSupported, showDebug, playRecordKey, onEndedCallback, duration, savedProgress, seekToTime, startBufferingTimeout, clearBufferingTimeout]);

  useEffect(() => {
    if (mode !== 'webcodecs') return;
    const p = wcPlayerRef.current;
    if (p) p.setShowDebug(showDebug);
  }, [mode, showDebug]);

  const modeLabel = mode === 'webcodecs' ? 'WebCodecs' : 'Video';

  return (
    <div
      ref={containerRef}
      className="relative w-full h-full bg-black"
      onMouseMove={resetControlsTimer}
      onTouchStart={resetControlsTimer}
      onClick={togglePlay}
    >
      {/* video 元素（video 模式用） */}
      {mode === 'video' && (
        <video
          ref={videoRef}
          className="absolute inset-0 h-full w-full object-contain"
          playsInline
          poster={poster}
          crossOrigin="anonymous"
        />
      )}

      {/* canvas 元素（webcodecs 模式用） */}
      {mode === 'webcodecs' && (
        <canvas
          ref={canvasRef}
          className="absolute inset-0 h-full w-full object-contain"
        />
      )}

      {/* 调试信息 */}
      {showDebug && debugInfo && mode === 'webcodecs' && (
        <div className="absolute top-2 left-2 z-20 bg-black/70 p-2 text-xs text-green-400 font-mono pointer-events-none">
          <div>state: <b>{debugInfo.state}</b></div>
          <div>render: {debugInfo.renderFps} fps · decode: {debugInfo.decodeFps} fps</div>
          <div>queue: {debugInfo.queued} · inDecode: {debugInfo.decodeQueue} · dropped: {debugInfo.dropped}</div>
          <div>buffer v{debugInfo.bufferedVideoSec}s · a{debugInfo.bufferedAudioSec}s</div>
          <div>{debugInfo.resolution} {debugInfo.codec}</div>
          <div>t {debugInfo.currentSec}s</div>
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
              {mode === 'webcodecs' && (
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); switchMode('video'); }}
                  className="rounded bg-gray-600 px-4 py-1.5 text-sm text-white"
                >
                  切换 Video 模式
                </button>
              )}
              {mode === 'video' && wcSupported && (
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); switchMode('webcodecs'); }}
                  className="rounded bg-purple-600 px-4 py-1.5 text-sm text-white"
                >
                  切换 WebCodecs 模式
                </button>
              )}
              {onBackToOriginal && (
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); backToOriginal(); }}
                  className="rounded bg-blue-600 px-4 py-1.5 text-sm text-white"
                >
                  返回原版
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* 暂停时的播放按钮 */}
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

      {/* 顶部条 */}
      <div className={`pointer-events-none absolute inset-x-0 top-0 flex items-start justify-between bg-gradient-to-b from-black/80 to-transparent p-3 md:p-4 transition-opacity duration-200 z-10 ${showControls ? 'opacity-100' : 'opacity-0'}`}>
        <div className="pointer-events-auto flex items-center gap-2 md:gap-3">
          {onBackToOriginal && (
            <button
              type="button"
              onClick={backToOriginal}
              className="rounded-md bg-white/10 px-2.5 py-1.5 text-xs md:text-sm font-medium backdrop-blur hover:bg-white/20"
              title="返回原版播放器"
            >
              <RotateCcw className="inline h-4 w-4" /> <span className="hidden md:inline">原版</span>
            </button>
          )}
          <h1 className="text-sm md:text-base font-semibold drop-shadow max-w-[50vw] md:max-w-[60vw] truncate">
            {title || '播放中'}
            {live && <span className="ml-2 rounded bg-red-600 px-1.5 py-0.5 text-[10px] font-bold uppercase">LIVE</span>}
          </h1>
        </div>
        <div className="pointer-events-auto flex items-center gap-1.5 md:gap-2">
          <div className="relative">
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); setShowModeMenu(!showModeMenu); }}
              className={`flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium backdrop-blur ${
                mode === 'webcodecs'
                  ? 'bg-purple-500/30 text-purple-300 ring-1 ring-purple-400/50'
                  : 'bg-blue-500/30 text-blue-300 ring-1 ring-blue-400/50'
              }`}
              title="播放模式"
            >
              {mode === 'webcodecs' ? <Cpu className="h-3.5 w-3.5" /> : <MonitorPlay className="h-3.5 w-3.5" />}
              <span className="hidden sm:inline">{modeLabel}</span>
            </button>
            {showModeMenu && (
              <div className="absolute top-full right-0 mt-1 rounded-md bg-gray-900/95 p-1 backdrop-blur z-20 min-w-[160px]">
                {wcSupported && (
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); switchMode('webcodecs'); }}
                    className={`block w-full rounded px-3 py-1.5 text-sm text-left ${mode === 'webcodecs' ? 'bg-purple-500 text-white' : 'text-gray-300 hover:bg-white/10'}`}
                  >
                    WebCodecs 模式（行驶用）
                  </button>
                )}
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); switchMode('video'); }}
                  className={`block w-full rounded px-3 py-1.5 text-sm text-left ${mode === 'video' ? 'bg-blue-500 text-white' : 'text-gray-300 hover:bg-white/10'}`}
                >
                  Video 模式（兼容）
                </button>
              </div>
            )}
          </div>

          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); setShowDebug(!showDebug); }}
            className={`flex items-center gap-1 rounded-md px-2 py-1.5 text-xs backdrop-blur ${
              showDebug ? 'bg-yellow-500/30 text-yellow-300 ring-1 ring-yellow-400/50' : 'bg-white/10 text-white/70 hover:bg-white/20'
            }`}
            title="调试信息"
          >
            <Settings className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {/* 底部控制条 */}
      <div className={`pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/90 via-black/50 to-transparent px-3 pb-3 pt-8 md:px-4 md:pb-4 md:pt-10 transition-opacity duration-200 z-10 ${showControls ? 'opacity-100' : 'opacity-0'}`}>
        <div className="pointer-events-auto mb-2 md:mb-3">
          <div
            className="relative h-2 md:h-2.5 cursor-pointer rounded-full bg-white/30 hover:bg-white/40 transition-all"
            onClick={(e) => {
              e.stopPropagation();
              const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
              const percent = (e.clientX - rect.left) / rect.width;
              seek(percent * (duration || 1));
            }}
          >
            <div
              className="h-full rounded-full bg-green-400"
              style={{ width: `${duration > 0 ? (currentTime / duration) * 100 : 0}%` }}
            />
            <div
              className="absolute top-1/2 -translate-y-1/2 w-4 h-4 md:w-5 md:h-5 rounded-full bg-white shadow-lg opacity-0 hover:opacity-100 transition-opacity"
              style={{ left: `calc(${duration > 0 ? (currentTime / duration) * 100 : 0}% - 8px)` }}
            />
          </div>
          <div className="mt-1 flex justify-between text-xs text-white/70">
            <span>{formatTime(currentTime)}</span>
            <span>{formatTime(duration)}</span>
          </div>
        </div>

        <div className="pointer-events-auto flex items-center justify-between">
          <div className="flex items-center gap-1 md:gap-2">
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); seek(Math.max(0, currentTime - 10)); }}
              className="rounded-full p-2 md:p-3 bg-white/10 hover:bg-white/30 active:bg-white/40 transition-all"
            >
              <SkipBack className="h-6 w-6 md:h-7 md:w-7 text-white" />
            </button>
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); togglePlay(); }}
              className="rounded-full bg-white/20 p-3 md:p-4 hover:bg-white/40 active:scale-95 transition-all shadow-lg"
            >
              {playing ? <Pause className="h-8 w-8 md:h-10 md:w-10 text-white" /> : <Play className="h-8 w-8 md:h-10 md:w-10 text-white" />}
            </button>
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); seek(Math.min(duration || 1, currentTime + 10)); }}
              className="rounded-full p-2 md:p-3 bg-white/10 hover:bg-white/30 active:bg-white/40 transition-all"
            >
              <SkipForward className="h-6 w-6 md:h-7 md:w-7 text-white" />
            </button>

            <div className="relative ml-1 md:ml-2">
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); setShowRateMenu(!showRateMenu); }}
                className="rounded px-2 py-1 text-xs md:text-sm font-medium hover:bg-white/10"
              >
                {rate}x
              </button>
              {showRateMenu && (
                <div className="absolute bottom-full left-0 mb-2 rounded-md bg-gray-900/95 p-1 backdrop-blur z-20">
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

          <div className="flex items-center gap-1 md:gap-2">
            {mode === 'video' && qualities.length > 1 && (
              <div className="relative">
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); setShowQualityMenu(!showQualityMenu); }}
                  className="rounded px-2 py-1 text-xs md:text-sm font-medium hover:bg-white/10"
                >
                  {qualities.find((q) => q.value === quality)?.label || '清晰度'}
                </button>
                {showQualityMenu && (
                  <div className="absolute bottom-full right-0 mb-2 rounded-md bg-gray-900/95 p-1 backdrop-blur z-20">
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
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); toggleMute(); }}
              className="rounded-full p-2 md:p-3 bg-white/10 hover:bg-white/30 active:bg-white/40 transition-all"
            >
              {muted ? <VolumeX className="h-6 w-6 md:h-7 md:w-7 text-white" /> : <Volume2 className="h-6 w-6 md:h-7 md:w-7 text-white" />}
            </button>
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); toggleFullscreen(); }}
              className="rounded-full p-2 md:p-3 bg-white/10 hover:bg-white/30 active:bg-white/40 transition-all"
            >
              {isFullscreen ? <Minimize className="h-6 w-6 md:h-7 md:w-7 text-white" /> : <Maximize className="h-6 w-6 md:h-7 md:w-7 text-white" />}
            </button>
          </div>
        </div>
      </div>

      <style>{`
        canvas { display: block; }
        video { display: block; }
      `}</style>
    </div>
  );
}
