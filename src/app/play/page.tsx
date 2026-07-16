'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useState, useRef } from 'react';
import { X, Loader2 } from 'lucide-react';
// 只保留核心播放器组件
import PageLayout from '@/components/PageLayout'; 

export default function PlayPageClient() {
  const searchParams = useSearchParams();
  const [loading, setLoading] = useState(true);
  const [videoUrl, setVideoUrl] = useState('');
  const [sources, setSources] = useState<any[]>([]); // 你的换源列表
  const [currentSource, setCurrentSource] = useState(searchParams.get('source') || '');

  // 1. 核心：保留你的换源和 fetching 逻辑
  useEffect(() => {
    const fetchVideoData = async () => {
      setLoading(true);
      try {
        // 这里放入你原本获取视频源的 API 调用
        // const data = await getDetail(...); 
        // setSources(data.sources);
        // setVideoUrl(data.url);
      } catch (e) {
        console.error("加载失败", e);
      } finally {
        setLoading(false);
      }
    };
    fetchVideoData();
  }, [currentSource]);

  return (
    <PageLayout>
      <div className="relative w-full h-screen bg-black flex flex-col">
        {/* 顶部简单的换源菜单，保留核心功能 */}
        <div className="absolute top-0 left-0 p-4 z-10 flex gap-2">
            {sources.map((src) => (
                <button 
                    key={src.id}
                    onClick={() => setCurrentSource(src.id)}
                    className={`px-3 py-1 rounded ${currentSource === src.id ? 'bg-blue-600' : 'bg-gray-800'} text-white text-sm`}
                >
                    {src.name}
                </button>
            ))}
        </div>

        {/* 播放区域 */}
        <div className="flex-1 w-full flex items-center justify-center">
          {loading ? (
            <Loader2 className="animate-spin text-white w-10 h-10" />
          ) : (
            <video
              className="w-full h-full"
              controls
              autoPlay
              playsInline
              src={videoUrl}
            />
          )}
        </div>
      </div>
    </PageLayout>
  );
}
