'use client';

import { Loader2, Pause, Play } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

declare global {
  interface HTMLVideoElement {
    hls?: any;
    flv?: any;
  }
}

type SourceType = 'm3u8' | 'flv' | 'native';

function getSourceType(url: string, explicitType?: SourceType): SourceType {
  if (explicitType) return explicitType;
  const lower = url.toLowerCase();
  const path = lower.split('?')[0];
  if (path.includes('.m3u8') || path.includes('.m3u') || lower.includes('/m3u8') || lower.includes('m3u8') || lower.includes('.m3u')) return 'm3u8';
  if (path.endsWith('.flv') || lower.includes('.flv?')) return 'flv';
  return 'native';
}

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

export default function TVNativeVideo({
  url,
  poster,
  live = false,
  title,
  onTime,
  onError: onPlaybackError,
  onPlayingChange,
  onBufferingChange,
  adFilterEnabled = false,
  playbackRate = 1,
  startTime = 0,
  command,
  sourceType,
  className = '',
}: {
  url: string;
  poster?: string;
  live?: boolean;
  title?: string;
  onTime?: (current: number, duration: number) => void;
  onError?: () => void;
  onPlayingChange?: (playing: boolean) => void;
  onBufferingChange?: (buffering: boolean) => void;
  adFilterEnabled?: boolean;
  playbackRate?: number;
  startTime?: number;
  command?: number;
  sourceType?: SourceType;
  className?: string;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const animationRef = useRef<number>(0);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const isDrawingRef = useRef(false);

  const onTimeRef = useRef<typeof onTime>(onTime);
  const onPlaybackErrorRef = useRef<typeof onPlaybackError>(onPlaybackError);
  const onPlayingChangeRef = useRef<typeof onPlayingChange>(onPlayingChange);
  const onBufferingChangeRef = useRef<typeof onBufferingChange>(onBufferingChange);
  const bufferingTimerRef = useRef<number | null>(null);
  const bufferingStateRef = useRef(false);

  const [loading, setLoading] = useState(false);
  const [buffering, setBuffering] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    onTimeRef.current = onTime;
  }, [onTime]);

  useEffect(() => {
    onPlaybackErrorRef.current = onPlaybackError;
  }, [onPlaybackError]);

  useEffect(() => {
    onPlayingChangeRef.current = onPlayingChange;
  }, [onPlayingChange]);

  useEffect(() => {
    onBufferingChangeRef.current = onBufferingChange;
  }, [onBufferingChange]);

  // 帧绘制循环
  const drawFrame = () => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas) return;

    const ctx = canvas.getContext('2d');
    if (ctx && video.videoWidth > 0 && video.videoHeight > 0) {
      const canvasWidth = canvas.width;
      const canvasHeight = canvas.height;
      const videoRatio = video.videoWidth / video.videoHeight;
      const canvasRatio = canvasWidth / canvasHeight;

      let drawWidth = canvasWidth;
      let drawHeight = canvasHeight;
      let offsetX = 0;
      let offsetY = 0;

      if (videoRatio > canvasRatio) {
        drawHeight = canvasWidth / videoRatio;
        offsetY = (canvasHeight - drawHeight) / 2;
      } else {
        drawWidth = canvasHeight * videoRatio;
        offsetX = (canvasWidth - drawWidth) / 2;
      }

      ctx.drawImage(video, offsetX, offsetY, drawWidth, drawHeight);
    }

    animationRef.current = requestAnimationFrame(drawFrame);
  };

  // 启动绘制（保证只启动一次）
  const startDrawing = () => {
    if (isDrawingRef.current) return;
    isDrawingRef.current = true;
    drawFrame();
  };

  // 适配容器尺寸
  const resizeCanvas = () => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;
    const rect = container.getBoundingClientRect();
    // 兜底：容器高度为0时按16:9计算
    canvas.width = rect.width || 1280;
    canvas.height = rect.height || rect.width * 9 / 16 || 720;
  };

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !url) return;
    const videoEl = video;

    let disposed = false;
    setLoading(true);
    bufferingStateRef.current = false;
    setBuffering(false);
    onBufferingChangeRef.current?.(false);
    setError('');
    setPlaying(false);
    isDrawingRef.current = false;

    const cleanup = () => {
      cancelAnimationFrame(animationRef.current);
      isDrawingRef.current = false;
      if (videoEl.hls) {
        videoEl.hls.destroy();
        videoEl.hls = null;
      }
      if (videoEl.flv) {
        videoEl.flv.destroy();
        videoEl.flv = null;
      }
      videoEl.removeAttribute('src');
      videoEl.load();
    };

    const playSafely = () => {
      videoEl.play().catch(() => {
        // 自动播放被拦截时，也先启动绘制，显示首帧画面
        startDrawing();
      });
    };

    const setBufferingState = (next: boolean) => {
      if (bufferingStateRef.current === next) return;
      bufferingStateRef.current = next;
      setBuffering(next);
      onBufferingChangeRef.current?.(next);
    };

    const clearBuffering = () => {
      if (bufferingTimerRef.current) {
        window.clearTimeout(bufferingTimerRef.current);
        bufferingTimerRef.current = null;
      }
      setBufferingState(false);
    };

    const scheduleBuffering = () => {
      if (videoEl.paused || videoEl.ended || bufferingTimerRef.current) return;
      bufferingTimerRef.current = window.setTimeout(() => {
        bufferingTimerRef.current = null;
        if (!videoEl.paused && !videoEl.ended && videoEl.readyState < HTMLMediaElement.HAVE_FUTURE_DATA) {
          setBufferingState(true);
        }
      }, 700);
    };

    async function attach() {
      cleanup();
      const type = getSourceType(url, sourceType);

      try {
        if (type === 'm3u8' && !videoEl.canPlayType('application/vnd.apple.mpegurl')) {
          const HlsModule = await import('hls.js');
          if (disposed) return;
          const Hls = HlsModule.default;
          if (Hls.isSupported()) {
            const CustomLoader = adFilterEnabled
              ? class TVAdFilterLoader extends Hls.DefaultConfig.loader {
                  constructor(config: any) {
                    super(config);
                    const load = this.load.bind(this);
                    this.load = (context: any, config: any, callbacks: any) => {
                      if (context?.type === 'manifest' || context?.type === 'level') {
                        const onSuccess = callbacks.onSuccess;
                        callbacks.onSuccess = (response: any, stats: any, context: any, networkDetails: any) => {
                          if (typeof response?.data === 'string') {
                            response.data = filterAdsFromM3U8(response.data);
                          }
                          return onSuccess(response, stats, context, networkDetails);
                        };
                      }
                      load(context, config, callbacks);
                    };
                  }
                }
              : undefined;
            const hls = new Hls({
              enableWorker: false,
              lowLatencyMode: live,
              backBufferLength: live ? 10 : 30,
              maxBufferLength: live ? 18 : 45,
              ...(CustomLoader ? { loader: CustomLoader } : {}),
            });
            hls.loadSource(url);
            hls.attachMedia(videoEl);
            videoEl.hls = hls;
          } else {
            videoEl.src = url;
          }
        } else if (type === 'flv') {
          const flvModule = await import('flv.js');
          if (disposed) return;
          const flvjs = flvModule.default;
          if (flvjs.isSupported()) {
            const flv = flvjs.createPlayer({ type: 'flv', url, isLive: live });
            flv.attachMediaElement(videoEl);
            flv.load();
            videoEl.flv = flv;
          } else {
            videoEl.src = url;
          }
        } else {
          videoEl.src = url;
        }

        videoEl.setAttribute('playsinline', 'true');
        videoEl.setAttribute('webkit-playsinline', 'true');
        videoEl.playbackRate = playbackRate;
        videoEl.muted = false;
        playSafely();
      } catch (err) {
        console.error('[TVNativeVideo] attach failed:', err);
        setError('播放器初始化失败');
        setLoading(false);
      }
    }

    attach();
    resizeCanvas();
    window.addEventListener('resize', resizeCanvas);

    let triedInitialSeek = false;
    const seekToInitialTime = () => {
      if (live || triedInitialSeek || !startTime || startTime <= 1) return;
      if ((videoEl.currentTime || 0) > 1) {
        triedInitialSeek = true;
        return;
      }
      const duration = videoEl.duration || 0;
      const safeTime = duration > 30 ? Math.min(startTime, Math.max(0, duration - 8)) : startTime;
      try {
        videoEl.currentTime = safeTime;
        triedInitialSeek = true;
      } catch {
        // ignore
      }
    };

    const onLoaded = () => {
      seekToInitialTime();
      resizeCanvas();
      setLoading(false);
      clearBuffering();
      // 关键：加载出首帧就启动绘制，不等待play事件
      startDrawing();
    };
    const onPlay = () => {
      setPlaying(true);
      clearBuffering();
      startDrawing();
      onPlayingChangeRef.current?.(true);
    };
    const onPlaying = () => {
      setPlaying(true);
      clearBuffering();
      onPlayingChangeRef.current?.(true);
    };
    const onPause = () => {
      setPlaying(false);
      clearBuffering();
      onPlayingChangeRef.current?.(false);
    };
    const onBuffering = () => scheduleBuffering();
    const onError = () => {
      setLoading(false);
      clearBuffering();
      setError('视频加载失败，请尝试切换线路或频道');
      onPlaybackErrorRef.current?.();
    };
    const onTimeUpdate = () => {
      clearBuffering();
      onTimeRef.current?.(videoEl.currentTime || 0, videoEl.duration || 0);
    };

    videoEl.addEventListener('loadedmetadata', seekToInitialTime);
    videoEl.addEventListener('loadeddata', onLoaded);
    videoEl.addEventListener('canplay', onLoaded);
    videoEl.addEventListener('canplaythrough', onLoaded);
    videoEl.addEventListener('play', onPlay);
    videoEl.addEventListener('playing', onPlaying);
    videoEl.addEventListener('pause', onPause);
    videoEl.addEventListener('waiting', onBuffering);
    videoEl.addEventListener('stalled', onBuffering);
    videoEl.addEventListener('seeking', onBuffering);
    videoEl.addEventListener('seeked', clearBuffering);
    videoEl.addEventListener('error', onError);
    videoEl.addEventListener('timeupdate', onTimeUpdate);

    return () => {
      disposed = true;
      window.removeEventListener('resize', resizeCanvas);
      videoEl.removeEventListener('loadedmetadata', seekToInitialTime);
      videoEl.removeEventListener('loadeddata', onLoaded);
      videoEl.removeEventListener('canplay', onLoaded);
      videoEl.removeEventListener('canplaythrough', onLoaded);
      videoEl.removeEventListener('play', onPlay);
      videoEl.removeEventListener('playing', onPlaying);
      videoEl.removeEventListener('pause', onPause);
      videoEl.removeEventListener('waiting', onBuffering);
      videoEl.removeEventListener('stalled', onBuffering);
      videoEl.removeEventListener('seeking', onBuffering);
      videoEl.removeEventListener('seeked', clearBuffering);
      videoEl.removeEventListener('error', onError);
      videoEl.removeEventListener('timeupdate', onTimeUpdate);
      clearBuffering();
      cleanup();
    };
  }, [url, live, startTime, adFilterEnabled, playbackRate, sourceType]);

  useEffect(() => {
    const video = videoRef.current;
    if (video) video.playbackRate = playbackRate;
  }, [playbackRate]);

  const toggle = () => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) video.play().catch(() => undefined);
    else video.pause();
  };

  useEffect(() => {
    if (command) toggle();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [command]);

  return (
    <div ref={containerRef} className={`relative h-full w-full bg-black ${className}`}>
      {/* 可见画布：特斯拉识别为普通图片，D档不冻结 */}
      <canvas
        ref={canvasRef}
        className='h-full w-full bg-black object-contain'
        onClick={toggle}
        aria-label={title || 'TV 视频播放器'}
      />

      {/* 隐藏解码层：保留1px尺寸保证解码正常，移出可视区域 */}
      <video
        ref={videoRef}
        poster={poster}
        controls={false}
        playsInline
        preload='auto'
        style={{
          position: 'absolute',
          left: '-9999px',
          top: '-9999px',
          opacity: 0,
          pointerEvents: 'none',
          width: '1px',
          height: '1px',
        }}
      />

      {(loading || buffering) && (
        <div className='pointer-events-none absolute inset-0 flex items-center justify-center bg-black/35 text-white'>
          <div className='flex items-center gap-3 rounded-2xl border border-white/12 bg-black/55 px-6 py-4 text-2xl font-bold shadow-2xl shadow-black/50 backdrop-blur-md'>
            <Loader2 className='h-9 w-9 animate-spin text-rose-500' />
            <span>{buffering ? '缓冲中' : '正在载入'}</span>
          </div>
        </div>
      )}
      {error && (
        <div className='absolute inset-0 flex items-center justify-center bg-black/70 p-8 text-center text-3xl font-black text-white'>
          {error}
        </div>
      )}
      <button
        type='button'
        onClick={toggle}
        className='tv-focusable absolute left-1/2 top-1/2 flex h-24 w-24 -translate-x-1/2 -translate-y-1/2 cursor-pointer items-center justify-center rounded-full bg-black/35 text-white opacity-0 outline-none backdrop-blur transition hover:opacity-100 focus:opacity-100'
        aria-label={playing ? '暂停' : '播放'}
      >
        {playing ? <Pause className='h-12 w-12' /> : <Play className='h-12 w-12 fill-current' />}
      </button>
    </div>
  );
}
