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

/**
 * 广告过滤：从 m3u8 内容中移除广告分片
 * 参考 TVNativeVideo.tsx 的实现，过滤包含广告关键字的 EXTINF 分片
 */
function filterAdsFromM3U8(m3u8Content: string): string {
  if (!m3u8Content) return '';
  const adKeywords = ['sponsor', '/ad/', '/ads/', 'advert', 'advertisement', '/adjump', 'redtraffic'];
  const lines = m3u8Content.split('\n');
  const filteredLines: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // 跳过 #EXT-X-DISCONTINUITY 标识（广告段常用）
    if (line.includes('#EXT-X-DISCONTINUITY')) {
      i++;
      continue;
    }

    // 如果是 EXTINF 行，检查下一行 URL 是否包含广告关键字
    if (line.includes('#EXTINF:') && i + 1 < lines.length) {
      const nextLine = lines[i + 1];
      const isAd = adKeywords.some((keyword) => nextLine.toLowerCase().includes(keyword));
      if (isAd) {
        // 跳过 EXTINF 行和 URL 行
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
  const canvasModeDetectedRef = useRef(false);

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
  const [canvasMode, setCanvasMode] = useState(false);

  const savedProgress = useMemo(() => {
    if (!playRecordKey) return 0;
    return getSavedProgress(playRecordKey);
  }, [playRecordKey]);

  const seek = useCallback((t: number) => {
    const v = videoRef.current;
    if (v) v.currentTime = t;
    setCurrentTime(t);
  }, []);

  // ===== Canvas 帧绘制循环（特斯拉行驶中 video 画面被禁用时使用）=====
  const drawVideoFrameToCanvas = useCallback(() => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas) return;

    // video.readyState >= 2 (HAVE_CURRENT_DATA) 表示有帧数据
    if (video.readyState >= 2 && video.videoWidth > 0) {
      // 如果 canvas 尺寸不匹配 video，重新设置
      if (canvas.width !== video.videoWidth || canvas.height !== video.videoHeight) {
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
      }
      const ctx = canvas.getContext('2d');
      if (ctx) {
        try {
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        } catch (e) {
          // drawImage 可能因为 CORS 或其他原因失败，忽略
        }
      }
    }

    // 使用 requestVideoFrameCallback（如果支持）或 requestAnimationFrame
    const anyVideo = video as any;
    if (typeof anyVideo.requestVideoFrameCallback === 'function') {
      rafRef.current = anyVideo.requestVideoFrameCallback(drawVideoFrameToCanvas);
    } else {
      rafRef.current = window.requestAnimationFrame(drawVideoFrameToCanvas);
    }
  }, []);

  // 启用/关闭 Canvas 模式
  const enableCanvasMode = useCallback(() => {
    if (canvasModeDetectedRef.current) return;
    canvasModeDetectedRef.current = true;
    setCanvasMode(true);
    console.log('[TeslaPlayer] 检测到视频画面无法显示，已自动启用 Canvas 渲染模式');
    // 启动帧绘制循环
    setTimeout(() => drawVideoFrameToCanvas(), 100);
  }, [drawVideoFrameToCanvas]);

  const disableCanvasMode = useCallback(() => {
    setCanvasMode(false);
    canvasModeDetectedRef.current = false;
    if (rafRef.current !== null) {
      const anyVideo = videoRef.current as any;
      if (anyVideo && typeof anyVideo.cancelVideoFrameCallback === 'function') {
        anyVideo.cancelVideoFrameCallback(rafRef.current);
      } else {
        window.cancelAnimationFrame(rafRef.current);
      }
      rafRef.current = null;
    }
  }, []);

  // 手动切换 Canvas 模式（用户主动点击）
  const toggleCanvasMode = useCallback(() => {
    if (canvasMode) {
      disableCanvasMode();
    } else {
      canvasModeDetectedRef.current = true;
      setCanvasMode(true);
      setTimeout(() => drawVideoFrameToCanvas(), 100);
      console.log('[TeslaPlayer] 手动启用 Canvas 渲染模式');
    }
  }, [canvasMode, disableCanvasMode, drawVideoFrameToCanvas]);

  useEffect(() => {
    if (savedProgress > 0 && duration > 0 && seekToTime === null) {
      const progressRatio = savedProgress / duration;
      if (progressRatio < 0.95) {
        seek(savedProgress);
        setSeekToTime(savedProgress);
      }
    }
  }, [savedProgress, duration, seekToTime, seek]);

  useEffect(() => {
    if (progressSaveTimerRef.current) clearInterval(progressSaveTimerRef.current);
    if (playing && playRecordKey) {
      progressSaveTimerRef.current = window.setInterval(() => {
        saveProgress(playRecordKey, currentTime);
      }, PROGRESS_SAVE_INTERVAL);
    }
    return () => {
      if (progressSaveTimerRef.current) clearInterval(progressSaveTimerRef.current);
      if (playRecordKey) saveProgress(playRecordKey, currentTime);
    };
  }, [playing, playRecordKey, currentTime]);

  // ===== Video 模式（统一使用 hls.js + 广告过滤）=====
  useEffect(() => {
    if (!url) return;
    const video = videoRef.current;
    if (!video) return;

    setLoading(true);
    setError(null);
    setPlaying(false);
    setCurrentTime(0);
    setDuration(0);
    setQualities([]);

    let destroyed = false;

    if (hlsRef.current) {
      hlsRef.current.destroy();
      hlsRef.current = null;
    }

    const onLoadedMetadata = () => { if (!destroyed) { setLoading(false); setDuration(video.duration || 0); } };
    const onTimeUpdate = () => { if (!destroyed) setCurrentTime(video.currentTime); };
    const onPlay = () => { if (!destroyed) { setPlaying(true); setLoading(false); } };
    const onPause = () => { if (!destroyed) setPlaying(false); };
    const onWaiting = () => { if (!destroyed) setBuffering(true); };
    const onPlaying = () => {
      if (destroyed) return;
      setBuffering(false);
      setLoading(false);
      // 特斯拉行驶中场景检测：
      // video 在播放（有声音），但 videoWidth 为 0 或 readyState 异常，说明画面被系统禁用
      // 此时自动启用 Canvas 模式，用 drawImage 把帧绘制到 canvas 显示
      if (!canvasModeDetectedRef.current && video.videoWidth === 0) {
        console.warn('[TeslaPlayer] 检测到 video.videoWidth === 0，可能是特斯拉行驶中场景');
        enableCanvasMode();
      }
    };
    const onLoadedData = () => {
      if (destroyed) return;
      // loadeddata 事件时如果 videoWidth 为 0，说明画面确实无法渲染
      if (!canvasModeDetectedRef.current && video.videoWidth === 0 && video.readyState >= 2) {
        console.warn('[TeslaPlayer] loadeddata 时 videoWidth === 0，启用 Canvas 模式');
        enableCanvasMode();
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
    video.addEventListener('loadeddata', onLoadedData);
    video.addEventListener('timeupdate', onTimeUpdate);
    video.addEventListener('play', onPlay);
    video.addEventListener('pause', onPause);
    video.addEventListener('waiting', onWaiting);
    video.addEventListener('playing', onPlaying);
    video.addEventListener('ended', onEnded);
    video.addEventListener('error', onError);

    // 判断是否为 m3u8
    const isM3u8 = url.toLowerCase().includes('.m3u') || url.toLowerCase().includes('/m3u8');

    if (isM3u8 && Hls.isSupported()) {
      // 自定义 loader：拦截 m3u8 响应做广告过滤
      const AdFilterLoader = class extends Hls.DefaultConfig.loader {
        constructor(config: any) {
          super(config);
          const load = this.load.bind(this);
          this.load = (context: any, cfg: any, callbacks: any) => {
            // 仅对 manifest/level 类型的请求（即 m3u8 文件）做过滤
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
        maxBufferLength: live ? 18 : 45,
        loader: AdFilterLoader,
      });
      hlsRef.current = hls;
      hls.loadSource(url);
      hls.attachMedia(video);

      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        if (destroyed) return;
        console.log('[TeslaPlayer] manifest parsed, levels:', hls.levels.length);
        const qs = hls.levels.map((l, i) => ({
          label: l.width ? `${l.width}x${l.height}` : `清晰度 ${i + 1}`,
          value: String(i),
        }));
        setQualities([{ label: '自动', value: 'auto' }, ...qs]);
        video.play().catch(() => undefined);
      });
      hls.on(Hls.Events.LEVEL_SWITCHED, () => {
        if (destroyed) return;
        const level = hls.currentLevel;
        if (level === -1) {
          setQuality('auto');
        } else {
          setQuality(String(level));
        }
      });
      hls.on(Hls.Events.ERROR, (_evt, data) => {
        if (destroyed) return;
        console.warn('[TeslaPlayer] hls error:', data.type, data.details);
        if (data.fatal) {
          if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
            hls.startLoad();
          } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
            hls.recoverMediaError();
          } else {
            setError(`HLS: ${data.details}`);
            setLoading(false);
          }
        }
      });
    } else if (isM3u8 && video.canPlayType('application/vnd.apple.mpegurl')) {
      // Safari 原生支持 HLS（无需 hls.js）
      video.src = url;
      video.play().catch(() => undefined);
    } else if (!isM3u8) {
      // 非 m3u8（如 mp4），直接用 video 元素
      video.src = url;
      setLoading(false);
      video.play().catch(() => undefined);
    } else {
      setError('浏览器不支持 HLS 播放');
      setLoading(false);
    }

    return () => {
      destroyed = true;
      video.removeEventListener('loadedmetadata', onLoadedMetadata);
      video.removeEventListener('loadeddata', onLoadedData);
      video.removeEventListener('timeupdate', onTimeUpdate);
      video.removeEventListener('play', onPlay);
      video.removeEventListener('pause', onPause);
      video.removeEventListener('waiting', onWaiting);
      video.removeEventListener('playing', onPlaying);
      video.removeEventListener('ended', onEnded);
      video.removeEventListener('error', onError);
      if (rafRef.current !== null) {
        const anyVideo = video as any;
        if (anyVideo && typeof anyVideo.cancelVideoFrameCallback === 'function') {
          anyVideo.cancelVideoFrameCallback(rafRef.current);
        } else {
          window.cancelAnimationFrame(rafRef.current);
        }
        rafRef.current = null;
      }
      if (hlsRef.current) { hlsRef.current.destroy(); hlsRef.current = null; }
      video.removeAttribute('src');
      video.load();
    };
  }, [url, live]);

  // ===== 控制条自动隐藏 =====
  const showControlsTemporarily = useCallback(() => {
    setShowControls(true);
    if (hideControlsTimerRef.current) window.clearTimeout(hideControlsTimerRef.current);
    if (playing) hideControlsTimerRef.current = window.setTimeout(() => { setShowControls(false); setShowRateMenu(false); setShowQualityMenu(false); }, 3000);
  }, [playing]);

  useEffect(() => { showControlsTemporarily(); return () => { if (hideControlsTimerRef.current) window.clearTimeout(hideControlsTimerRef.current); }; }, [showControlsTemporarily]);

  // ===== 全屏 =====
  const toggleFullscreen = useCallback(() => {
    const el = containerRef.current; if (!el) return;
    if (!document.fullscreenElement) { el.requestFullscreen?.().catch(() => undefined); (el as any).webkitRequestFullscreen?.(); }
    else { document.exitFullscreen?.().catch(() => undefined); (document as any).webkitExitFullscreen?.(); }
  }, []);

  useEffect(() => {
    const h = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', h);
    document.addEventListener('webkitfullscreenchange', h);
    return () => { document.removeEventListener('fullscreenchange', h); document.removeEventListener('webkitfullscreenchange', h); };
  }, []);

  // ===== 播放/暂停 =====
  const togglePlay = useCallback(() => {
    const v = videoRef.current; if (!v) return;
    if (v.paused) v.play().catch(() => undefined);
    else v.pause();
  }, []);

  // ===== 倍速 =====
  const setPlaybackRate = useCallback((r: number) => {
    const v = videoRef.current;
    if (v) v.playbackRate = r;
    setRate(r);
    setShowRateMenu(false);
  }, []);

  // ===== 清晰度 =====
  const switchQuality = useCallback((q: string) => {
    const hls = hlsRef.current;
    if (!hls) return;
    if (q === 'auto') {
      hls.currentLevel = -1;
    } else {
      hls.currentLevel = parseInt(q, 10);
    }
    setQuality(q);
    setShowQualityMenu(false);
  }, []);

  const onProgressInteraction = useCallback((e: React.MouseEvent | React.TouchEvent) => {
    const bar = e.currentTarget; const rect = bar.getBoundingClientRect();
    const clientX = 'touches' in e ? e.touches[0]?.clientX ?? rect.left : (e as React.MouseEvent).clientX;
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    if (duration !== Infinity && duration > 0) seek(ratio * duration);
  }, [duration, seek]);

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
      switch (e.key) {
        case ' ': case 'k': e.preventDefault(); togglePlay(); break;
        case 'ArrowLeft': seek(Math.max(0, currentTime - 10)); break;
        case 'ArrowRight': seek(Math.min(duration, currentTime + 10)); break;
        case 'f': toggleFullscreen(); break;
      }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [currentTime, duration, togglePlay, toggleFullscreen, seek]);

  const handleBackToOriginal = useCallback(() => { setTeslaOptOut(); onBackToOriginal?.(); }, [onBackToOriginal]);

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
      onClick={(e) => { if ((e.target as HTMLElement).dataset?.role === 'stage') togglePlay(); }}
    >
      {/* 视频元素（统一使用 video + hls.js） */}
      <video
        ref={videoRef}
        data-role="stage"
        className={`absolute inset-0 h-full w-full bg-black ${canvasMode ? 'opacity-0 pointer-events-none' : ''}`}
        style={{ objectFit: 'contain' }}
        playsInline
        autoPlay
        poster={poster}
      />

      {/* Canvas 元素（特斯拉行驶中 video 画面被禁用时显示） */}
      {canvasMode && (
        <canvas
          ref={canvasRef}
          data-role="stage"
          className="absolute inset-0 h-full w-full bg-black"
          style={{ objectFit: 'contain' }}
        />
      )}

      {/* 海报占位 */}
      {loading && poster && (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={poster} alt={title || ''} className="pointer-events-none absolute inset-0 h-full w-full object-contain opacity-40" />
      )}

      {/* 顶部条 */}
      <div className={`pointer-events-none absolute inset-x-0 top-0 flex items-start justify-between bg-gradient-to-b from-black/80 to-transparent p-4 transition-opacity duration-200 ${showControls ? 'opacity-100' : 'opacity-0'}`}>
        <div className="pointer-events-auto flex items-center gap-3">
          {onBackToOriginal && (
            <button type="button" onClick={handleBackToOriginal} className="rounded-md bg-white/10 px-3 py-1.5 text-sm font-medium backdrop-blur hover:bg-white/20" title="返回原版播放器">
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
            onClick={toggleCanvasMode}
            className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium backdrop-blur transition-colors ${
              canvasMode
                ? 'bg-green-500/30 text-green-300 ring-1 ring-green-400/50'
                : 'bg-white/10 text-white/80 hover:bg-white/20'
            }`}
            title={canvasMode ? '当前：Canvas 模式（点击切回 Video）' : '当前：Video 模式（无画面时点击切到 Canvas）'}
          >
            <MonitorPlay className="h-3.5 w-3.5" />
            {canvasMode ? 'Canvas' : 'Video'}
          </button>
        </div>
      </div>

      {/* 中间状态 */}
      <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
        {loading && (
          <div className="flex items-center gap-3 rounded-2xl border border-white/10 bg-black/60 px-6 py-3 text-base backdrop-blur">
            <Loader2 className="h-5 w-5 animate-spin" />
            <span>正在加载视频…</span>
          </div>
        )}
        {error && (
          <div className="pointer-events-auto mx-6 max-w-md rounded-2xl border border-red-500/40 bg-red-950/80 px-6 py-4 text-center text-sm backdrop-blur">
            <p className="font-semibold text-red-200">播放失败</p>
            <p className="mt-1 text-red-100/80">{error}</p>
            <div className="mt-3 flex justify-center gap-2">
              <button type="button" onClick={() => window.location.reload()} className="rounded bg-white/10 px-3 py-1 hover:bg-white/20">重试</button>
              {onBackToOriginal && (
                <button type="button" onClick={handleBackToOriginal} className="rounded bg-white/10 px-3 py-1 hover:bg-white/20">切回原版</button>
              )}
            </div>
          </div>
        )}
        {buffering && !loading && !error && (
          <div className="flex items-center gap-2 text-sm text-white/70"><Loader2 className="h-4 w-4 animate-spin" /> 缓冲中…</div>
        )}
      </div>

      {/* 底部控制条 */}
      <div className={`absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/90 to-transparent px-4 pb-3 pt-12 transition-opacity duration-200 ${showControls ? 'opacity-100' : 'opacity-0'}`}>
        {/* 进度条 */}
        <div className="group relative h-1.5 w-full cursor-pointer rounded-full bg-white/20" onClick={onProgressInteraction} onTouchStart={onProgressInteraction}>
          <div className="absolute left-0 top-0 h-full rounded-full bg-rose-500" style={{ width: `${progressPercent}%` }} />
          <div className="absolute top-1/2 h-3 w-3 -translate-y-1/2 rounded-full bg-white shadow opacity-0 transition-opacity group-hover:opacity-100" style={{ left: `calc(${progressPercent}% - 6px)` }} />
        </div>

        {/* 按钮行 */}
        <div className="mt-2 flex items-center justify-between text-sm">
          <div className="flex items-center gap-2">
            <button type="button" onClick={() => seek(Math.max(0, currentTime - 10))} className="rounded p-1 hover:bg-white/10" aria-label="后退10秒">
              <SkipBack className="h-5 w-5" />
            </button>
            <button type="button" onClick={togglePlay} className="rounded p-2 hover:bg-white/10" aria-label={playing ? '暂停' : '播放'}>
              {playing ? <Pause className="h-6 w-6" /> : <Play className="h-6 w-6 fill-current" />}
            </button>
            <button type="button" onClick={() => onEndedCallback?.()} className="rounded p-1 hover:bg-white/10" aria-label="下一集">
              <SkipForward className="h-5 w-5" />
            </button>
            <div className="relative">
              <button type="button" onClick={() => setShowRateMenu((v) => !v)} className="rounded px-2 py-1 hover:bg-white/10" aria-label="倍速">{rate}x</button>
              {showRateMenu && (
                <div className="absolute bottom-full left-0 mb-2 w-24 rounded-lg border border-white/10 bg-black/90 py-1 backdrop-blur">
                  {PLAYBACK_RATES.map((r) => (
                    <button key={r} type="button" onClick={() => setPlaybackRate(r)} className={`block w-full px-3 py-1 text-left hover:bg-white/10 ${r === rate ? 'text-rose-400' : ''}`}>{r}x</button>
                  ))}
                </div>
              )}
            </div>
            <span className="tabular-nums text-white/80">{formatTime(currentTime)}{duration !== Infinity && duration > 0 && <> / {formatTime(duration)}</>}</span>
          </div>
          <div className="flex items-center gap-2">
            {qualities.length > 1 && (
              <div className="relative">
                <button type="button" onClick={() => setShowQualityMenu((v) => !v)} className="rounded px-2 py-1 hover:bg-white/10" aria-label="清晰度">
                  {qualities.find((q) => q.value === quality)?.label || quality}
                </button>
                {showQualityMenu && (
                  <div className="absolute bottom-full right-0 mb-2 w-32 rounded-lg border border-white/10 bg-black/90 py-1 backdrop-blur">
                    {qualities.map((q) => (
                      <button key={q.value} type="button" onClick={() => switchQuality(q.value)} className={`block w-full px-3 py-1 text-left hover:bg-white/10 ${q.value === quality ? 'text-rose-400' : ''}`}>
                        {q.label}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
            <button type="button" onClick={toggleFullscreen} className="rounded p-1 hover:bg-white/10" aria-label={isFullscreen ? '退出全屏' : '全屏'}>
              {isFullscreen ? <Minimize className="h-5 w-5" /> : <Maximize className="h-5 w-5" />}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
