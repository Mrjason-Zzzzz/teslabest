'use client';

/* eslint-disable @typescript-eslint/no-explicit-any */

import Hls from 'hls.js';
import { Loader2, Maximize, Minimize, Monitor, Pause, Play, RotateCcw, SkipForward, SkipBack, Tv } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { HlsBroadwayEngine } from '@/lib/tesla-player/hls-broadway-engine';
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
type PlayerMode = 'video' | 'canvas';

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

export default function TeslaPlayer({ url, title, poster, live = false, onBackToOriginal, onEnded, playRecordKey }: TeslaPlayerProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasHostRef = useRef<HTMLDivElement | null>(null);
  const engineRef = useRef<HlsBroadwayEngine | null>(null);
  const hlsRef = useRef<Hls | null>(null);
  const scriptsLoadedRef = useRef(false);
  const hideControlsTimerRef = useRef<number | null>(null);
  const progressSaveTimerRef = useRef<number | null>(null);

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
      if (progressRatio < 0.95) {
        seek(savedProgress);
        setSeekToTime(savedProgress);
      }
    }
  }, [savedProgress, duration, seekToTime]);

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

  // ===== Video 模式 =====
  useEffect(() => {
    if (mode !== 'video' || !url) return;
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
    const onPlaying = () => { if (!destroyed) { setBuffering(false); setLoading(false); } };
    const onEnded = () => {
      if (destroyed) return;
      setPlaying(false);
      if (playRecordKey) saveProgress(playRecordKey, video.duration || 0);
      setTimeout(() => window.onEnded?.(), 500);
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

    if (Hls.isSupported()) {
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
        console.log('[TeslaPlayer:video] manifest parsed, levels:', hls.levels.length);
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
        console.warn('[TeslaPlayer:video] hls error:', data.type, data.details);
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
    } else {
      setError('浏览器不支持 HLS 播放，请切换到 Canvas 模式');
      setLoading(false);
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
      if (hlsRef.current) { hlsRef.current.destroy(); hlsRef.current = null; }
      video.removeAttribute('src');
      video.load();
    };
  }, [mode, url, live]);

  // ===== Canvas 模式 =====
  const ensureBroadwayScripts = useCallback(async () => {
    if (scriptsLoadedRef.current) return;
    if (typeof window === 'undefined') return;
    if (!(window as any).global) { (window as any).global = window; }
    const load = (src: string) => new Promise<void>((resolve, reject) => {
      if (document.querySelector(`script[src="${src}"]`)) { resolve(); return; }
      const s = document.createElement('script');
      s.src = src; s.async = false;
      s.onload = () => resolve();
      s.onerror = () => reject(new Error(`加载脚本失败: ${src}`));
      document.head.appendChild(s);
    });
    await load('/assets/broadway/Decoder.js');
    await load('/assets/broadway/YUVCanvas.js');
    await load('/assets/broadway/Player.js');
    if (!window.Player || !window.YUVCanvas || !window.Decoder) {
      throw new Error('Broadway 脚本加载后全局变量缺失');
    }
    scriptsLoadedRef.current = true;
  }, []);

  useEffect(() => {
    if (mode !== 'canvas' || !url) return;
    let disposed = false;

    (async () => {
      try {
        setLoading(true); setError(null);
        await ensureBroadwayScripts();
        if (disposed) return;
        if (canvasHostRef.current) canvasHostRef.current.innerHTML = '';

        const engine = new HlsBroadwayEngine({
          url, live, autoplay: true, useWorker: true, webgl: 'auto',
          size: { width: 1280, height: 720 }, debug: true,
        });
        engineRef.current = engine;

        engine.on('manifestParsed', () => { if (!disposed) { setLoading(false); setDuration(engine.getDuration()); } });
        engine.on('durationchange', (d: number) => { if (!disposed) setDuration(d); });
        engine.on('playing', () => { if (!disposed) { setPlaying(true); setLoading(false); } });
        engine.on('pause', () => { if (!disposed) setPlaying(false); });
        engine.on('buffering', (b: boolean) => { if (!disposed) setBuffering(b); });
        engine.on('timeupdate', (t: number) => { if (!disposed) setCurrentTime(t); });
        engine.on('ended', () => {
          if (!disposed) {
            setPlaying(false);
            setTimeout(() => onEnded?.(), 500);
          }
        });
        engine.on('error', (err: any) => {
          if (!disposed) {
            setError(`${err?.details || 'Canvas 播放出错'}${err?.type ? `（${err.type}）` : ''}`);
            setLoading(false);
          }
        });

        await engine.load();
        if (disposed) return;

        const canvas = engine.getCanvas();
        if (canvas && canvasHostRef.current) {
          if (canvas.parentElement !== canvasHostRef.current) {
            if (canvas.parentElement) canvas.parentElement.removeChild(canvas);
            canvasHostRef.current.appendChild(canvas);
          }
          Object.assign(canvas.style, { width: '100%', height: '100%', objectFit: 'contain', background: '#000', display: 'block' });
        }
      } catch (e: any) {
        if (!disposed) { setError(e?.message || 'Canvas 模式初始化失败'); setLoading(false); }
      }
    })();

    return () => {
      disposed = true;
      try { engineRef.current?.destroy(); } catch { /* ignore */ }
      engineRef.current = null;
    };
  }, [mode, url, live, ensureBroadwayScripts, onEnded]);

  // ===== 模式切换 =====
  const switchMode = useCallback((newMode: PlayerMode) => {
    if (hlsRef.current) { hlsRef.current.destroy(); hlsRef.current = null; }
    if (engineRef.current) { try { engineRef.current.destroy(); } catch { /* ignore */ } engineRef.current = null; }
    if (videoRef.current) { videoRef.current.removeAttribute('src'); videoRef.current.load(); }
    if (canvasHostRef.current) canvasHostRef.current.innerHTML = '';
    setMode(newMode); setLoading(true); setError(null); setPlaying(false); setCurrentTime(0); setDuration(0); setQualities([]);
  }, []);

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
    if (mode === 'video') {
      const v = videoRef.current; if (!v) return;
      v.paused ? v.play().catch(() => undefined) : v.pause();
    } else {
      const e = engineRef.current; if (!e) return;
      e.getPaused() ? void e.play() : e.pause();
    }
  }, [mode]);

  // ===== Seek =====
  const seek = useCallback((t: number) => {
    if (mode === 'video') { const v = videoRef.current; if (v) v.currentTime = t; }
    else { const e = engineRef.current; if (e) e.seek(t); }
    setCurrentTime(t);
  }, [mode]);

  // ===== 倍速 =====
  const setPlaybackRate = useCallback((r: number) => {
    if (mode === 'video') { const v = videoRef.current; if (v) v.playbackRate = r; }
    else { const e = engineRef.current; if (e) e.setPlaybackRate(r); }
    setRate(r); setShowRateMenu(false);
  }, [mode]);

  // ===== 清晰度 =====
  const switchQuality = useCallback((q: string) => {
    if (mode !== 'video') return;
    const hls = hlsRef.current;
    if (!hls) return;
    if (q === 'auto') {
      hls.currentLevel = -1;
    } else {
      hls.currentLevel = parseInt(q, 10);
    }
    setQuality(q);
    setShowQualityMenu(false);
  }, [mode]);

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
      {/* Video 模式 - 始终渲染，用 CSS 控制显示，避免切换时 ref 时序问题 */}
      <video
        ref={videoRef}
        data-role="stage"
        className={`absolute inset-0 h-full w-full bg-black ${mode === 'video' ? '' : 'hidden'}`}
        style={{ objectFit: 'contain' }}
        playsInline autoPlay poster={poster}
      />

      {/* Canvas 模式 */}
      <div ref={canvasHostRef} data-role="stage"
        className={`absolute inset-0 flex items-center justify-center bg-black ${mode === 'canvas' ? '' : 'hidden'}`}
      />

      {/* 海报 */}
      {loading && poster && mode === 'canvas' && (
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
            <span className={`ml-2 rounded px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider ${mode === 'canvas' ? 'bg-rose-600/80' : 'bg-blue-600/80'}`}>
              {mode === 'canvas' ? 'Canvas' : 'Video'}
            </span>
            {live && <span className="ml-2 rounded bg-red-600 px-1.5 py-0.5 text-[10px] font-bold uppercase">LIVE</span>}
          </h1>
        </div>
        <div className="pointer-events-auto">
          <button type="button" onClick={() => switchMode(mode === 'video' ? 'canvas' : 'video')}
            className="flex items-center gap-1.5 rounded-md bg-white/10 px-3 py-1.5 text-sm font-medium backdrop-blur hover:bg-white/20"
            title={mode === 'video' ? '切换到 Canvas 软解模式' : '切换到视频模式'}>
            {mode === 'video' ? (<><Tv className="h-4 w-4" /> Canvas</>) : (<><Monitor className="h-4 w-4" /> 视频</>)}
          </button>
        </div>
      </div>

      {/* 中间状态 */}
      <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
        {loading && (
          <div className="flex items-center gap-3 rounded-2xl border border-white/10 bg-black/60 px-6 py-3 text-base backdrop-blur">
            <Loader2 className="h-5 w-5 animate-spin" />
            <span>{mode === 'canvas' ? '正在加载 Broadway 解码器…' : '正在加载视频…'}</span>
          </div>
        )}
        {error && (
          <div className="pointer-events-auto mx-6 max-w-md rounded-2xl border border-red-500/40 bg-red-950/80 px-6 py-4 text-center text-sm backdrop-blur">
            <p className="font-semibold text-red-200">播放失败</p>
            <p className="mt-1 text-red-100/80">{error}</p>
            <div className="mt-3 flex justify-center gap-2">
              <button type="button" onClick={() => switchMode(mode === 'video' ? 'canvas' : 'video')} className="rounded bg-white/10 px-3 py-1 hover:bg-white/20">
                切换到{mode === 'video' ? 'Canvas' : '视频'}模式
              </button>
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
            <button type="button" onClick={onEnded} className="rounded p-1 hover:bg-white/10" aria-label="下一集">
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
            {qualities.length > 1 && mode === 'video' && (
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