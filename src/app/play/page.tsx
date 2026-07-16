'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useState, useRef } from 'react';
import { Loader2, X } from 'lucide-react';
import PageLayout from '@/components/PageLayout';
import EpisodeSelector from '@/components/EpisodeSelector';

// 导入核心 API
import { searchAnime, getEpisodes } from '@/lib/danmaku/api';
import { useSite } from '@/components/SiteProvider';

export default function PlayPageClient() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { siteName } = useSite();

  // --- 1. 核心状态 ---
  const [loadingStage, setLoadingStage] = useState<'searching' | 'fetching' | 'ready'>('searching');
  const [detail, setDetail] = useState<any>(null);
  const [episodes, setEpisodes] = useState<any[]>([]);
  const [currentEpisodeIndex, setCurrentEpisodeIndex] = useState(0);
  const [videoUrl, setVideoUrl] = useState('');
  
  // --- 2. 去广告逻辑 ---
  const customAdFilterCodeRef = useRef<string>('');

  useEffect(() => {
    const fetchAdFilterCode = async () => {
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
      } catch (e) { console.error('广告过滤配置加载失败', e); }
    };
    fetchAdFilterCode();
  }, []);

  // --- 3. 搜索与初始化逻辑 (已修复类型错误) ---
  useEffect(() => {
    const initData = async () => {
      const title = searchParams.get('title');
      if (!title) return;

      try {
        setLoadingStage('searching');
        // 使用 as any 规避类型错误，直接处理搜索结果
        const searchResults: any = await searchAnime(title);
        
        // 兼容处理：检查 .results, .list, 或者直接就是数组的情况
        const items = searchResults?.results || searchResults?.list || (Array.isArray(searchResults) ? searchResults : []);

        if (items && items.length > 0) {
          const firstResult = items[0];
          setDetail(firstResult);
          
          setLoadingStage('fetching');
          const episodeList = await getEpisodes(firstResult.id);
          setEpisodes(episodeList);
          
          if (episodeList.length > 0) {
            setVideoUrl(episodeList[0].url);
          }
          setLoadingStage('ready');
        } else {
          console.error('未找到搜索结果');
          setLoadingStage('ready'); // 即使没结果也结束状态，避免死循环
        }
      } catch (e) {
        console.error('初始化播放流失败', e);
        setLoadingStage('ready');
      }
    };
    initData();
  }, [searchParams]);

  // --- 4. 界面渲染 ---
  return (
    <PageLayout>
      <div className="relative w-full h-screen bg-black flex flex-col">
        {/* 顶部标题栏 */}
        <div className="absolute top-0 left-0 p-4 z-20 text-white flex justify-between w-full bg-gradient-to-b from-black/80">
            <h1 className="text-lg font-bold truncate">{detail?.title || '正在搜索...'}</h1>
            <button onClick={() => router.back()} className="p-2 bg-black/50 rounded-full hover:bg-black">
                <X />
            </button>
        </div>

        {/* 播放器主体 */}
        <div className="flex-1 w-full flex items-center justify-center">
          {loadingStage !== 'ready' ? (
            <div className="flex flex-col items-center text-white">
                <Loader2 className="animate-spin w-10 h-10 mb-2" />
                <span>{loadingStage === 'searching' ? '搜索片源中...' : '解析M3U8中...'}</span>
            </div>
          ) : (
            <video
              className="w-full h-full max-h-screen"
              controls
              autoPlay
              playsInline
              src={videoUrl}
              onPlay={() => {
                  // 播放时注入去广告脚本
                  if (customAdFilterCodeRef.current) {
                      try { eval(customAdFilterCodeRef.current); } catch(e) {}
                  }
              }}
            />
          )}
        </div>

        {/* 选集面板 */}
        {loadingStage === 'ready' && episodes.length > 0 && (
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
