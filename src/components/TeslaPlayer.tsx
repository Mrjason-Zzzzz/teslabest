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
  MonitorPlay,
  Cpu,
  Settings,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { setTeslaOptOut } from '@/components/TeslaAutoRedirect';
import { WebCodecsPlayer } from '@/components/webcodecs/WebCodecsPlayer';

type PlayMode = 'video' | 'canvas' | 'webcodecs';

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
  if (saved && ['video', 'canvas', 'webcodecs'].includes(saved)) return saved;
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
  const rafRef = useRef<number | null>(null);

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
    } else {
      const v = videoRef.current;
      if (v) v.currentTime = t;
      setCurrentTime(t);
    }
  }, [mode]);

  const togglePlay = useCallback(() => {
    if (mode === 'webcodecs' && wcPlayerRef.current) {
      wcPlayerRef.current.togglePlay();
    } else {
      const v = videoRef.current;
      if (!v) return;
      if (v.paused) v.play();
      else v.pause();
    }
  }, [mode]);

  const toggleFullscreen = useCallback(() => {
    if (!containerRef.current) return;
    if (!document.fullscreenElement) {
      containerRef.current.requestFullscreen().catch(() => {});
    } else {
      document.exitFullscreen().catch(() => {});
    }
  }, []);

  useEffect(() => {
    const onFullscreenChange = () => {
      setIsFullscreen(!!document.fullscreenElement);
    };
    document.addEventListener('fullscreenchange', onFullscreenChange);
    return () => {
      document.removeEventListener('fullscreenchange', onFullscreenChange);
    };
  }, []);

  const setPlaybackRate = useCallback((r: number) => {
    if (mode === 'webcodecs') {
      // WebCodecs 模式暂不支持倍速，只记状态
      setRate(r);
    } else {
      const v = videoRef.current;
      if (v) v.playbackRate = r;
      setRate(r);
    }
    setShowRateMenu(false);
  }, [mode]);

  const switchQuality = useCallback((q: string) => {
    if (!hlsRef.current) return;
    const hls = hlsRef.current;
    if (q === 'auto') hls.currentLevel = -1;
    else hls.currentLevel = parseInt(q, 10);
    setQuality(q);
    setShowQualityMenu(false);
  }, []);

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
          } else if (s === 'paused') {
            setPlaying(false);
            setBuffering(false);
          } else if (s === 'buffering') {
            setBuffering(true);
          } else if (s === 'ended') {
            setPlaying(false);
            if (playRecordKey) saveProgress(playRecordKey, duration || 0);
            setTimeout(() => onEndedCallback?.(), 500);
          }
        },
        onError: (msg) => {
          if (!destroyed) {
            setError(msg);
            setLoading(false);
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

      // Debug stats
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
        player.destroy();
        wcPlayerRef.current = null;
      };
    } catch (e: any) {
      setError('播放器初始化失败: ' + (e?.message || String(e)));
      setLoading(false);
      return () => { destroyed = true; };
    }
  }, [mode, url, wcSupported, showDebug, playRecordKey, onEndedCallback, duration, savedProgress, seekToTime]);

  // 同步 showDebug 到 wc player
  useEffect(() => {
    if (mode !== 'webcodecs') return;
    const p = wcPlayerRef.current;
    if (p) p.setShowDebug(showDebug);
  }, [mode, showDebug]);

  // ===== Video / Canvas 模式初始化 =====
  useEffect(() => {
    if (mode === 'webcodecs') return;

    let destroyed = false;
    const video = videoRef.current;
    if (!video) return;

    const onLoadedMetadata = () => {
      if (!destroyed) {
        setLoading(false);
        setDuration(video.duration || 0);
      }
    };
    const onTimeUpdate = () => {
      if (!destroyed) setCurrentTime(video.currentTime);
    };
    const onPlay = () => {
      if (!destroyed) {
        setPlaying(true);
        setLoading(false);
      }
    };
    const onPause = () => {
      if (!destroyed) setPlaying(false);
    };
    const onWaiting = () => {
      if (!destroyed) setBuffering(true);
    };
    const onPlaying = () => {
      if (destroyed) return;
      setBuffering(false);
      setLoading(false);
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

    const isM3u8 = url.toLowerCase().includes('.m3u') || url.toLowerCase().includes('/m3u8');

    const loadTimeout = window.setTimeout(() => {
      if (!destroyed) {
        setLoading(false);
      }
    }, 8000);

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
        setLoading(false);
      });

      hls.on(Hls.Events.LEVEL_LOADED, (_evt, data: any) => {
        if (destroyed) return;
        if (data?.details?.duration) {
          setDuration(data.details.duration);
        }
      });

      hls.on(Hls.Events.ERROR, (_evt, data) => {
        if (destroyed) return;
        if (data.fatal) {
          if (data.type === Hls.ErrorTypes.NETWORK_ERROR) hls.startLoad();
          else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) hls.recoverMediaError();
          else setError(`播放错误: ${data.details}`);
        }
      });

      hls.loadSource(url);
      hls.attachMedia(video);
      hlsRef.current = hls;
    } else {
      video.src = url;
      video.load();
    }

    // Canvas 模式：启动绘制循环
    if (mode === 'canvas') {
      const drawVideoFrameToCanvas = () => {
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

        if (video.readyState >= 2 && (canvas.width !== video.videoWidth || canvas.height !== video.videoHeight)) {
          canvas.width = video.videoWidth;
          canvas.height = video.videoHeight;
        }

        let drawSuccess = false;
        if (video.readyState >= 2 && video.videoWidth > 0) {
          try {
            ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
            drawSuccess = true;
          } catch (e) {
            // ignore
          }
        }

        if (!drawSuccess && showDebug) {
          ctx.fillStyle = '#000';
          ctx.fillRect(0, 0, canvas.width || 640, 120);
          ctx.fillStyle = '#0f0';
          ctx.font = '16px monospace';
          ctx.fillText(`[Debug] readyState: ${video.readyState}`, 20, 25);
          ctx.fillText(`[Debug] videoWidth: ${video.videoWidth}`, 20, 50);
          ctx.fillText(`[Debug] videoHeight: ${video.videoHeight}`, 20, 75);
          ctx.fillText(`[Debug] paused: ${video.paused}`, 20, 100);
        }

        const anyVideo = video as any;
        if (typeof anyVideo.requestVideoFrameCallback === 'function') {
          rafRef.current = anyVideo.requestVideoFrameCallback(drawVideoFrameToCanvas);
        } else {
          rafRef.current = window.requestAnimationFrame(drawVideoFrameToCanvas);
        }
      };
      rafRef.current = window.requestAnimationFrame(drawVideoFrameToCanvas);
    }

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
        const anyVideo = video as any;
        if (anyVideo && typeof anyVideo.cancelVideoFrameCallback === 'function') {
          anyVideo.cancelVideoFrameCallback(rafRef.current);
        } else {
          window.cancelAnimationFrame(rafRef.current);
        }
        rafRef.current = null;
      }
      if (hlsRef.current) {
        hlsRef.current.destroy();
        hlsRef.current = null;
      }
      clearTimeout(loadTimeout);
      video.removeAttribute('src');
      video.load();
    };
  }, [mode, url, live, playRecordKey, onEndedCallback, showDebug]);

  const modeLabel = mode === 'webcodecs' ? 'WebCodecs' : mode === 'canvas' ? 'Canvas' : 'Video';

  return (
    <div
      ref={containerRef}
      className="relative w-full h-full bg-black"
      onMouseMove={resetControlsTimer}
      onClick={togglePlay}
    >
      {/* video 元素（video/canvas 模式用，webcodecs 模式隐藏） */}
      {mode !== 'webcodecs' && (
        <video
          ref={videoRef}
          className={`absolute inset-0 h-full w-full ${mode === 'canvas' ? 'opacity-0 pointer-events-none' : ''}`}
          playsInline
          poster={poster}
        />
      )}

      {/* canvas 元素（canvas/webcodecs 模式都用） */}
      {mode !== 'video' && (
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
          <Loader2 className="h-8 w-8 animate-spin text-green-500" />
        </div>
      )}

      {/* 缓冲状态 */}
      {buffering && !loading && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <Loader2 className="h-6 w-6 animate-spin text-white/50" />
        </div>
      )}

      {/* 错误提示 */}
      {error && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/80 z-10">
          <div className="text-center px-4">
            <p className="text-red-400 text-sm">{error}</p>
            <div className="mt-3 flex gap-2 justify-center">
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); window.location.reload(); }}
                className="rounded bg-green-500 px-4 py-1.5 text-sm text-white"
              >
                重试
              </button>
              {mode === 'webcodecs' && wcSupported && (
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); switchMode('video'); }}
                  className="rounded bg-gray-600 px-4 py-1.5 text-sm text-white"
                >
                  切换 Video 模式
                </button>
              )}
            </div>
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
      <div className={`pointer-events-none absolute inset-x-0 top-0 flex items-start justify-between bg-gradient-to-b from-black/80 to-transparent p-4 transition-opacity duration-200 z-10 ${showControls ? 'opacity-100' : 'opacity-0'}`}>
        <div className="pointer-events-auto flex items-center gap-3">
          {onBackToOriginal && (
            <button
              type="button"
              onClick={backToOriginal}
              className="rounded-md bg-white/10 px-3 py-1.5 text-sm font-medium backdrop-blur hover:bg-white/20"
              title="返回原版播放器"
            >
              <RotateCcw className="inline h-4 w-4" /> 原版
            </button>
          )}
          <h1 className="text-base font-semibold drop-shadow md:text-xl max-w-[60vw] truncate">
            {title || '播放中'}
            {live && <span className="ml-2 rounded bg-red-600 px-1.5 py-0.5 text-[10px] font-bold uppercase">LIVE</span>}
          </h1>
        </div>
        <div className="pointer-events-auto flex items-center gap-2">
          {/* 模式切换 */}
          <div className="relative">
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); setShowModeMenu(!showModeMenu); }}
              className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium backdrop-blur ${
                mode === 'webcodecs'
                  ? 'bg-purple-500/30 text-purple-300 ring-1 ring-purple-400/50'
                  : mode === 'canvas'
                  ? 'bg-green-500/30 text-green-300 ring-1 ring-green-400/50'
                  : 'bg-blue-500/30 text-blue-300 ring-1 ring-blue-400/50'
              }`}
              title="播放模式"
            >
              {mode === 'webcodecs' ? <Cpu className="h-3.5 w-3.5" /> : <MonitorPlay className="h-3.5 w-3.5" />}
              {modeLabel}
            </button>
            {showModeMenu && (
              <div className="absolute top-full right-0 mt-1 rounded-md bg-gray-900/95 p-1 backdrop-blur z-20 min-w-[120px]">
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); switchMode('video'); }}
                  className={`block w-full rounded px-3 py-1.5 text-sm text-left ${mode === 'video' ? 'bg-blue-500 text-white' : 'text-gray-300 hover:bg-white/10'}`}
                >
                  Video 模式
                </button>
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); switchMode('canvas'); }}
                  className={`block w-full rounded px-3 py-1.5 text-sm text-left ${mode === 'canvas' ? 'bg-green-500 text-white' : 'text-gray-300 hover:bg-white/10'}`}
                >
                  Canvas 模式
                </button>
                {wcSupported && (
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); switchMode('webcodecs'); }}
                    className={`block w-full rounded px-3 py-1.5 text-sm text-left ${mode === 'webcodecs' ? 'bg-purple-500 text-white' : 'text-gray-300 hover:bg-white/10'}`}
                  >
                    WebCodecs 模式
                  </button>
                )}
              </div>
            )}
          </div>

          {/* 调试按钮 */}
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
      <div className={`pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/90 via-black/50 to-transparent p-4 transition-opacity duration-200 z-10 ${showControls ? 'opacity-100' : 'opacity-0'}`}>
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
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); seek(Math.max(0, currentTime - 10)); }}
              className="rounded p-1.5 hover:bg-white/10"
            >
              <SkipBack className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); togglePlay(); }}
              className="rounded-full bg-white/10 p-2 hover:bg-white/20"
            >
              {playing ? <Pause className="h-5 w-5" /> : <Play className="h-5 w-5" />}
            </button>
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); seek(Math.min(duration || 1, currentTime + 10)); }}
              className="rounded p-1.5 hover:bg-white/10"
            >
              <SkipForward className="h-4 w-4" />
            </button>
            <div className="relative ml-2">
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); setShowRateMenu(!showRateMenu); }}
                className="rounded px-2 py-1 text-xs font-medium hover:bg-white/10"
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

          <div className="flex items-center gap-2">
            {mode !== 'webcodecs' && qualities.length > 1 && (
              <div className="relative">
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); setShowQualityMenu(!showQualityMenu); }}
                  className="rounded px-2 py-1 text-xs font-medium hover:bg-white/10"
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
              onClick={(e) => { e.stopPropagation(); toggleFullscreen(); }}
              className="rounded p-1.5 hover:bg-white/10"
            >
              {isFullscreen ? <Minimize className="h-4 w-4" /> : <Maximize className="h-4 w-4" />}
            </button>
          </div>
        </div>
      </div>

      <style>{`
        canvas { display: block; }
      `}</style>
    </div>
  );
}
