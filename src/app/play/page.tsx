'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useState, useRef } from 'react';
import { X } from 'lucide-react'; // 仅保留必要的图标

export default function PlayPageClient() {
  const router = useRouter();
  const searchParams = useSearchParams();
  
  // 核心状态：只保留播放必要的
  const [loading, setLoading] = useState(true);
  const [videoTitle] = useState(searchParams.get('title') || '播放器');
  
  // 核心引用：保持播放器的引用
  const videoRef = useRef<HTMLVideoElement>(null);

  // 初始化：模拟播放器就绪，跳过所有多余的初始化检查
  useEffect(() => {
    setLoading(false);
    document.title = videoTitle;
  }, [videoTitle]);

  // 核心功能：键盘控制（倍速、快进、全屏）
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const video = videoRef.current;
      if (!video) return;

      switch (e.key) {
        case ' ': // 播放/暂停
          e.preventDefault();
          video.paused ? video.play() : video.pause();
          break;
        case 'ArrowRight': // 快进
          video.currentTime += 10;
          break;
        case 'ArrowLeft': // 快退
          video.currentTime -= 10;
          break;
        case 'f': // 全屏
        case 'F':
          if (document.fullscreenElement) {
            document.exitFullscreen();
          } else {
            video.requestFullscreen().catch(console.error);
          }
          break;
        case '+': // 倍速增加
          video.playbackRate = Math.min(video.playbackRate + 0.25, 4);
          break;
        case '-': // 倍速减少
          video.playbackRate = Math.max(video.playbackRate - 0.25, 0.5);
          break;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  return (
    <div className="relative w-full h-screen bg-black flex flex-col">
      {/* 顶部简单的标题栏 (可按需删减) */}
      <div className="absolute top-0 left-0 p-4 text-white z-10">
        <h1 className="text-lg font-bold">{videoTitle}</h1>
      </div>

      {/* 播放器核心区域 */}
      <div className="flex-1 w-full flex items-center justify-center">
        {loading ? (
          <div className="text-white">加载中...</div>
        ) : (
          <video
            ref={videoRef}
            className="w-full h-full max-h-screen"
            controls
            autoPlay
            playsInline
            src={searchParams.get('url') || ''} // 假设URL通过参数传入
          />
        )}
      </div>

      {/* 退出按钮 */}
      <button 
        onClick={() => router.back()}
        className="absolute top-4 right-4 p-2 bg-black/50 text-white rounded-full z-10"
      >
        <X />
      </button>
    </div>
  );
}
