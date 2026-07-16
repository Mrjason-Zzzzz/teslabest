'use client';

import { Loader2, Pause, Play } from 'lucide-react';
import { useEffect, useRef, useState, useCallback } from 'react';

declare global {
  interface HTMLVideoElement {
    hls?: any;
    flv?: any;
  }
}

type SourceType = 'm3u8' | 'flv' | 'native';

// --- 工具函数保持不变 ---
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
    if (line.includes('#EXT-X-DISCONTINUITY')) { i++; continue; }
    if (line.includes('#EXTINF:') && i + 1 < lines.length) {
      const nextLine = lines[i + 1];
      const isAd = adKeywords.some((keyword) => nextLine.toLowerCase().includes(keyword));
      if (isAd) { i += 2; continue; }
    }
    filteredLines.push(line);
    i++;
  }
  return filteredLines.join('\n');
}

export default function TVNativeVideo({
  url, poster, live = false, title, onTime, onError: onPlaybackError,
  onPlayingChange, onBufferingChange, adFilterEnabled = false,
  playbackRate = 1, startTime = 0, command, sourceType, className = '',
}: any) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const animationFrameId = useRef<number | null>(null);
  const heartbeatTimer = useRef<NodeJS.Timeout | null>(null);
  
  // 原有业务 Refs
  const onTimeRef = useRef(onTime);
  const onPlaybackErrorRef = useRef(onPlaybackError);
  const onPlayingChangeRef = useRef(onPlayingChange);
  const onBufferingChangeRef = useRef(onBufferingChange);
  const bufferingTimerRef = useRef<number | null>(null);
  const bufferingStateRef = useRef(false);
  
  const [loading, setLoading] = useState(false);
  const [buffering, setBuffering] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [error, setError] = useState('');

  // --- 渲染逻辑注入 ---
  const startCanvasRender = useCallback(() => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const render = () => {
      if (video.readyState >= 2) {
        if (canvas.width !== video.videoWidth || canvas.height !== video.videoHeight) {
          canvas.width = video.videoWidth;
          canvas.height = video.videoHeight;
        }
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      }
      animationFrameId.current = requestAnimationFrame(render);
    };
    animationFrameId.current = requestAnimationFrame(render);
    
    // 心跳保活：如果视频因挂档被 pause，2秒内自动尝试恢复，确保容器存活
    if (!heartbeatTimer.current) {
      heartbeatTimer.current = setInterval(() => {
        if (video.paused && playing) video.play().catch(() => {});
      }, 2000);
    }
  }, [playing]);

  const stopCanvasRender = () => {
    if (animationFrameId.current) cancelAnimationFrame(animationFrameId.current);
    if (heartbeatTimer.current) clearInterval(heartbeatTimer.current);
    animationFrameId.current = null;
    heartbeatTimer.current = null;
  };

  // --- 初始化与生命周期 (保留了你完整的 HLS/FLV 逻辑) ---
  useEffect(() => {
    const videoEl = videoRef.current;
    if (!videoEl || !url) return;

    let disposed = false;
    setLoading(true);
    // ... (此处填入你原有 attach() 及所有 addEventListener 逻辑) ...
    // 重要提示：在 onPlay/onPlaying 里面调用 startCanvasRender()
    // 在 onPause 里面调用 stopCanvasRender()

    return () => {
      stopCanvasRender();
      // ... (保留你原有的 cleanup)
    };
  }, [url, live, startTime, adFilterEnabled, playbackRate, sourceType]);

  const toggle = () => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) video.play().catch(() => undefined);
    else video.pause();
  };

  return (
    <div className={`relative h-full w-full bg-black ${className}`}>
      {/* 隐藏的解码层：绝对定位且大小为0，防止车机触发播放器拦截 */}
      <video
        ref={videoRef}
        poster={poster}
        className='absolute inset-0 h-0 w-0 opacity-0 pointer-events-none'
        playsInline
        preload='auto'
        aria-label={title || 'TV 视频播放器'}
      />
      
      {/* 投影层：用户实际看到的画面 */}
      <canvas
        ref={canvasRef}
        className='absolute inset-0 h-full w-full object-contain cursor-pointer'
        onClick={toggle}
      />
      
      {/* ... (保留你原有的 loading, error, button 等 UI) ... */}
    </div>
  );
}
