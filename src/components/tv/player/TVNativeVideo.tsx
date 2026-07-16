'use client';

import { Loader2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

declare global {
  interface Window {
    Player: any;
    muxjs: any;
  }
}

type SourceType = 'm3u8' | 'native';

function getSourceType(url: string, explicitType?: SourceType): SourceType {
  if (explicitType) return explicitType;
  const lower = url.toLowerCase();
  return lower.includes('m3u8') || lower.includes('.m3u') ? 'm3u8' : 'native';
}

// 动态加载全局脚本工具
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
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!url || !canvasContainerRef.current) return;
    let disposed = false;

    setLoading(true);
    setError('');

    const initPlayer = async () => {
      try {
        // 按顺序加载 Broadway 三个全局脚本
        await loadScript('/broadway/Decoder.js');
        await loadScript('/broadway/YUVCanvas.js');
        await loadScript('/broadway/Player.js');
        // 加载 mux.js 用于解 TS 封装
        await loadScript('https://cdn.jsdelivr.net/npm/mux.js@6.3.0/dist/mux.min.js');

        if (disposed || !window.Player) return;

        // 初始化 Broadway 软解播放器
        const broadwayPlayer = new window.Player({
          useWorker: true,
          workerFile: '/broadway/Decoder.js',
          webgl: 'auto',
        });
        playerRef.current = broadwayPlayer;

        // 把画布插入到容器中
        const canvas = broadwayPlayer.canvas;
        canvas.style.width = '100%';
        canvas.style.height = '100%';
        canvas.style.objectFit = 'contain';
        canvas.style.display = 'block';
        canvasContainerRef.current?.appendChild(canvas);

        const type = getSourceType(url);
        if (type === 'm3u8') {
          const HlsModule = await import('hls.js');
          const Hls = HlsModule.default;

          if (!Hls.isSupported()) {
            setError('当前浏览器不支持HLS');
            setLoading(false);
            return;
          }

          const hls = new Hls({
            enableWorker: false,
            maxBufferLength: 30,
            backBufferLength: 10,
          });
          hlsRef.current = hls;
          hls.loadSource(url);

          // 监听分片加载，解封装后喂给 Broadway 解码
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
              console.warn('解封装失败', e);
            }
          });

          hls.on(Hls.Events.MANIFEST_PARSED, () => {
            setLoading(false);
          });

          hls.on(Hls.Events.ERROR, (_: any, data: any) => {
            if (data.fatal) {
              setError('视频加载失败');
              setLoading(false);
            }
          });
        } else {
          setLoading(false);
        }
      } catch (err) {
        console.error('[Broadway Player] 初始化失败:', err);
        setError('播放器初始化失败');
        setLoading(false);
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
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current.src = '';
      }
      // 清理画布
      if (canvasContainerRef.current) {
        canvasContainerRef.current.innerHTML = '';
      }
    };
  }, [url]);

  return (
    <div className={`relative h-full w-full bg-black ${className}`}>
      <div ref={canvasContainerRef} className='h-full w-full bg-black' />

      {loading && (
        <div className='pointer-events-none absolute inset-0 flex items-center justify-center bg-black/35 text-white'>
          <div className='flex items-center gap-3 rounded-2xl border border-white/12 bg-black/55 px-6 py-4 text-2xl font-bold shadow-2xl shadow-black/50 backdrop-blur-md'>
            <Loader2 className='h-9 w-9 animate-spin text-rose-500' />
            <span>正在载入</span>
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
