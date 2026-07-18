'use client';

/* eslint-disable @next/next/no-img-element, @typescript-eslint/no-explicit-any */

import { useMemo } from 'react';

import { isTeslaBrowser } from '@/lib/tesla-player/hls-broadway-engine';

/**
 * Tesla 版入口按钮
 *
 * 行为：
 *   - 在特斯拉车机浏览器中：始终展示，点击跳到对应 /xxx/tesla 路由
 *   - 在普通浏览器中：默认不展示，传入 forceShow 时展示
 *
 * 用法：
 *   <TeslaEntryButton kind="play" params={{ source, id, title }} />
 *   <TeslaEntryButton kind="live" params={{ source, id }} />
 *   <TeslaEntryButton kind="web-live" params={{ platform, roomId }} />
 *   <TeslaEntryButton kind="tv" params={{ source, id, title, index }} />
 */

interface TeslaEntryButtonProps {
  kind: 'play' | 'live' | 'web-live' | 'tv';
  params?: Record<string, string | number | undefined | null>;
  forceShow?: boolean;
  label?: string;
  className?: string;
}

const ROUTE_MAP: Record<TeslaEntryButtonProps['kind'], string> = {
  play: '/play/tesla',
  live: '/live/tesla',
  'web-live': '/web-live/tesla',
  tv: '/tv/play/tesla',
};

export default function TeslaEntryButton({
  kind,
  params = {},
  forceShow = false,
  label = 'Tesla 版',
  className = '',
}: TeslaEntryButtonProps) {
  const href = useMemo(() => {
    const url = new URL(ROUTE_MAP[kind], typeof window !== 'undefined' ? window.location.origin : 'http://localhost');
    Object.entries(params).forEach(([k, v]) => {
      if (v != null && v !== '') url.searchParams.set(k, String(v));
    });
    return url.pathname + url.search;
  }, [kind, params]);

  // SSR 期间不展示，避免误判
  if (typeof window === 'undefined') return null;
  if (!forceShow && !isTeslaBrowser()) return null;

  return (
    <a
      href={href}
      className={`inline-flex items-center gap-1 rounded-md border border-rose-500/40 bg-rose-500/10 px-2 py-1 text-xs font-medium text-rose-300 transition-colors hover:bg-rose-500/20 ${className}`}
      title="使用 Tesla Canvas 播放器（Broadway.js + YUVCanvas，不依赖 <video>）"
    >
      <span className="inline-block h-1.5 w-1.5 rounded-full bg-rose-400" />
      {label}
    </a>
  );
}
