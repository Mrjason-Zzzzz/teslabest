'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useState, useRef } from 'react';
import { Loader2, X } from 'lucide-react';
import PageLayout from '@/components/PageLayout';
import EpisodeSelector from '@/components/EpisodeSelector'; // 必须保留，否则无法选集
import { searchAnime, getEpisodes } from '@/lib/danmaku/api'; // 必须保留，这是搜索和获取源的核心

export default function PlayPageClient() {
  const router = useRouter();
  const searchParams = useSearchParams();
  
  // 1. 核心状态：去广告
  const customAdFilterCodeRef = useRef<string>('');

  // 2. 业务状态机：搜索 -> 解析 -> 就绪
  const [loadingStage, setLoadingStage] = useState<'searching' | 'fetching' | 'ready'>('searching');
  const [detail, setDetail] = useState<any>(null);
  const [episodes, setEpisodes] = useState<any[]>([]);
  const [currentEpisodeIndex, setCurrentEpisodeIndex] = useState(0);
  const [videoUrl, setVideoUrl] = useState('');

  // 3. 去广告代码注入 (保留原逻辑)
  useEffect(() => {
    const fetchAdFilterCode = async () => {
      const version = (window as any).RUNTIME_CONFIG?.CUSTOM_AD_FILTER_VERSION || 0;
      if (version === 0) return;
      
      try {
        const cachedCode = localStorage.getItem('custom_ad_filter_code_cache');
        if (cachedCode) customAdFilterCodeRef.current = cachedCode;

        const fullResponse = await fetch('/api/ad-filter?full=true');
        if (fullResponse.ok) {
          const { code } = await fullResponse.json();
          if (code) {
            localStorage.setItem('custom_ad_filter_code_cache', code);
            customAdFilterCodeRef.current = code;
          }
        }
      } catch (e) { console.error('广告过滤加载失败', e); }
    };
    fetchAdFilterCode();
  }, []);

  // 4. 恢复核心搜索逻辑 (这是你原本业务流的入口)
  useEffect(() => {
    const initData = async () => {
      const title = searchParams.get('title');
      if (!title) return;

      try {
        setLoadingStage('searching');
        // 搜索片源
        const searchResults = await searchAnime(title);
        if (searchResults && searchResults.length > 0) {
          const firstResult = searchResults[0];
          setDetail(firstResult);
          
          // 获取剧集和M3U8源
          setLoadingStage('fetching');
          const episodeList = await getEpisodes(firstResult.id);
          setEpisodes(episodeList);
          
          // 设置默认播放地址
          if (episodeList.length > 0) {
            setVideoUrl(episodeList[0].url);
          }
          setLoadingStage('ready');
        }
      } catch (e) {
        console.error('搜索解析失败', e);
      }
    };
    initData();
  }, [searchParams]);

  return (
    <PageLayout>
      <div className="relative w-full h-screen bg-black flex flex-col">
        {/* 顶部标题栏 */}
        <div className="absolute top-0 left-0 p-4 z-20 text-white flex justify-between w-full bg-gradient-to-b from-black/80">
            <h1 className="text-lg font-bold truncate">{detail?.title || '正在搜索...'}</h1>
            <button onClick={() => router.back()} className="p-2 bg-black/50 rounded-full"><X /></button>
        </div>

        {/* 播放与加载状态 */}
        <div className="flex-1 w-full flex items-center justify-center">
          {loadingStage !== 'ready' ? (
            <div className="flex flex-col items-center text-white">
                <Loader2 className="animate-spin w-10 h-10 mb-2" />
                <span>{loadingStage === 'searching' ? '正在搜索片源...' : '正在解析播放地址...'}</span>
            </div>
          ) : (
            <video
              className="w-full h-full max-h-screen"
              controls
              autoPlay
              playsInline
              src={videoUrl}
              onPlay={() => {
                  // 如果有去广告代码，在这里执行
                  if (customAdFilterCodeRef.current) {
                      try { eval(customAdFilterCodeRef.current); } catch(e) {}
                  }
              }}
            />
          )}
        </div>

        {/* 恢复选集面板：这是你业务的核心 */}
        {loadingStage === 'ready' && (
          <div className="absolute bottom-0 w-full p-4 bg-black/80 z-20">
              <EpisodeSelector 
                episodes={episodes} 
                currentIndex={currentEpisodeIndex}
                onChange={(index) => {
                    setCurrentEpisodeIndex(index);
                    setVideoUrl(episodes[index].url);
                }} 
              />
          </div>
        )}
      </div>
    </PageLayout>
  );
}
