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

// --- 工具函数保持原有逻辑 ---
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

  // --- 核心：D 档保活永动机渲染引擎 ---
  const startCanvasRender = useCallback(() => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const render = () => {
      // 强制绘制：彻底移除对 video.paused 的判断，只要解码器有数据就必须渲染到 Canvas
      if (video.readyState >= 2) {
        if (canvas.width !== video.videoWidth || canvas.height !== video.videoHeight) {
          canvas.width = video.videoWidth;
          canvas.height = video.videoHeight;
        }
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      }
      animationFrameId.current = requestAnimationFrame(render);
    };

    // 启动渲染循环
    animationFrameId.current = requestAnimationFrame(render);
    
    // 心跳保活：即便被系统挂起，每 2 秒静默尝试恢复解码器
    if (!heartbeatTimer.current) {
      heartbeatTimer.current = setInterval(() => {
        if (video.paused) {
          video.play().catch(() => {});
        }
      }, 2000);
    }
  }, []);

  const stopCanvasRender = () => {
    if (animationFrameId.current) cancelAnimationFrame(animationFrameId.current);
    if (heartbeatTimer.current) clearInterval(heartbeatTimer.current);
    animationFrameId.current = null;
    heartbeatTimer.current = null;
  };

  useEffect(() => {
    const videoEl = videoRef.current;
    if (!videoEl || !url) return;

    let disposed = false;
    setLoading(true);
    setError('');
    
    // 原有资源清理逻辑
    const cleanup = () => {
      if (videoEl.hls) { videoEl.hls.destroy(); videoEl.hls = null; }
      if (videoEl.flv) { videoEl.flv.destroy(); videoEl.flv = null; }
      videoEl.removeAttribute('src');
      videoEl.load();
    };

    const attach = async () => {
      cleanup();
      // ... (此处保留你原有的 HLS/FLV attach 逻辑) ...
      // 成功加载后立即启动永动机渲染循环
      startCanvasRender();
    };

    attach();
    
    // 监听播放状态以更新 UI
    videoEl.addEventListener('play', () => setPlaying(true));
    videoEl.addEventListener('pause', () => setPlaying(false));
    videoEl.addEventListener('error', () => {
      setError('播放错误');
      stopCanvasRender();
    });

    return () => {
      disposed = true;
      stopCanvasRender();
      cleanup();
    };
  }, [url, live, startTime, adFilterEnabled, playbackRate, sourceType, startCanvasRender]);

  const toggle = () => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) video.play().catch(() => undefined);
    else video.pause();
  };

  return (
    <div className={`relative h-full w-full bg-black ${className}`}>
      {/* 隐藏的解码层：保持 h-0 w-0，对特斯拉系统隐身 */}
      <video
        ref={videoRef}
        poster={poster}
        className='absolute inset-0 h-0 w-0 opacity-0 pointer-events-none'
        playsInline
        preload='auto'
        aria-label={title || 'TV 视频播放器'}
      />
      
      {/* 投影层：Canvas 承担所有视觉展示，即使视频被挂起，Canvas 依然强力刷新 */}
      <canvas
        ref={canvasRef}
        className='absolute inset-0 h-full w-full object-contain cursor-pointer'
        onClick={toggle}
      />
      
      {/* ... (保留你原有的 UI 如 Loading, Error, Buttons) ... */}
    </div>
  );
}
