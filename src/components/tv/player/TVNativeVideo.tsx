'use client';

import { Loader2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

declare global {
  interface Window {
    Player: any;
    muxjs: any;
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

// 动态加载全局脚本
function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) {
      resolve();
      return;
    }
    const script = document.createElement('script');
    script.src = src;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error(`Failed to load ${src}`));
    document.head.appendChild(script);
  });
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
  const canvasContainerRef = useRef<HTMLDivElement>(null);
  const playerRef = useRef<any>(null);
  const hlsRef = useRef<any>(null);

  const [loading, setLoading] = useState(true);
  const [buffering, setBuffering] = useState(false);
  const [error, setError] = useState('');

  // 保持回调引用最新
  const onTimeRef = useRef(onTime);
  const onPlaybackErrorRef = useRef(onPlaybackError);
  const onPlayingChangeRef = useRef(onPlayingChange);
  const onBufferingChangeRef = useRef(onBufferingChange);

  useEffect(() => { onTimeRef.current = onTime; }, [onTime]);
  useEffect(() => { onPlaybackErrorRef.current = onPlaybackError; }, [onPlaybackError]);
  useEffect(() => { onPlayingChangeRef.current = onPlayingChange; }, [onPlayingChange]);
  useEffect(() => { onBufferingChangeRef.current = onBufferingChange; }, [onBufferingChange]);

  useEffect(() => {
    if (!url || !canvasContainerRef.current) return;
    let disposed = false;

    setLoading(true);
    setBuffering(false);
    setError('');

    const initPlayer = async () => {
      try {
        // 按顺序加载 Broadway 依赖
        await loadScript('/broadway/Decoder.js');
        await loadScript('/broadway/YUVCanvas.js');
        await loadScript('/broadway/Player.js');
        await loadScript('https://cdn.jsdelivr.net/npm/mux.js@6.3.0/dist/mux.min.js');

        if (disposed || !window.Player) return;

        // 初始化 Broadway 软解播放器
        const broadwayPlayer = new window.Player({
          useWorker: true,
          workerFile: '/broadway/Decoder.js',
          webgl: 'auto',
        });
        playerRef.current = broadwayPlayer;

        // 插入画布到容器
        const canvas = broadwayPlayer.canvas;
        canvas.style.width = '100%';
        canvas.style.height = '100%';
        canvas.style.objectFit = 'contain';
        canvas.style.display = 'block';
        canvasContainerRef.current?.appendChild(canvas);

        const type = getSourceType(url, sourceType);
        if (type === 'm3u8') {
          const HlsModule = await import('hls.js');
          const Hls = HlsModule.default;

          if (!Hls.isSupported()) {
            setError('当前浏览器不支持HLS');
            setLoading(false);
            onPlaybackErrorRef.current?.();
            return;
          }

          const hls = new Hls({
            enableWorker: false,
            lowLatencyMode: live,
            backBufferLength: live ? 10 : 30,
            maxBufferLength: live ? 18 : 45,
          });
          hlsRef.current = hls;
          hls.loadSource(url);

          // 分片加载后解封装喂给解码器
          hls.on(Hls.Events.FRAG_LOADED, (_: any, data: any) => {
            if (disposed || !window.muxjs) return;
            const dataArray = new Uint8Array(data.frag.data);
            try {
              const transmuxer = new window.muxjs.mp4.Transmuxer();
              transmuxer.on('data', (segment: any) => {
                if (disposed) return;
                if (segment.video?.data) {
                  broadwayPlayer.decode(segment.video.data);
                }
              });
              transmuxer.push(dataArray);
              transmuxer.flush();
            } catch (e) {
              console.warn('TS解封装失败', e);
            }
          });

          hls.on(Hls.Events.MANIFEST_PARSED, () => {
            setLoading(false);
            onBufferingChangeRef.current?.(false);
          });

          hls.on(Hls.Events.FRAG_BUFFERED, () => {
            setBuffering(false);
            onBufferingChangeRef.current?.(false);
          });

          hls.on(Hls.Events.ERROR, (_: any, data: any) => {
            if (data.fatal) {
              setError('视频加载失败，请尝试切换线路');
              setLoading(false);
              setBuffering(false);
              onPlaybackErrorRef.current?.();
            } else {
              setBuffering(true);
              onBufferingChangeRef.current?.(true);
            }
          });
        } else {
          setLoading(false);
        }
      } catch (err) {
        console.error('[Broadway Player] 初始化失败:', err);
        setError('播放器初始化失败');
        setLoading(false);
        onPlaybackErrorRef.current?.();
      }
    };

    initPlayer();

    return () => {
      disposed = true;
      if (hlsRef.current) {
        try { hlsRef.current.destroy(); } catch (e) {}
        hlsRef.current = null;
      }
      if (playerRef.current?.worker) {
        try { playerRef.current.worker.terminate(); } catch (e) {}
      }
      if (canvasContainerRef.current) {
        canvasContainerRef.current.innerHTML = '';
      }
    };
  }, [url, live, sourceType, adFilterEnabled]);

  // 兼容 command 指令（外部控制播放暂停）
  useEffect(() => {
    if (!command) return;
    // 软解版暂不支持外部指令控制，预留接口避免报错
  }, [command]);

  // 兼容倍速设置
  useEffect(() => {
    // 软解版暂不支持倍速，预留接口避免报错
  }, [playbackRate]);

  return (
    <div className={`relative h-full w-full bg-black ${className}`}>
      <div ref={canvasContainerRef} className='h-full w-full bg-black' />

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
    </div>
  );
}
