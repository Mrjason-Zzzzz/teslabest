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
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const playerRef = useRef<any>(null);
  const hlsRef = useRef<any>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!url || !canvasRef.current) return;
    let disposed = false;

    setLoading(true);
    setError('');

    // 动态加载 Broadway 解码器 + mux.js 解封装工具
    const loadScripts = async () => {
      if (!window.Player) {
        await Promise.all([
          import('/broadway/Decoder.js'),
          import('/broadway/YUVCanvas.js'),
          import('/broadway/Player.js'),
        ]);
      }
      if (!window.muxjs) {
        // 从CDN加载mux.js，用于解TS封装提取H.264帧
        await new Promise<void>((resolve, reject) => {
          const script = document.createElement('script');
          script.src = 'https://cdn.jsdelivr.net/npm/mux.js@6.3.0/dist/mux.min.js';
          script.onload = () => resolve();
          script.onerror = reject;
          document.head.appendChild(script);
        });
      }
    };

    const initPlayer = async () => {
      try {
        await loadScripts();
        if (disposed) return;

        // 初始化 Broadway 软解播放器
        const broadwayPlayer = new window.Player({
          useWorker: true,
          workerFile: '/broadway/Decoder.js',
          webgl: 'auto',
        });
        playerRef.current = broadwayPlayer;

        // 把解码器的canvas替换到页面上
        if (canvasRef.current?.parentNode) {
          canvasRef.current.parentNode.replaceChild(
            broadwayPlayer.canvas,
            canvasRef.current
          );
          broadwayPlayer.canvas.className = 'h-full w-full object-contain';
        }

        const type = getSourceType(url);
        if (type === 'm3u8') {
          const HlsModule = await import('hls.js');
          const Hls = HlsModule.default;

          if (!Hls.isSupported()) {
            setError('当前浏览器不支持HLS');
            return;
          }

          const hls = new Hls({
            enableWorker: false,
            maxBufferLength: 30,
            backBufferLength: 10,
          });
          hlsRef.current = hls;
          hls.loadSource(url);

          // 监听分片加载，解封装后喂给Broadway
          hls.on(Hls.Events.FRAG_LOADED, (_: any, data: any) => {
            if (disposed) return;
            const frag = data.frag;
            const dataArray = new Uint8Array(frag.data);

            // 用mux.js解TS封装，提取H.264视频帧
            const transmuxer = new window.muxjs.mp4.Transmuxer();
            transmuxer.on('data', (segment: any) => {
              if (disposed) return;
              // 提取视频轨的H.264数据喂给解码器
              if (segment.video?.data) {
                broadwayPlayer.decode(segment.video.data);
              }
            });
            transmuxer.push(new Uint8Array(dataArray));
            transmuxer.flush();
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
        }
      } catch (err) {
        console.error('播放器初始化失败', err);
        setError('播放器初始化失败');
        setLoading(false);
      }
    };

    initPlayer();

    return () => {
      disposed = true;
      if (hlsRef.current) {
        hlsRef.current.destroy();
        hlsRef.current = null;
      }
      if (playerRef.current?.worker) {
        playerRef.current.worker.terminate();
      }
    };
  }, [url]);

  return (
    <div ref={containerRef} className={`relative h-full w-full bg-black ${className}`}>
      <canvas ref={canvasRef} className='h-full w-full bg-black object-contain' />

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
