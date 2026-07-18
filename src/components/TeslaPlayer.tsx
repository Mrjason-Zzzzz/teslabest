'use client';

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * TeslaPlayer
 *
 * 基于 Broadway.js + YUVCanvas 的纯 Canvas 渲染播放器组件。
 * 不依赖 <video> 元素，绕开特斯拉车机行驶中限制。
 *
 * 内置一套最简控制条 UI（播放/暂停、进度、时间、倍速、全屏、回原版），
 * 风格与现有 Artplayer 控制条保持一致（深色、底部条）。
 *
 * 接受 props：
 *   - url: m3u8 播放地址（已经过代理）
 *   - title: 标题
 *   - poster: 海报
 *   - live: 是否直播
 *   - onBackToOriginal: 回原版按钮回调
 */

import { Loader2, Maximize, Minimize, Pause, Play, RotateCcw } from 'lucide-react';
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
  const canvasHostRef = useRef<HTMLDivElement | null>(null);
  const engineRef = useRef<HlsBroadwayEngine | null>(null);
  const scriptsLoadedRef = useRef(false);

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
  const hideControlsTimerRef = useRef<number | null>(null);

  // 注入 Broadway.js 全局脚本（Decoder + YUVCanvas + Player）
  const ensureBroadwayScripts = useCallback(async () => {
    if (scriptsLoadedRef.current) return;
    if (typeof window === 'undefined') return;
    // Broadway 的 Decoder.js 是 Node 打包产物，会引用 `global` 变量，
    // 浏览器没有该全局，需在脚本执行前 polyfill 为 window，否则抛 ReferenceError。
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
        s.async = false; // 严格按顺序加载，避免依赖顺序问题
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

    // 验证全局变量挂载成功
    if (!window.Player || !window.YUVCanvas || !window.Decoder) {
      throw new Error(
        `Broadway 脚本加载后全局变量缺失: Player=${!!window.Player} YUVCanvas=${!!window.YUVCanvas} Decoder=${!!window.Decoder}`
      );
    }
    // eslint-disable-next-line no-console
    console.log('[TeslaPlayer] broadway scripts ready', {
      Player: typeof window.Player,
      YUVCanvas: typeof window.YUVCanvas,
      Decoder: typeof window.Decoder,
    });
    scriptsLoadedRef.current = true;
  }, []);

  // 创建/销毁引擎
  useEffect(() => {
    if (!url) return;
    let disposed = false;

    const start = async () => {
      try {
        setLoading(true);
        setError(null);
        await ensureBroadwayScripts();
        if (disposed) return;

        // 准备 canvas host：清空旧 canvas
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
          debug: false,
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
          const msg = err?.details || '播放出错';
          setError(`${msg}${err?.type ? `（${err.type}）` : ''}`);
          setLoading(false);
        });

        await engine.load();
        if (disposed) return;

        // 把 player.canvas 移到 host 中
        const canvas = engine.getCanvas();
        if (canvas && canvasHostRef.current) {
          // 防止重复 append
          if (canvas.parentElement !== canvasHostRef.current) {
            if (canvas.parentElement) {
              canvas.parentElement.removeChild(canvas);
            }
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
        setError(e?.message || '播放器初始化失败');
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
  }, [url, live, ensureBroadwayScripts]);

  // 控制条自动隐藏
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

  // 全屏切换
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

  // 切回原版：先标记 opt-out，避免 TeslaAutoRedirect 立即跳回来
  const handleBackToOriginal = useCallback(() => {
    setTeslaOptOut();
    onBackToOriginal?.();
  }, [onBackToOriginal]);

  useEffect(() => {
    const handler = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', handler);
    document.addEventListener('webkitfullscreenchange', handler);
    return () => {
      document.removeEventListener('fullscreenchange', handler);
      document.removeEventListener('webkitfullscreenchange', handler);
    };
  }, []);

  // 播放/暂停
  const togglePlay = useCallback(() => {
    const e = engineRef.current;
    if (!e) return;
    if (e.getPaused()) {
      void e.play();
    } else {
      e.pause();
    }
  }, []);

  // Seek
  const seek = useCallback(
    (t: number) => {
      const e = engineRef.current;
      if (!e) return;
      e.seek(t);
      setCurrentTime(t);
    },
    []
  );

  // 倍速
  const setPlaybackRate = useCallback((r: number) => {
    const e = engineRef.current;
    if (!e) return;
    e.setPlaybackRate(r);
    setRate(r);
    setShowRateMenu(false);
  }, []);

  // 进度条点击/拖动
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

  // 键盘控制
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // 避免输入框中触发
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
        // 点击容器但未点击控制条时，切换播放
        if ((e.target as HTMLElement).dataset?.role === 'stage') {
          togglePlay();
        }
      }}
    >
      {/* Canvas 渲染层 */}
      <div
        ref={canvasHostRef}
        data-role="stage"
        className="absolute inset-0 flex items-center justify-center bg-black"
      />

      {/* 海报（首次加载时显示） */}
      {loading && poster && (
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
            <span className="ml-2 rounded bg-rose-600/80 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider">
              Tesla Canvas
            </span>
            {live && (
              <span className="ml-2 rounded bg-red-600 px-1.5 py-0.5 text-[10px] font-bold uppercase">
                LIVE
              </span>
            )}
          </h1>
        </div>
      </div>

      {/* 中间加载/错误 */}
      <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
        {loading && (
          <div className="flex items-center gap-3 rounded-2xl border border-white/10 bg-black/60 px-6 py-3 text-base backdrop-blur">
            <Loader2 className="h-5 w-5 animate-spin" />
            <span>正在加载 Broadway 解码器…</span>
          </div>
        )}
        {error && (
          <div className="pointer-events-auto mx-6 max-w-md rounded-2xl border border-red-500/40 bg-red-950/80 px-6 py-4 text-center text-sm backdrop-blur">
            <p className="font-semibold text-red-200">播放失败</p>
            <p className="mt-1 text-red-100/80">{error}</p>
            <div className="mt-3 flex justify-center gap-2">
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
