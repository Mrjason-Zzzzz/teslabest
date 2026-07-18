'use client';

/* eslint-disable react-hooks/exhaustive-deps */

import { useEffect } from 'react';

import { isTeslaBrowser } from '@/lib/tesla-player/hls-broadway-engine';

/**
 * Tesla 车机浏览器自动跳转到 /xxx/tesla 路由
 *
 * 行为：
 *   - 仅在特斯拉车机 UA 下生效（isTeslaBrowser()）
 *   - 用户可在 /xxx/tesla 页面点 "切回原版" 按钮，会写入 sessionStorage 标记，
 *     本组件检测到标记后不再自动跳转（直到关闭标签页）
 *   - 非 Tesla UA 不做任何事
 *
 * 用法（在原 /play、/live、/web-live、/tv/play 页面顶部插入一次）：
 *   <TeslaAutoRedirect to="/play/tesla" />
 */

const OPT_OUT_KEY = 'tesla_player_opt_out';

export function clearTeslaOptOut(): void {
  try {
    sessionStorage.removeItem(OPT_OUT_KEY);
  } catch {
    // ignore
  }
}

export function setTeslaOptOut(): void {
  try {
    sessionStorage.setItem(OPT_OUT_KEY, '1');
  } catch {
    // ignore
  }
}

export function isTeslaOptedOut(): boolean {
  try {
    return sessionStorage.getItem(OPT_OUT_KEY) === '1';
  } catch {
    return false;
  }
}

interface TeslaAutoRedirectProps {
  to: string;
  /** 额外要带的 query 参数（一般留空，自动透传当前 URL 的 query） */
  preserveQuery?: boolean;
}

export default function TeslaAutoRedirect({
  to,
  preserveQuery = true,
}: TeslaAutoRedirectProps) {
  useEffect(() => {
    if (!isTeslaBrowser()) return;
    if (isTeslaOptedOut()) return;
    if (typeof window === 'undefined') return;
    // 已在目标路由就不重复跳转
    if (window.location.pathname === to) return;

    const url = new URL(to, window.location.origin);
    if (preserveQuery) {
      const current = new URLSearchParams(window.location.search);
      current.forEach((v, k) => url.searchParams.set(k, v));
    }
    // 使用 replace 避免产生历史记录（用户点"返回"不会循环回来）
    window.location.replace(url.pathname + url.search);
  }, [to, preserveQuery]);

  return null;
}
