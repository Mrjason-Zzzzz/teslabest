/* eslint-disable @typescript-eslint/no-explicit-any */

'use client';

import {
  Blend,
  Cat,
  Clapperboard,
  Clover,
  Container,
  Crown,
  Film,
  Globe,
  Home,
  Menu,
  Search,
  Star,
  Tv,
  TvMinimalPlay,
  Users,
} from 'lucide-react';
import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useState,
} from 'react';

import { getAuthInfoFromBrowserCookie } from '@/lib/auth';

import { useSite } from './SiteProvider';
import { useWatchRoomContextSafe } from './WatchRoomProvider';

interface SidebarContextType {
  isCollapsed: boolean;
}

const SidebarContext = createContext<SidebarContextType>({
  isCollapsed: false,
});

export const useSidebar = () => useContext(SidebarContext);

// 可替换为你自己的 logo 图片
const Logo = () => {
  const { siteName } = useSite();
  return (
    <Link
      href='/'
      className='flex items-center justify-center h-16 select-none hover:opacity-80 transition-opacity duration-200'
    >
      <span className='text-2xl font-bold text-violet-600 tracking-tight'>
        {siteName}
      </span>
    </Link>
  );
};

interface SidebarProps {
  onToggle?: (collapsed: boolean) => void;
  activePath?: string;
}

interface SidebarMembershipInfo {
  planLabel: string;
  status: 'active' | 'disabled';
  expiresAt: number | null;
  remainingDays: number | null;
  isExpired: boolean;
  renewalMessage: string;
}

function formatMembershipDate(timestamp: number): string {
  const date = new Date(timestamp);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(
    date.getDate()
  )}`;
}

// 在浏览器环境下通过全局变量缓存折叠状态，避免组件重新挂载时出现初始值闪烁
declare global {
  interface Window {
    __sidebarCollapsed?: boolean;
    RUNTIME_CONFIG?: {
      EnableComments?: boolean;
      RecommendationDataSource?: string;
      [key: string]: any;
    };
  }
}

const Sidebar = ({ onToggle, activePath = '/' }: SidebarProps) => {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const watchRoomContext = useWatchRoomContextSafe();
  const [membership, setMembership] = useState<SidebarMembershipInfo | null>(
    null
  );
  const [showMembershipCard, setShowMembershipCard] = useState(false);

  const loadMembership = useCallback(async () => {
    const auth = getAuthInfoFromBrowserCookie();
    if (!auth?.username || auth.role !== 'user') {
      setShowMembershipCard(false);
      setMembership(null);
      return;
    }

    setShowMembershipCard(true);
    try {
      const response = await fetch('/api/user/account-access', {
        cache: 'no-store',
        credentials: 'same-origin',
      });
      if (!response.ok) return;
      setMembership((await response.json()) as SidebarMembershipInfo);
    } catch {
      // 会员卡是信息展示，请求失败不应阻塞导航。
    }
  }, []);

  useEffect(() => {
    void loadMembership();
    const handleFocus = () => void loadMembership();
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') void loadMembership();
    };
    window.addEventListener('focus', handleFocus);
    document.addEventListener('visibilitychange', handleVisibility);
    return () => {
      window.removeEventListener('focus', handleFocus);
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, [loadMembership]);

  // 若同一次 SPA 会话中已经读取过折叠状态，则直接复用，避免闪烁
  const [isCollapsed, setIsCollapsed] = useState<boolean>(() => {
    if (
      typeof window !== 'undefined' &&
      typeof window.__sidebarCollapsed === 'boolean'
    ) {
      return window.__sidebarCollapsed;
    }
    return false; // 默认展开
  });

  // Tesla updates can expose a desktop display as a 720–899px CSS viewport.
  // Keep navigation touchable without consuming the player/source workspace.
  // This is based on usable viewport geometry, not on a fragile user-agent.
  const [isCockpitViewport, setIsCockpitViewport] = useState(() =>
    typeof window !== 'undefined' &&
    window.matchMedia(
      '(min-width: 720px) and (max-width: 899px) and (max-height: 720px)'
    ).matches
  );

  useEffect(() => {
    const query = window.matchMedia(
      '(min-width: 720px) and (max-width: 899px) and (max-height: 720px)'
    );
    const update = () => setIsCockpitViewport(query.matches);
    update();
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);

  const effectiveCollapsed = isCollapsed || isCockpitViewport;

  // 首次挂载时读取 localStorage，以便刷新后仍保持上次的折叠状态
  useLayoutEffect(() => {
    const saved = localStorage.getItem('sidebarCollapsed');
    if (saved !== null) {
      const val = JSON.parse(saved);
      setIsCollapsed(val);
      window.__sidebarCollapsed = val;
    }
  }, []);

  // 当折叠状态变化时，同步到 <html> data 属性，供首屏 CSS 使用
  useLayoutEffect(() => {
    if (typeof document !== 'undefined') {
      if (isCollapsed) {
        document.documentElement.dataset.sidebarCollapsed = 'true';
      } else {
        delete document.documentElement.dataset.sidebarCollapsed;
      }
    }
  }, [isCollapsed]);

  const [active, setActive] = useState(activePath);

  useEffect(() => {
    // 立即根据当前路径更新状态，不等待页面加载
    const getCurrentFullPath = () => {
      const queryString = searchParams.toString();
      return queryString ? `${pathname}?${queryString}` : pathname;
    };
    const fullPath = getCurrentFullPath();
    setActive(fullPath);
  }, [pathname, searchParams]);

  const handleToggle = useCallback(() => {
    const newState = !isCollapsed;
    setIsCollapsed(newState);
    localStorage.setItem('sidebarCollapsed', JSON.stringify(newState));
    if (typeof window !== 'undefined') {
      window.__sidebarCollapsed = newState;
    }
    onToggle?.(newState);
  }, [isCollapsed, onToggle]);

  const contextValue = {
    isCollapsed: effectiveCollapsed,
  };

  const [menuItems, setMenuItems] = useState([
    {
      icon: Film,
      label: '电影',
      href: '/douban?type=movie',
    },
    {
      icon: Tv,
      label: '剧集',
      href: '/douban?type=tv',
    },
    {
      icon: Cat,
      label: '动漫',
      href: '/douban?type=anime',
    },
    {
      icon: Clover,
      label: '综艺',
      href: '/douban?type=show',
    },
  ]);

  useEffect(() => {
    const runtimeConfig = (window as any).RUNTIME_CONFIG;

    // 基础菜单项（不包括观影室）
    const items = [
      {
        icon: Film,
        label: '电影',
        href: '/douban?type=movie',
      },
      {
        icon: Tv,
        label: '剧集',
        href: '/douban?type=tv',
      },
      {
        icon: Cat,
        label: '动漫',
        href: '/douban?type=anime',
      },
      {
        icon: Clover,
        label: '综艺',
        href: '/douban?type=show',
      },
      ...(runtimeConfig?.LIVE_ENABLED
        ? [
            {
              icon: TvMinimalPlay,
              label: '电视直播',
              href: '/live',
            },
          ]
        : []),
      ...(runtimeConfig?.SHORT_VIDEO_ENABLED
        ? [
            {
              icon: Clapperboard,
              label: '刷视频',
              href: '/short-video',
            },
          ]
        : []),
    ];

    // 如果启用网络直播，添加网络直播入口
    if (runtimeConfig?.WEB_LIVE_ENABLED) {
      items.push({
        icon: Globe,
        label: '网络直播',
        href: '/web-live',
      });
    }

    // 如果配置了 OpenList 或 Emby，添加私人影库入口
    if (runtimeConfig?.PRIVATE_LIBRARY_ENABLED) {
      items.push({
        icon: Container,
        label: '私人影库',
        href: '/private-library',
      });
    }

    if (runtimeConfig?.ADVANCED_RECOMMENDATION_ENABLED) {
      items.push({
        icon: Blend,
        label: '高级推荐',
        href: '/advanced-recommendation',
      });
    }

    // 如果启用观影室，添加观影室入口
    if (watchRoomContext?.isEnabled) {
      items.push({
        icon: Users,
        label: '观影室',
        href: '/watch-room',
      });
    }

    // 添加自定义分类（如果有）
    if (runtimeConfig?.CUSTOM_CATEGORIES?.length > 0) {
      items.push({
        icon: Star,
        label: '自定义',
        href: '/douban?type=custom',
      });
    }

    setMenuItems(items);
  }, [watchRoomContext?.isEnabled]);

  if (pathname === '/watch-room/screen') {
    return null;
  }

  return (
    <SidebarContext.Provider value={contextValue}>
      {/* 在移动端隐藏侧边栏 */}
      <div className='hidden md:flex'>
        <aside
          data-sidebar
          className={`tesla-sidebar fixed top-0 left-0 h-screen bg-white/40 backdrop-blur-xl transition-all duration-300 border-r border-gray-200/50 z-10 shadow-lg dark:bg-gray-900/70 dark:border-gray-700/50 ${
            effectiveCollapsed ? 'w-16' : 'w-64'
          }`}
          style={{
            backdropFilter: 'blur(20px)',
            WebkitBackdropFilter: 'blur(20px)',
          }}
        >
          <div className='flex h-full flex-col'>
            {/* 顶部 Logo 区域 */}
            <div className='tesla-sidebar-brand relative h-12'>
              <div
                className={`absolute inset-0 flex items-center justify-center transition-opacity duration-200 ${
                  effectiveCollapsed ? 'opacity-0' : 'opacity-100'
                }`}
              >
                <div className='w-[calc(100%-4rem)] flex justify-center'>
                  {!effectiveCollapsed && <Logo />}
                </div>
              </div>
              <button
                onClick={handleToggle}
                className={`tesla-sidebar-toggle absolute top-1/2 -translate-y-1/2 flex items-center justify-center w-8 h-8 rounded-lg text-gray-500 hover:text-gray-700 hover:bg-gray-100/50 transition-colors duration-200 z-10 dark:text-gray-400 dark:hover:text-gray-200 dark:hover:bg-gray-700/50 ${
                  effectiveCollapsed ? 'left-1/2 -translate-x-1/2' : 'right-2'
                }`}
              >
                <Menu className='h-4 w-4' />
              </button>
            </div>

            {/* 首页和搜索导航 */}
            <nav className='tesla-sidebar-primary-nav px-2 mt-2 space-y-1'>
              <Link
                href='/'
                prefetch={false}
                onClick={(e) => {
                  // 确保点击事件立即生效，不被其他状态更新阻塞
                  e.currentTarget.blur();
                }}
                data-active={active === '/'}
                className={`tesla-sidebar-nav-link group flex items-center rounded-xl px-3 py-2.5 pl-4 text-gray-700 hover:bg-violet-50 hover:text-violet-600 data-[active=true]:bg-violet-500/15 data-[active=true]:text-violet-700 font-medium transition-colors duration-200 min-h-[44px] dark:text-gray-300 dark:hover:text-violet-300 dark:data-[active=true]:bg-violet-500/15 dark:data-[active=true]:text-violet-300 ${
                  effectiveCollapsed ? 'w-full max-w-none mx-0' : 'mx-0'
                } gap-3 justify-start`}
              >
                <div className='w-4 h-4 flex items-center justify-center'>
                  <Home className='h-4 w-4 text-gray-500 group-hover:text-violet-600 data-[active=true]:text-violet-700 dark:text-gray-400 dark:group-hover:text-violet-300 dark:data-[active=true]:text-violet-300' />
                </div>
                {(!effectiveCollapsed || isCockpitViewport) && (
                  <span className='whitespace-nowrap transition-opacity duration-200 opacity-100'>
                    首页
                  </span>
                )}
              </Link>
              <Link
                href='/search'
                data-active={active === '/search'}
                className={`tesla-sidebar-nav-link group flex items-center rounded-xl px-3 py-2.5 pl-4 text-gray-700 hover:bg-violet-50 hover:text-violet-600 data-[active=true]:bg-violet-500/15 data-[active=true]:text-violet-700 font-medium transition-colors duration-200 min-h-[44px] dark:text-gray-300 dark:hover:text-violet-300 dark:data-[active=true]:bg-violet-500/15 dark:data-[active=true]:text-violet-300 ${
                  effectiveCollapsed ? 'w-full max-w-none mx-0' : 'mx-0'
                } gap-3 justify-start`}
              >
                <div className='w-4 h-4 flex items-center justify-center'>
                  <Search className='h-4 w-4 text-gray-500 group-hover:text-violet-600 data-[active=true]:text-violet-700 dark:text-gray-400 dark:group-hover:text-violet-300 dark:data-[active=true]:text-violet-300' />
                </div>
                {(!effectiveCollapsed || isCockpitViewport) && (
                  <span className='whitespace-nowrap transition-opacity duration-200 opacity-100'>
                    搜索
                  </span>
                )}
              </Link>
            </nav>

            {/* 菜单项 */}
            <div className='flex-1 overflow-y-auto px-2 pt-4'>
              <div className='space-y-1'>
                {menuItems.map((item) => {
                  // 检查当前路径是否匹配这个菜单项
                  const typeMatch = item.href.match(/type=([^&]+)/)?.[1];

                  // 解码URL以进行正确的比较
                  const decodedActive = decodeURIComponent(active);
                  const decodedItemHref = decodeURIComponent(item.href);

                  // 提取路径名（不包含查询参数）
                  const activePathname = decodedActive.split('?')[0];
                  const itemPathname = decodedItemHref.split('?')[0];

                  const isActive =
                    decodedActive === decodedItemHref ||
                    (decodedActive.startsWith('/douban') &&
                      decodedActive.includes(`type=${typeMatch}`)) ||
                    // 对于没有type参数的路径，只比较路径名
                    (!typeMatch && activePathname === itemPathname);
                  const Icon = item.icon;
                  return (
                    <Link
                      key={item.label}
                      href={item.href}
                      data-active={isActive}
                      className={`tesla-sidebar-nav-link group flex items-center rounded-xl px-3 py-2.5 pl-4 text-sm text-gray-700 hover:bg-violet-50 hover:text-violet-600 data-[active=true]:bg-violet-500/15 data-[active=true]:text-violet-700 transition-colors duration-200 min-h-[44px] dark:text-gray-300 dark:hover:text-violet-300 dark:data-[active=true]:bg-violet-500/15 dark:data-[active=true]:text-violet-300 ${
                        effectiveCollapsed ? 'w-full max-w-none mx-0' : 'mx-0'
                      } gap-3 justify-start`}
                    >
                      <div className='w-4 h-4 flex items-center justify-center'>
                        <Icon className='h-4 w-4 text-gray-500 group-hover:text-violet-600 data-[active=true]:text-violet-700 dark:text-gray-400 dark:group-hover:text-violet-300 dark:data-[active=true]:text-violet-300' />
                      </div>
                      {(!effectiveCollapsed || isCockpitViewport) && (
                        <span className='whitespace-nowrap transition-opacity duration-200 opacity-100'>
                          {item.label}
                        </span>
                      )}
                    </Link>
                  );
                })}
              </div>
            </div>

            {showMembershipCard && (
              <div className='px-2 pb-3 pt-2'>
                {effectiveCollapsed ? (
                  <div
                    className={`mx-auto flex h-11 w-11 items-center justify-center rounded-xl border shadow-sm ${
                      membership?.status === 'disabled' || membership?.isExpired
                        ? 'border-red-300 bg-red-50 text-red-600 dark:border-red-700 dark:bg-red-950/50 dark:text-red-300'
                        : 'border-amber-300 bg-amber-50 text-amber-600 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-300'
                    }`}
                    title={
                      membership
                        ? membership.expiresAt === null
                          ? `${membership.planLabel} · 永久有效`
                          : `${membership.planLabel} · 剩余 ${
                              membership.remainingDays ?? 0
                            } 天`
                        : '正在读取会员信息'
                    }
                  >
                    <Crown className='h-5 w-5' />
                  </div>
                ) : (
                  <div
                    className={`rounded-2xl border px-3.5 py-3 shadow-sm backdrop-blur-sm ${
                      membership?.status === 'disabled' || membership?.isExpired
                        ? 'border-red-300 bg-red-50/95 dark:border-red-700 dark:bg-red-950/55'
                        : 'border-amber-300 bg-amber-50/95 dark:border-amber-700 dark:bg-amber-950/45'
                    }`}
                  >
                    <div className='flex items-center gap-2 text-sm font-bold text-gray-900 dark:text-gray-100'>
                      <Crown
                        className={`h-4 w-4 ${
                          membership?.status === 'disabled' ||
                          membership?.isExpired
                            ? 'text-red-600 dark:text-red-300'
                            : 'text-amber-600 dark:text-amber-300'
                        }`}
                      />
                      <span>我的会员</span>
                    </div>
                    {membership ? (
                      <>
                        <div className='mt-2 text-sm font-semibold text-gray-800 dark:text-gray-100'>
                          {membership.planLabel}
                          {membership.status === 'disabled'
                            ? ' · 已停用'
                            : membership.isExpired
                            ? ' · 已到期'
                            : ''}
                        </div>
                        <div className='mt-1 text-xs leading-5 text-gray-700 dark:text-gray-300'>
                          {membership.expiresAt === null
                            ? '永久有效'
                            : `有效至 ${formatMembershipDate(
                                membership.expiresAt
                              )} · 剩余 ${membership.remainingDays ?? 0} 天`}
                        </div>
                        {typeof membership.expiresAt === 'number' &&
                          membership.renewalMessage && (
                            <div className='mt-1.5 text-[11px] font-medium leading-4 text-amber-800 dark:text-amber-200'>
                              {membership.renewalMessage}
                            </div>
                          )}
                      </>
                    ) : (
                      <div className='mt-2 text-xs text-gray-600 dark:text-gray-300'>
                        正在读取服务端会员状态…
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        </aside>
        <div
          className={`tesla-sidebar-offset transition-all duration-300 sidebar-offset ${
            effectiveCollapsed ? 'w-16' : 'w-64'
          }`}
        ></div>
      </div>
    </SidebarContext.Provider>
  );
};

export default Sidebar;
