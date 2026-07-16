'use client';

import { Loader2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

type SourceType = 'm3u8' | 'flv' | 'native';

export default function TVNativeVideo({
  url,
  poster,
  live = false,
  title,
  onTime,
  onError: onPlaybackError,
  onPlayingChange,
  onBufferingChange,
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
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // 拼接播放地址：自动编码 m3u8 链接
  const playerUrl = `https://tesla-player.com/#URL=${encodeURIComponent(url)}`;

  useEffect(() => {
    if (!url) return;
    setLoading(true);
    setError('');
  }, [url]);

  const handleIframeLoad = () => {
    setLoading(false);
    onPlayingChange?.(true);
    onBufferingChange?.(false);
  };

  const handleIframeError = () => {
    setLoading(false);
    setError('播放器加载失败');
    onPlaybackError?.();
  };

  return (
    <div className={`relative h-full w-full bg-black ${className}`}>
      {/* 内嵌特斯拉专用播放器，无边框全屏显示 */}
      <iframe
        ref={iframeRef}
        src={playerUrl}
        title={title || '视频播放器'}
        onLoad={handleIframeLoad}
        onError={handleIframeError}
        style={{
          width: '100%',
          height: '100%',
          border: 'none',
          display: 'block',
          background: '#000',
        }}
        allow='autoplay; fullscreen'
        allowFullScreen
      />

      {/* 加载遮罩，和原项目风格保持一致 */}
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
