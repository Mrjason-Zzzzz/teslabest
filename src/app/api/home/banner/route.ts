/* eslint-disable @typescript-eslint/no-explicit-any, no-console */

import { NextResponse } from 'next/server';

import { fetchDoubanData } from '@/lib/douban';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const CACHE_DURATION = 3 * 60 * 60 * 1000;
let bannerCache: { data: unknown; timestamp: number } | null = null;

interface DoubanHotMovie {
  id: string;
  title: string;
  card_subtitle?: string;
  pic?: { large?: string; normal?: string };
  rating?: { value?: number };
}

export async function GET() {
  if (bannerCache && Date.now() - bannerCache.timestamp < CACHE_DURATION) {
    return NextResponse.json(bannerCache.data, {
      headers: {
        'Cache-Control': 'public, s-maxage=10800, stale-while-revalidate=86400',
      },
    });
  }

  try {
    // One list request is materially faster than fetching five detail pages.
    // The carousel only needs title, cover, year, rating and coarse genres.
    const url =
      'https://m.douban.com/rexxar/api/v2/subject/recent_hot/movie?start=0&limit=8&category=%E7%83%AD%E9%97%A8&type=%E5%85%A8%E9%83%A8';
    const data = await fetchDoubanData<{ items?: DoubanHotMovie[] }>(url);
    const list = (data.items || [])
      .map((movie) => {
        const subtitle = movie.card_subtitle || '';
        const sections = subtitle.split('/').map((item) => item.trim());
        const year = sections.find((item) => /^\d{4}$/.test(item)) || '';
        const genres = sections
          .filter((item) => item && item !== year && !item.includes('中国'))
          .flatMap((item) => item.split(/\s+/))
          .filter(Boolean)
          .slice(0, 3);
        const image = movie.pic?.large || movie.pic?.normal || '';
        return {
          id: movie.id,
          title: movie.title,
          backdrop_path: image,
          poster_path: image,
          release_date: year,
          overview: subtitle,
          vote_average: movie.rating?.value || 0,
          media_type: 'movie' as const,
          genres,
        };
      })
      .filter((item) => item.title && item.backdrop_path);

    const result = { code: 200, list, source: 'Douban' };
    bannerCache = { data: result, timestamp: Date.now() };
    return NextResponse.json(result, {
      headers: {
        'Cache-Control': 'public, s-maxage=10800, stale-while-revalidate=86400',
      },
    });
  } catch (error) {
    console.error('[HomeBanner] Douban request failed:', error);
    if (bannerCache) return NextResponse.json(bannerCache.data);
    return NextResponse.json(
      { code: 502, list: [], source: 'Douban', message: '轮播数据暂时不可用' },
      { status: 502 }
    );
  }
}
