'use client';

/* eslint-disable @typescript-eslint/no-explicit-any */

import {
  Gauge,
  Loader2,
  Maximize,
  Minimize,
  Pause,
  Play,
  RotateCcw,
  Settings,
  Volume2,
  VolumeX,
  Rewind,
  FastForward,
  Maximize2,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { WebCodecsPlayer, type QualityLevel } from '@/components/webcodecs/WebCodecsPlayer';

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

function formatBitrate(bps: number): string {
  if (bps <= 0) return '';
  if (bps >= 1_000_000) return (bps / 1_000_000).toFixed(1) + ' Mbps';
  if (bps >= 1_000) return (bps / 1_000).toFixed(0) + ' Kbps';
  return bps + ' bps';
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

export default function TeslaPlayer({
  url,
  title,
  poster,
  live = false,
  onBackToOriginal,
  onEnded: onEndedCallback,
  playRecordKey,
}: TeslaPlayerProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wcPlayerRef = useRef<WebCodecsPlayer | null>(null);
  const hideControlsTimerRef = useRef<number | null>(null);
  const progressSaveTimerRef = useRef<number | null>(null);
  const bufferingTimeoutRef = useRef<number | null>(null);

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
  const [showDebug, setShowDebug] = useState(false);
  const [debugInfo, setDebugInfo] = useState<any>(null);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);

  // 清晰度 / 测速
  const [qualities, setQualities] = useState<QualityLevel[]>([]);
  const [currentQuality, setCurrentQuality] = useState<QualityLevel | null>(null);
  const [bandwidthBps, setBandwidthBps] = useState(0);
  const [showQualityMenu, setShowQualityMenu] = useState(false);

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

  const seek = useCallback((t: number) => {
    wcPlayerRef.current?.seek(t);
    setCurrentTime(t);
  }, []);

  const togglePlay = useCallback(() => {
    wcPlayerRef.current?.unmute();
    wcPlayerRef.current?.togglePlay();
  }, []);

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

  const toggleWebFullscreen = useCallback(() => {
    setIsWebFullscreen((prev) => !prev);
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
    wcPlayerRef.current?.setPlaybackRate(r);
    setRate(r);
    setShowRateMenu(false);
  }, []);

  const toggleMute = useCallback(() => {
    const newMuted = !muted;
    wcPlayerRef.current?.setMuted(newMuted);
    if (!newMuted) {
      wcPlayerRef.current?.setVolume(volume);
    }
    setMuted(newMuted);
  }, [muted, volume]);

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

  const clearBufferingTimeout = useCallback(() => {
    if (bufferingTimeoutRef.current) {
      clearTimeout(bufferingTimeoutRef.current);
      bufferingTimeoutRef.current = null;
    }
  }, []);

  const startBufferingTimeout = useCallback(() => {
    clearBufferingTimeout();
    bufferingTimeoutRef.current = window.setTimeout(() => {
      console.warn('[TeslaPlayer] buffering timeout after 60s');
      setError('缓冲超时，网络可能不稳定');
      setLoading(false);
    }, 60000);
  }, [clearBufferingTimeout]);

  // ===== 播放器初始化 =====
  useEffect(() => {
    if (!canvasRef.current) return;

    let destroyed = false;
    setLoading(true);
    setError(null);
    setQualities([]);
    setCurrentQuality(null);
    setBandwidthBps(0);

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
        onLevelsChange: (levels) => {
          if (!destroyed) {
            setQualities(levels);
          }
        },
        onLevelSwitch: (level) => {
          if (!destroyed) {
            setCurrentQuality(level);
          }
        },
        onBandwidth: (bps) => {
          if (!destroyed) {
            setBandwidthBps(bps);
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
        if (showDebug && player && !destroyed) {
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
  }, [url]);

  // 同步 showDebug 到播放器
  useEffect(() => {
    wcPlayerRef.current?.setShowDebug(showDebug);
  }, [showDebug]);

  const handleSwitchQuality = useCallback((index: number) => {
    wcPlayerRef.current?.setLevel(index);
    setShowQualityMenu(false);
    // 更新当前清晰度显示
    if (index === -1) {
      setCurrentQuality(null);
    } else {
      const q = qualities.find((l) => l.index === index);
      if (q) setCurrentQuality(q);
    }
  }, [qualities]);

  // 当前清晰度标签
  const qualityLabel = useMemo(() => {
    if (qualities.length <= 1) return null;
    const cl = wcPlayerRef.current?.getCurrentLevel();
    if (cl === -1) return '自动';
    if (cl !== undefined && cl >= 0 && qualities[cl]) {
      return qualities[cl].label;
    }
    return currentQuality?.label || '自动';
  }, [qualities, currentQuality]);

  return (
    <div
      ref={containerRef}
      className={`relative w-full bg-black transition-all duration-300 ${
        isWebFullscreen
          ? 'fixed inset-0 z-[9999] h-screen w-screen rounded-none'
          : 'h-full'
      }`}
      style={isWebFullscreen ? { position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, zIndex: 9999 } : undefined}
      onMouseMove={resetControlsTimer}
      onTouchStart={resetControlsTimer}
      onClick={togglePlay}
    >
      {/* canvas 元素 — 透明覆盖层，用于调试信息 */}
      <canvas
        ref={canvasRef}
        className="absolute inset-0 h-full w-full"
        style={{ pointerEvents: 'none' }}
      />

      {/* 调试信息 */}
      {showDebug && debugInfo && (
        <div className="absolute top-2 left-2 z-20 bg-black/70 p-2 text-xs text-green-400 font-mono pointer-events-none">
          <div>state: <b>{debugInfo.state}</b></div>
          <div>bandwidth: {debugInfo.bandwidth}</div>
          <div>level: {debugInfo.level} ({debugInfo.levels} levels)</div>
          <div>buf: {debugInfo.bufferedVideoSec?.toFixed(1)}s</div>
          <div>{debugInfo.resolution}</div>
          <div>t {debugInfo.currentSec?.toFixed(1)}s</div>
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
      <div className={`pointer-events-none absolute inset-x-0 top-0 flex items-start justify-center bg-gradient-to-b from-black/60 to-transparent p-3 md:p-4 transition-opacity duration-200 z-10 ${showControls ? 'opacity-100' : 'opacity-0'}`}>
        <div className="pointer-events-auto">
          <h1 className="text-sm md:text-base font-semibold drop-shadow max-w-[70vw] md:max-w-[80vw] truncate text-center">
            {title || '播放中'}
            {live && <span className="ml-2 rounded bg-red-600 px-1.5 py-0.5 text-[10px] font-bold uppercase">LIVE</span>}
          </h1>
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
            {/* 快退 10s */}
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); seek(Math.max(0, currentTime - 10)); }}
              className="relative p-1.5 md:p-2 text-white/80 hover:text-white hover:bg-white/10 rounded transition-colors"
              title="快退10秒"
            >
              <Rewind className="h-5 w-5 md:h-5 md:w-5" />
              <span className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 text-[9px] md:text-[10px] font-bold">10</span>
            </button>

            {/* 播放/暂停 */}
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); togglePlay(); }}
              className="p-1.5 md:p-2 text-white hover:bg-white/10 rounded transition-colors"
            >
              {playing ? <Pause className="h-6 w-6 md:h-6 md:w-6" /> : <Play className="h-6 w-6 md:h-6 md:w-6" />}
            </button>

            {/* 快进 10s */}
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); seek(Math.min(duration || 1, currentTime + 10)); }}
              className="relative p-1.5 md:p-2 text-white/80 hover:text-white hover:bg-white/10 rounded transition-colors"
              title="快进10秒"
            >
              <FastForward className="h-5 w-5 md:h-5 md:w-5" />
              <span className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 text-[9px] md:text-[10px] font-bold">10</span>
            </button>

            {/* 音量 */}
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); toggleMute(); }}
              className="p-1.5 md:p-2 text-white/80 hover:text-white hover:bg-white/10 rounded transition-colors"
            >
              {muted ? <VolumeX className="h-5 w-5 md:h-5 md:w-5" /> : <Volume2 className="h-5 w-5 md:h-5 md:w-5" />}
            </button>

            {/* 时间 */}
            <div className="text-xs text-white/70 ml-1 md:ml-2">
              {formatTime(currentTime)} / {formatTime(duration)}
            </div>

            {/* 倍速 */}
            <div className="relative ml-1 md:ml-2">
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
          </div>

          <div className="flex items-center gap-0.5 md:gap-1">
            {/* 带宽测速显示 */}
            {bandwidthBps > 0 && (
              <div className="flex items-center gap-1 px-1.5 text-xs text-white/60" title="当前带宽">
                <Gauge className="h-3.5 w-3.5" />
                {formatBitrate(bandwidthBps)}
              </div>
            )}

            {/* 清晰度选择 */}
            {qualities.length > 1 && (
              <div className="relative">
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); setShowQualityMenu(!showQualityMenu); }}
                  className="flex items-center gap-1 px-2 py-1 text-xs text-white/80 hover:text-white hover:bg-white/10 rounded transition-colors"
                  title="切换清晰度"
                >
                  <Settings className="h-3.5 w-3.5" />
                  {qualityLabel}
                </button>
                {showQualityMenu && (
                  <div className="absolute bottom-full right-0 mb-1 rounded bg-black/90 backdrop-blur p-1 z-20 min-w-[100px] max-h-[250px] overflow-y-auto">
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); handleSwitchQuality(-1); }}
                      className={`block w-full rounded px-2 py-1 text-xs text-left ${wcPlayerRef.current?.getCurrentLevel() === -1 || wcPlayerRef.current?.getCurrentLevel() === undefined ? 'bg-green-500 text-white' : 'text-gray-300 hover:bg-white/10'}`}
                    >
                      自动
                    </button>
                    {qualities.map((q) => (
                      <button
                        key={q.index}
                        type="button"
                        onClick={(e) => { e.stopPropagation(); handleSwitchQuality(q.index); }}
                        className={`block w-full rounded px-2 py-1 text-xs text-left ${wcPlayerRef.current?.getCurrentLevel() === q.index ? 'bg-green-500 text-white' : 'text-gray-300 hover:bg-white/10'}`}
                      >
                        <span>{q.label}</span>
                        {q.bitrate > 0 && (
                          <span className="ml-2 text-white/40">{formatBitrate(q.bitrate)}</span>
                        )}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* 返回原版 */}
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

            {/* 网页全屏 */}
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); toggleWebFullscreen(); }}
              className="p-1.5 md:p-2 text-white/80 hover:text-white hover:bg-white/10 rounded transition-colors"
              title={isWebFullscreen ? '退出网页全屏' : '网页全屏'}
            >
              <Maximize2 className="h-5 w-5 md:h-5 md:w-5" />
            </button>

            {/* 全屏 */}
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); toggleFullscreen(); }}
              className="p-1.5 md:p-2 text-white/80 hover:text-white hover:bg-white/10 rounded transition-colors"
              title={isFullscreen ? '退出全屏' : '全屏'}
            >
              {isFullscreen ? <Minimize className="h-5 w-5 md:h-5 md:w-5" /> : <Maximize className="h-5 w-5 md:h-5 md:w-5" />}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}