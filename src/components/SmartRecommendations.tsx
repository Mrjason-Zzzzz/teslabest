'use client';

import { useCallback, useEffect, useState } from 'react';

import {
  getRecommendationCache,
  recommendationCacheKeys,
  setRecommendationCache,
} from '@/lib/recommendations/cache';

import ScrollableRow from '@/components/ScrollableRow';
import VideoCard from '@/components/VideoCard';

interface Recommendation {
  doubanId?: string;
  title: string;
  poster: string;
  rating: string;
  mediaType?: 'movie' | 'tv';
}

interface SmartRecommendationsProps {
  doubanId?: number;
  videoTitle: string;
}

export default function SmartRecommendations({
  doubanId,
}: SmartRecommendationsProps) {
  const [recommendations, setRecommendations] = useState<Recommendation[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchDoubanRecommendations = useCallback(async () => {
    if (!doubanId) return;

    try {
      console.log('正在获取豆瓣推荐');
      setLoading(true);
      setError(null);

      const cacheKey = recommendationCacheKeys.doubanRecommendations(doubanId);
      const cached = getRecommendationCache<Recommendation[]>(cacheKey);

      if (cached) {
        console.log('使用缓存的豆瓣推荐数据');
        setRecommendations(cached);
        setLoading(false);
        return;
      }

      const response = await fetch(
        `/api/douban-recommendations?id=${doubanId}`
      );

      if (!response.ok) {
        throw new Error('获取豆瓣推荐失败');
      }

      const result = await response.json();
      const recommendationsData = result.recommendations || [];
      setRecommendations(recommendationsData);

      setRecommendationCache(cacheKey, recommendationsData);
    } catch (err) {
      console.error('获取豆瓣推荐失败:', err);
      setError(err instanceof Error ? err.message : '获取推荐失败');
    } finally {
      setLoading(false);
    }
  }, [doubanId]);

  useEffect(() => {
    if (!doubanId) {
      setRecommendations([]);
      return;
    }
    fetchDoubanRecommendations();
  }, [doubanId, fetchDoubanRecommendations]);

  if (!doubanId) {
    return null;
  }

  if (loading) {
    return (
      <div className='flex justify-center items-center py-8'>
        <div className='animate-spin rounded-full h-8 w-8 border-b-2 border-green-500'></div>
      </div>
    );
  }

  if (error || recommendations.length === 0) {
    return null;
  }

  return (
    <div className='mt-6 -mx-3 md:mx-0 md:px-4'>
      <div className='bg-white/50 dark:bg-gray-800/50 backdrop-blur-sm rounded-xl border border-gray-200/50 dark:border-gray-700/50 overflow-hidden'>
        {/* 标题 */}
        <div className='px-3 md:px-6 py-4 border-b border-gray-200 dark:border-gray-700'>
          <h3 className='text-lg font-semibold text-gray-900 dark:text-white flex items-center gap-2'>
            <svg className='w-5 h-5' fill='currentColor' viewBox='0 0 24 24'>
              <path d='M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z' />
            </svg>
            更多推荐
          </h3>
        </div>

        {/* 推荐内容 */}
        <div className='px-3 pt-3 md:px-6 md:pt-6'>
          <ScrollableRow scrollDistance={600} bottomPadding='pb-2'>
            {recommendations.map((rec, index) => (
              <div
                key={rec.doubanId || index}
                className='min-w-[96px] w-24 sm:min-w-[140px] sm:w-[140px]'
              >
                <VideoCard
                  title={rec.title}
                  poster={rec.poster}
                  rate={rec.rating}
                  douban_id={rec.doubanId ? parseInt(rec.doubanId) : undefined}
                  from='douban'
                />
              </div>
            ))}
          </ScrollableRow>
        </div>
      </div>
    </div>
  );
}
