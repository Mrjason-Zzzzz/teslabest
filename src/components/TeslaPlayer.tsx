'use client';

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * TeslaPlayer
 *
 * 双模式播放器组件：
 *   1. video 模式（默认）：使用 <video> + hls.js，全平台兼容、有音频、支持所有 H.264/H.265 profile。
 *   2. canvas 模式（可选）：使用 Broadway.js + Canvas 软解，不依赖 <video> 元素，
 *      适用于特斯拉行驶中 <video> 被禁用的场景。
 *
 * 用户可通过右上角按钮在两种模式间切换。
 */

import Hls from 'hls.js';
import { Loader2, Maximize, Minimize, Monitor, Pause, Play, RotateCcw, Tv } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { HlsBroadwayEngine } from '@/lib/tesla-player/hls-broadway-engine';
import { setTeslaOptOut } from '@/components/TeslaAutoRedirect';

interface TeslaPlayerProps {
  url: string;
  title?: string;
  poster?: string;
  live?: boolean;
  onBackToOriginal?: () => void;
}

const PLAYBACK_RATES = [0.5, 0.75, 1, 1.25, 1.5, 2, 3];

type PlayerMode = 'video' | 'canvas';

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const ms = Math.floor((seconds - Math.floor(seconds)) * 1000) / 1000;
  const hh = h > 0 ? `${h}:` : '';
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m);
  const ss = String(s).padStart(2, '0');
  return `${hh}${mm}:${ss}${ms > 0 ? `.${String(ms).split('.')[1].slice(0, 1)}` : ''}`;
}

export default function TeslaPlayer({
  url,
  title,
  poster,
  live = false,
  onBackToOriginal,
}: TeslaPlayerProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasHostRef = useRef<HTMLDivElement | null>(null);
  const engineRef = useRef<HlsBroadwayEngine | null>(null);
  const hlsRef = useRef<Hls | null>(null);
  const scriptsLoadedRef = useRef(false);
  const hideControlsTimerRef = useRef<number | null>(null);

  const [mode, setMode] = useState<PlayerMode>('video');
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

  // ============ Video 模式（hls.js + <video>） ============
  useEffect(() => {
    if (mode !== 'video' || !url) return;
    const video = videoRef.current;
    if (!video) return;

    setLoading(true);
    setError(null);
    setPlaying(false);
    setCurrentTime(0);
    setDuration(0);

    let destroyed = false;

    // 清理上一次的 hls 实例
    if (hlsRef.current) {
      hlsRef.current.destroy();
      hlsRef.current = null;
    }

    const onLoadedMetadata = () => {
      if (destroyed) return;
      setLoading(false);
      setDuration(video.duration || 0);
    };
    const onTimeUpdate = () => {
      if (destroyed) return;
      setCurrentTime(video.currentTime);
    };
    const onPlay = () => {
      if (destroyed) return;
      setPlaying(true);
      setLoading(false);
    };
    const onPause = () => {
      if (destroyed) return;
      setPlaying(false);
    };
    const onWaiting = () => {
      if (destroyed) return;
      setBuffering(true);
    };
    const onPlayingEvt = () => {
      if (destroyed) return;
      setBuffering(false);
      setLoading(false);
    };
    const onEnded = () => {
      if (destroyed) return;
      setPlaying(false);
    };
    const onError = () => {
      if (destroyed) return;
      const mediaError = video.error;
      if (mediaError) {
        setError(`视频错误 (code ${mediaError.code})`);
      }
      setLoading(false);
    };

    video.addEventListener('loadedmetadata', onLoadedMetadata);
    video.addEventListener('timeupdate', onTimeUpdate);
    video.addEventListener('play', onPlay);
    video.addEventListener('pause', onPause);
    video.addEventListener('waiting', onWaiting);
    video.addEventListener('playing', onPlayingEvt);
    video.addEventListener('ended', onEnded);
    video.addEventListener('error', onError);

    // 优先使用原生 HLS 支持（Safari/iOS/Tesla MCU3 可能支持）
    if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = url;
      video.play().catch(() => undefined);
    } else if (Hls.isSupported()) {
      const hls = new Hls({
        enableWorker: true,
        lowLatencyMode: live,
        backBufferLength: 90,
      });
      hlsRef.current = hls;
      hls.loadSource(url);
      hls.attachMedia(video);
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        if (destroyed) return;
        video.play().catch(() => undefined);
      });
      hls.on(Hls.Events.ERROR, (_evt, data) => {
        if (destroyed) return;
        if (data.fatal) {
          switch (data.type) {
            case Hls.ErrorTypes.NETWORK_ERROR:
              hls.startLoad();
              break;
            case Hls.ErrorTypes.MEDIA_ERROR:
              hls.recoverMediaError();
              break;
            default:
              setError(`HLS 错误: ${data.details}`);
              setLoading(false);
              hls.destroy();
              hlsRef.current = null;
              break;
          }
        }
      });
    } else {
      setError('当前浏览器不支持 HLS 播放，可尝试切换到 Canvas 模式');
      setLoading(false);
    }

    return () => {
      destroyed = true;
      video.removeEventListener('loadedmetadata', onLoadedMetadata);
      video.removeEventListener('timeupdate', onTimeUpdate);
      video.removeEventListener('play', onPlay);
      video.removeEventListener('pause', onPause);
      video.removeEventListener('waiting', onWaiting);
      video.removeEventListener('playing', onPlayingEvt);
      video.removeEventListener('ended', onEnded);
      video.removeEventListener('error', onError);
      if (hlsRef.current) {
        hlsRef.current.destroy();
        hlsRef.current = null;
      }
      video.removeAttribute('src');
      video.load();
    };
  }, [mode, url, live]);

  // ============ Canvas 模式（Broadway.js + Canvas 软解） ============
  const ensureBroadwayScripts = useCallback(async () => {
    if (scriptsLoadedRef.current) return;
    if (typeof window === 'undefined') return;
    // Broadway 的 Decoder.js 是 Node 打包产物，引用了 `global` 变量
    if (!(window as any).global) {
      (window as any).global = window;
    }
    const loadScript = (src: string) =>
      new Promise<void>((resolve, reject) => {
        const existing = document.querySelector<HTMLScriptElement>(
          `script[src="${src}"]`
        );
        if (existing) {
          resolve();
          return;
        }
        const s = document.createElement('script');
        s.src = src;
        s.async = false;
        s.onload = () => {
          // eslint-disable-next-line no-console
          console.log(`[TeslaPlayer] script loaded: ${src}`);
          resolve();
        };
        s.onerror = () => reject(new Error(`加载脚本失败: ${src}`));
        document.head.appendChild(s);
      });
    // eslint-disable-next-line no-console
    console.log('[TeslaPlayer] loading broadway scripts...');
    await loadScript('/assets/broadway/Decoder.js');
    await loadScript('/assets/broadway/YUVCanvas.js');
    await loadScript('/assets/broadway/Player.js');

    if (!window.Player || !window.YUVCanvas || !window.Decoder) {
      throw new Error(
        `Broadway 脚本加载后全局变量缺失: Player=${!!window.Player} YUVCanvas=${!!window.YUVCanvas} Decoder=${!!window.Decoder}`
      );
    }
    scriptsLoadedRef.current = true;
  }, []);

  useEffect(() => {
    if (mode !== 'canvas' || !url) return;
    let disposed = false;

    const start = async () => {
      try {
        setLoading(true);
        setError(null);
        await ensureBroadwayScripts();
        if (disposed) return;

        if (canvasHostRef.current) {
          canvasHostRef.current.innerHTML = '';
        }

        const engine = new HlsBroadwayEngine({
          url,
          live,
          autoplay: true,
          useWorker: true,
          webgl: 'auto',
          size: { width: 1280, height: 720 },
          debug: true,
        });
        engineRef.current = engine;

        engine.on('manifestParsed', () => {
          if (disposed) return;
          setLoading(false);
          setDuration(engine.getDuration());
        });
        engine.on('durationchange', (d: number) => {
          if (disposed) return;
          setDuration(d);
        });
        engine.on('playing', () => {
          if (disposed) return;
          setPlaying(true);
          setLoading(false);
        });
        engine.on('pause', () => {
          if (disposed) return;
          setPlaying(false);
        });
        engine.on('buffering', (b: boolean) => {
          if (disposed) return;
          setBuffering(b);
        });
        engine.on('timeupdate', (t: number) => {
          if (disposed) return;
          setCurrentTime(t);
        });
        engine.on('ended', () => {
          if (disposed) return;
          setPlaying(false);
        });
        engine.on('error', (err: any) => {
          if (disposed) return;
          setError(`${err?.details || '播放出错'}${err?.type ? `（${err.type}）` : ''}`);
          setLoading(false);
        });

        await engine.load();
        if (disposed) return;

        const canvas = engine.getCanvas();
        if (canvas && canvasHostRef.current) {
          if (canvas.parentElement !== canvasHostRef.current) {
            if (canvas.parentElement) canvas.parentElement.removeChild(canvas);
            canvasHostRef.current.appendChild(canvas);
          }
          canvas.style.width = '100%';
          canvas.style.height = '100%';
          canvas.style.objectFit = 'contain';
          canvas.style.background = '#000';
          canvas.style.display = 'block';
        }
      } catch (e: any) {
        if (disposed) return;
        setError(e?.message || 'Canvas 播放器初始化失败，可切换回视频模式');
        setLoading(false);
      }
    };

    start();

    return () => {
      disposed = true;
      try {
        engineRef.current?.destroy();
      } catch {
        // ignore
      }
      engineRef.current = null;
    };
  }, [mode, url, live, ensureBroadwayScripts]);

  // ============ 模式切换 ============
  const switchMode = useCallback((newMode: PlayerMode) => {
    // 清理当前模式
    if (hlsRef.current) {
      hlsRef.current.destroy();
      hlsRef.current = null;
    }
    if (engineRef.current) {
      try {
        engineRef.current.destroy();
      } catch {
        // ignore
      }
      engineRef.current = null;
    }
    if (videoRef.current) {
      videoRef.current.removeAttribute('src');
      videoRef.current.load();
    }
    if (canvasHostRef.current) {
      canvasHostRef.current.innerHTML = '';
    }
    setMode(newMode);
    setLoading(true);
    setError(null);
    setPlaying(false);
    setCurrentTime(0);
    setDuration(0);
  }, []);

  // ============ 控制条自动隐藏 ============
  const showControlsTemporarily = useCallback(() => {
    setShowControls(true);
    if (hideControlsTimerRef.current) {
      window.clearTimeout(hideControlsTimerRef.current);
    }
    if (playing) {
      hideControlsTimerRef.current = window.setTimeout(() => {
        setShowControls(false);
        setShowRateMenu(false);
      }, 3000);
    }
  }, [playing]);

  useEffect(() => {
    showControlsTemporarily();
    return () => {
      if (hideControlsTimerRef.current) {
        window.clearTimeout(hideControlsTimerRef.current);
      }
    };
  }, [showControlsTemporarily]);

  // ============ 全屏 ============
  const toggleFullscreen = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    if (!document.fullscreenElement) {
      el.requestFullscreen?.().catch(() => undefined);
      (el as any).webkitRequestFullscreen?.();
    } else {
      document.exitFullscreen?.().catch(() => undefined);
      (document as any).webkitExitFullscreen?.();
    }
  }, []);

  useEffect(() => {
    const handler = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', handler);
    document.addEventListener('webkitfullscreenchange', handler);
    return () => {
      document.removeEventListener('fullscreenchange', handler);
      document.removeEventListener('webkitfullscreenchange', handler);
    };
  }, []);

  // ============ 播放/暂停 ============
  const togglePlay = useCallback(() => {
    if (mode === 'video') {
      const video = videoRef.current;
      if (!video) return;
      if (video.paused) {
        video.play().catch(() => undefined);
      } else {
        video.pause();
      }
    } else {
      const engine = engineRef.current;
      if (!engine) return;
      if (engine.getPaused()) {
        void engine.play();
      } else {
        engine.pause();
      }
    }
  }, [mode]);

  // ============ Seek ============
  const seek = useCallback(
    (t: number) => {
      if (mode === 'video') {
        const video = videoRef.current;
        if (video) video.currentTime = t;
      } else {
        const engine = engineRef.current;
        if (engine) engine.seek(t);
      }
      setCurrentTime(t);
    },
    [mode]
  );

  // ============ 倍速 ============
  const setPlaybackRate = useCallback(
    (r: number) => {
      if (mode === 'video') {
        const video = videoRef.current;
        if (video) video.playbackRate = r;
      } else {
        const engine = engineRef.current;
        if (engine) engine.setPlaybackRate(r);
      }
      setRate(r);
      setShowRateMenu(false);
    },
    [mode]
  );

  // ============ 进度条交互 ============
  const onProgressInteraction = useCallback(
    (e: React.MouseEvent<HTMLDivElement> | React.TouchEvent<HTMLDivElement>) => {
      const bar = e.currentTarget;
      const rect = bar.getBoundingClientRect();
      const clientX =
        'touches' in e
          ? e.touches[0]?.clientX ?? rect.left
          : (e as React.MouseEvent<HTMLDivElement>).clientX;
      const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
      if (duration !== Infinity && duration > 0) {
        seek(ratio * duration);
      }
    },
    [duration, seek]
  );

  // ============ 键盘控制 ============
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;
      switch (e.key) {
        case ' ':
        case 'k':
          e.preventDefault();
          togglePlay();
          break;
        case 'ArrowLeft':
          seek(Math.max(0, currentTime - 10));
          break;
        case 'ArrowRight':
          seek(Math.min(duration, currentTime + 10));
          break;
        case 'f':
          toggleFullscreen();
          break;
        default:
          break;
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [currentTime, duration, togglePlay, toggleFullscreen, seek]);

  // ============ 回原版 ============
  const handleBackToOriginal = useCallback(() => {
    setTeslaOptOut();
    onBackToOriginal?.();
  }, [onBackToOriginal]);

  const progressPercent = useMemo(() => {
    if (duration === Infinity || duration <= 0) return 0;
    return Math.min(100, (currentTime / duration) * 100);
  }, [currentTime, duration]);

  return (
    <div
      ref={containerRef}
      className="relative h-full w-full overflow-hidden bg-black text-white"
      onMouseMove={showControlsTemporarily}
      onTouchStart={showControlsTemporarily}
      onClick={(e) => {
        if ((e.target as HTMLElement).dataset?.role === 'stage') {
          togglePlay();
        }
      }}
    >
      {/* Video 元素（video 模式） */}
      {mode === 'video' && (
        <video
          ref={videoRef}
          data-role="stage"
          className="absolute inset-0 h-full w-full bg-black"
          style={{ objectFit: 'contain' }}
          playsInline
          autoPlay
          poster={poster}
        />
      )}

      {/* Canvas 渲染层（canvas 模式） */}
      <div
        ref={canvasHostRef}
        data-role="stage"
        className={`absolute inset-0 flex items-center justify-center bg-black ${mode === 'canvas' ? '' : 'hidden'}`}
      />

      {/* 海报（首次加载时显示） */}
      {loading && poster && mode === 'canvas' && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={poster}
          alt={title || ''}
          className="pointer-events-none absolute inset-0 h-full w-full object-contain opacity-40"
        />
      )}

      {/* 顶部条 */}
      <div
        className={`pointer-events-none absolute inset-x-0 top-0 flex items-start justify-between bg-gradient-to-b from-black/80 to-transparent p-4 transition-opacity duration-200 ${
          showControls ? 'opacity-100' : 'opacity-0'
        }`}
      >
        <div className="pointer-events-auto flex items-center gap-3">
          {onBackToOriginal && (
            <button
              type="button"
              onClick={handleBackToOriginal}
              className="rounded-md bg-white/10 px-3 py-1.5 text-sm font-medium backdrop-blur hover:bg-white/20"
              title="返回原版播放器"
            >
              <RotateCcw className="inline h-4 w-4" /> 原版
            </button>
          )}
          <h1 className="text-base font-semibold drop-shadow md:text-xl">
            {title || '播放中'}
            <span
              className={`ml-2 rounded px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider ${
                mode === 'canvas' ? 'bg-rose-600/80' : 'bg-blue-600/80'
              }`}
            >
              {mode === 'canvas' ? 'Canvas' : 'Video'}
            </span>
            {live && (
              <span className="ml-2 rounded bg-red-600 px-1.5 py-0.5 text-[10px] font-bold uppercase">
                LIVE
              </span>
            )}
          </h1>
        </div>

        {/* 模式切换按钮 */}
        <div className="pointer-events-auto">
          <button
            type="button"
            onClick={() => switchMode(mode === 'video' ? 'canvas' : 'video')}
            className="flex items-center gap-1.5 rounded-md bg-white/10 px-3 py-1.5 text-sm font-medium backdrop-blur hover:bg-white/20"
            title={mode === 'video' ? '切换到 Canvas 软解模式（无需 <video>）' : '切换到视频模式（有音频）'}
          >
            {mode === 'video' ? (
              <>
                <Tv className="h-4 w-4" /> Canvas
              </>
            ) : (
              <>
                <Monitor className="h-4 w-4" /> 视频
              </>
            )}
          </button>
        </div>
      </div>

      {/* 中间加载/错误 */}
      <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
        {loading && (
          <div className="flex items-center gap-3 rounded-2xl border border-white/10 bg-black/60 px-6 py-3 text-base backdrop-blur">
            <Loader2 className="h-5 w-5 animate-spin" />
            <span>
              {mode === 'canvas' ? '正在加载 Broadway 解码器…' : '正在加载视频…'}
            </span>
          </div>
        )}
        {error && (
          <div className="pointer-events-auto mx-6 max-w-md rounded-2xl border border-red-500/40 bg-red-950/80 px-6 py-4 text-center text-sm backdrop-blur">
            <p className="font-semibold text-red-200">播放失败</p>
            <p className="mt-1 text-red-100/80">{error}</p>
            <div className="mt-3 flex justify-center gap-2">
              <button
                type="button"
                onClick={() => switchMode(mode === 'video' ? 'canvas' : 'video')}
                className="rounded bg-white/10 px-3 py-1 hover:bg-white/20"
              >
                切换到{mode === 'video' ? 'Canvas' : '视频'}模式
              </button>
              <button
                type="button"
                onClick={() => window.location.reload()}
                className="rounded bg-white/10 px-3 py-1 hover:bg-white/20"
              >
                重试
              </button>
              {onBackToOriginal && (
                <button
                  type="button"
                  onClick={handleBackToOriginal}
                  className="rounded bg-white/10 px-3 py-1 hover:bg-white/20"
                >
                  切回原版
                </button>
              )}
            </div>
          </div>
        )}
        {buffering && !loading && !error && (
          <div className="flex items-center gap-2 text-sm text-white/70">
            <Loader2 className="h-4 w-4 animate-spin" /> 缓冲中…
          </div>
        )}
      </div>

      {/* 底部控制条 */}
      <div
        className={`absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/90 to-transparent px-4 pb-3 pt-12 transition-opacity duration-200 ${
          showControls ? 'opacity-100' : 'opacity-0'
        }`}
      >
        {/* 进度条 */}
        <div
          className="group relative h-1.5 w-full cursor-pointer rounded-full bg-white/20"
          onClick={onProgressInteraction}
          onTouchStart={onProgressInteraction}
        >
          <div
            className="absolute left-0 top-0 h-full rounded-full bg-rose-500"
            style={{ width: `${progressPercent}%` }}
          />
          <div
            className="absolute top-1/2 h-3 w-3 -translate-y-1/2 rounded-full bg-white shadow opacity-0 transition-opacity group-hover:opacity-100"
            style={{ left: `calc(${progressPercent}% - 6px)` }}
          />
        </div>

        {/* 按钮行 */}
        <div className="mt-2 flex items-center justify-between text-sm">
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={togglePlay}
              className="rounded p-1 hover:bg-white/10"
              aria-label={playing ? '暂停' : '播放'}
            >
              {playing ? (
                <Pause className="h-5 w-5" />
              ) : (
                <Play className="h-5 w-5 fill-current" />
              )}
            </button>
            <div className="relative">
              <button
                type="button"
                onClick={() => setShowRateMenu((v) => !v)}
                className="rounded px-2 py-1 hover:bg-white/10"
                aria-label="倍速"
              >
                {rate}x
              </button>
              {showRateMenu && (
                <div className="absolute bottom-full left-0 mb-2 w-24 rounded-lg border border-white/10 bg-black/90 py-1 backdrop-blur">
                  {PLAYBACK_RATES.map((r) => (
                    <button
                      key={r}
                      type="button"
                      onClick={() => setPlaybackRate(r)}
                      className={`block w-full px-3 py-1 text-left hover:bg-white/10 ${
                        r === rate ? 'text-rose-400' : ''
                      }`}
                    >
                      {r}x
                    </button>
                  ))}
                </div>
              )}
            </div>
            <span className="tabular-nums text-white/80">
              {formatTime(currentTime)}
              {duration !== Infinity && duration > 0 && (
                <> / {formatTime(duration)}</>
              )}
            </span>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={toggleFullscreen}
              className="rounded p-1 hover:bg-white/10"
              aria-label={isFullscreen ? '退出全屏' : '全屏'}
            >
              {isFullscreen ? (
                <Minimize className="h-5 w-5" />
              ) : (
                <Maximize className="h-5 w-5" />
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
