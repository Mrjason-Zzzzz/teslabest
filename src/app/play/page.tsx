'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useState, useRef } from 'react';
import { X, Loader2 } from 'lucide-react';
import PageLayout from '@/components/PageLayout';

export default function PlayPageClient() {
  const router = useRouter();
  const searchParams = useSearchParams();
  
  // 1. 核心状态：去广告
  const [blockAdEnabled] = useState(true);
  const customAdFilterCodeRef = useRef<string>('');

  // 2. 核心状态：播放与换源
  const [loading, setLoading] = useState(true);
  const [videoUrl, setVideoUrl] = useState('');
  const [sources, setSources] = useState<any[]>([]); 
  const [currentSource, setCurrentSource] = useState(searchParams.get('source') || '');
  const [videoTitle] = useState(searchParams.get('title') || '播放器');

  // 3. 去广告代码初始化 (完全保留原逻辑)
  useEffect(() => {
    const fetchAdFilterCode = async () => {
      if (typeof window === 'undefined') return;
      try {
        const cachedCode = localStorage.getItem('custom_ad_filter_code_cache');
        if (cachedCode) customAdFilterCodeRef.current = cachedCode;
        
        const version = (window as any).RUNTIME_CONFIG?.CUSTOM_AD_FILTER_VERSION || 0;
        if (version === 0) return;

        const fullResponse = await fetch('/api/ad-filter?full=true');
        if (fullResponse.ok) {
          const { code } = await fullResponse.json();
          if (code) {
            localStorage.setItem('custom_ad_filter_code_cache', code);
            localStorage.setItem('custom_ad_filter_version_cache', version.toString());
            customAdFilterCodeRef.current = code;
          }
        }
      } catch (error) {
        console.error('获取去广告代码配置失败:', error);
      }
    };
    fetchAdFilterCode();
  }, []);

  // 4. 加载数据 (在此处接入你原有的 API)
  useEffect(() => {
    const initPlayer = async () => {
      setLoading(true);
      // --- 在此处调用你原来的 API ---
      // const data = await getDetail(...); 
      // setSources(data.sources); 
      // setVideoUrl(data.url);
      setLoading(false);
    };
    initPlayer();
  }, [currentSource]);

  return (
    <PageLayout>
      <div className="relative w-full h-screen bg-black flex flex-col">
        {/* 顶部：标题与退出 */}
        <div className="absolute top-0 left-0 p-4 z-10 text-white flex justify-between w-full">
            <h1 className="text-lg font-bold truncate">{videoTitle}</h1>
            <button onClick={() => router.back()} className="p-2 bg-black/50 rounded-full">
                <X />
            </button>
        </div>

        {/* 播放器区域 */}
        <div className="flex-1 w-full flex items-center justify-center">
          {loading ? (
            <div className="flex flex-col items-center text-white">
                <Loader2 className="animate-spin w-10 h-10 mb-2" />
                <span>加载中...</span>
            </div>
          ) : (
            <video
              className="w-full h-full max-h-screen"
              controls
              autoPlay
              playsInline
              src={videoUrl}
            />
          )}
        </div>

        {/* 底部：换源选择器 */}
        <div className="absolute bottom-4 left-4 z-10 flex gap-2 flex-wrap">
            {sources.map((src) => (
                <button 
                    key={src.id}
                    onClick={() => setCurrentSource(src.id)}
                    className={`px-4 py-2 rounded-lg text-sm ${currentSource === src.id ? 'bg-blue-600 text-white' : 'bg-gray-800 text-gray-300'}`}
                >
                    {src.name}
                </button>
            ))}
        </div>
      </div>
    </PageLayout>
  );
}
