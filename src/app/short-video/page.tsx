'use client';

import { ChevronDown, ChevronUp, Loader2, Play, RefreshCw } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import PageLayout from '@/components/PageLayout';
import TeslaPlayer from '@/components/TeslaPlayer';
import type {
  ShortVideoFeedResponse,
  ShortVideoMedia,
  ShortVideoResolveResponse,
  ShortVideoResolverStatus,
} from '@/lib/short-video/types';

const FEED_PAGE_SIZE = 8;
const SHORT_VIDEO_SOCIAL_UI_ENABLED = false;

function pickMedia(
  item: ShortVideoResolveResponse
): ShortVideoMedia | undefined {
  return [...item.media]
    .filter(
      (media) =>
        media.videoCodec === 'h264' &&
        media.audioCodec === 'aac' &&
        (media.container === 'mp4' ||
          (media.container === 'hls' && media.segmentFormat === 'mpegts'))
    )
    .sort((left, right) => {
      const containerPreference =
        Number(right.container === 'mp4') - Number(left.container === 'mp4');
      const leftHeight = left.height || 0;
      const rightHeight = right.height || 0;
      const leftDistance = Math.abs(leftHeight - 720);
      const rightDistance = Math.abs(rightHeight - 720);
      return (
        containerPreference ||
        leftDistance - rightDistance ||
        (right.bitrate || 0) - (left.bitrate || 0)
      );
    })[0];
}

function dedupeItems(items: ShortVideoResolveResponse[]) {
  const seen = new Set<string>();
  return items.filter((item) => {
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
}

export default function ShortVideoPage() {
  const router = useRouter();
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const itemRefs = useRef<Array<HTMLElement | null>>([]);
  const loadingRef = useRef(false);
  const cursorRef = useRef('');
  const hasMoreRef = useRef(true);
  const pendingAdvanceRef = useRef<number | null>(null);
  const consecutiveFailuresRef = useRef(0);
  const autoAdvanceTimerRef = useRef<number | null>(null);

  const [status, setStatus] = useState<ShortVideoResolverStatus | null>(null);
  const [items, setItems] = useState<ShortVideoResolveResponse[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState('');
  const [itemErrors, setItemErrors] = useState<Record<string, string>>({});

  const loadFeed = useCallback(async (reset = false) => {
    if (loadingRef.current || (!reset && !hasMoreRef.current)) return;
    loadingRef.current = true;
    reset ? setLoading(true) : setLoadingMore(true);
    setError('');
    try {
      const params = new URLSearchParams({ limit: String(FEED_PAGE_SIZE) });
      if (!reset && cursorRef.current) params.set('cursor', cursorRef.current);
      const response = await fetch(
        `/api/short-video/feed?${params.toString()}`,
        {
          cache: 'no-store',
        }
      );
      const payload = (await response.json()) as ShortVideoFeedResponse & {
        error?: string;
      };
      if (!response.ok)
        throw new Error(payload.error || '短视频推荐流加载失败');

      cursorRef.current = payload.nextCursor || '';
      hasMoreRef.current = payload.hasMore;
      setItems((current) =>
        dedupeItems(reset ? payload.items : [...current, ...payload.items])
      );
      if (reset) setActiveIndex(0);
    } catch (feedError) {
      setError(
        feedError instanceof Error ? feedError.message : '短视频推荐流加载失败'
      );
    } finally {
      loadingRef.current = false;
      setLoading(false);
      setLoadingMore(false);
    }
  }, []);

  const checkStatus = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const response = await fetch('/api/short-video/resolve', {
        cache: 'no-store',
      });
      const payload = (await response.json()) as ShortVideoResolverStatus & {
        error?: string;
      };
      if (response.status === 403) {
        router.replace('/');
        return;
      }
      if (!response.ok)
        throw new Error(payload.error || '无法读取短视频服务状态');
      setStatus(payload);
      if (payload.configured) await loadFeed(true);
      else setLoading(false);
    } catch (statusError) {
      setError(
        statusError instanceof Error ? statusError.message : '短视频服务不可用'
      );
      setLoading(false);
    }
  }, [loadFeed, router]);

  useEffect(() => {
    void checkStatus();
  }, [checkStatus]);

  useEffect(() => {
    const root = scrollerRef.current;
    if (!root || items.length === 0) return;
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((entry) => entry.isIntersecting)
          .sort(
            (left, right) => right.intersectionRatio - left.intersectionRatio
          )[0];
        if (!visible) return;
        const index = Number((visible.target as HTMLElement).dataset.index);
        if (Number.isFinite(index)) setActiveIndex(index);
      },
      { root, threshold: [0.55, 0.75, 0.9] }
    );
    itemRefs.current
      .slice(0, items.length)
      .forEach((item) => item && observer.observe(item));
    return () => observer.disconnect();
  }, [items.length]);

  useEffect(() => {
    if (
      status?.configured &&
      items.length > 0 &&
      activeIndex >= items.length - 3
    ) {
      void loadFeed(false);
    }
    const current = items[activeIndex];
    if (!current) return;
    try {
      localStorage.setItem('tesla_short_video_last_id', current.id);
    } catch {
      // localStorage may be unavailable in private browsing.
    }
  }, [activeIndex, items, loadFeed, status?.configured]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        itemRefs.current[
          Math.min(activeIndex + 1, items.length - 1)
        ]?.scrollIntoView({
          behavior: 'smooth',
          block: 'start',
        });
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        itemRefs.current[Math.max(activeIndex - 1, 0)]?.scrollIntoView({
          behavior: 'smooth',
          block: 'start',
        });
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [activeIndex, items.length]);

  const scrollTo = useCallback(
    (index: number) => {
      itemRefs.current[
        Math.max(0, Math.min(index, items.length - 1))
      ]?.scrollIntoView({
        behavior: 'smooth',
        block: 'start',
      });
    },
    [items.length]
  );

  const advanceTo = useCallback(
    async (index: number) => {
      if (index < 0) {
        scrollTo(0);
        return;
      }
      if (index < items.length) {
        scrollTo(index);
        return;
      }
      if (!hasMoreRef.current) {
        setError('推荐视频已播放完毕');
        return;
      }
      pendingAdvanceRef.current = index;
      await loadFeed(false);
    },
    [items.length, loadFeed, scrollTo]
  );

  useEffect(() => {
    const pendingIndex = pendingAdvanceRef.current;
    if (pendingIndex === null || pendingIndex >= items.length) return;
    pendingAdvanceRef.current = null;
    scrollTo(pendingIndex);
  }, [items.length, scrollTo]);

  useEffect(
    () => () => {
      if (autoAdvanceTimerRef.current) {
        window.clearTimeout(autoAdvanceTimerRef.current);
      }
    },
    []
  );

  const activeItem = items[activeIndex];
  const pageTitle = useMemo(
    () => (activeItem ? `${activeItem.author} · ${activeIndex + 1}` : '刷视频'),
    [activeIndex, activeItem]
  );

  return (
    <PageLayout activePath='/short-video'>
      <div className='relative h-[calc(100dvh-6.5rem-env(safe-area-inset-top)-env(safe-area-inset-bottom))] min-h-[420px] overflow-hidden bg-black md:h-screen'>
        <div className='pointer-events-none absolute inset-x-0 top-0 z-50 flex items-center justify-center bg-gradient-to-b from-black/70 to-transparent px-4 pb-10 pt-3 text-white'>
          <div className='rounded-full bg-black/35 px-4 py-1.5 text-sm font-semibold backdrop-blur'>
            {pageTitle}
          </div>
        </div>

        {loading && items.length === 0 && (
          <div className='flex h-full flex-col items-center justify-center gap-3 text-white'>
            <Loader2 className='h-10 w-10 animate-spin text-green-400' />
            <p className='text-sm text-white/70'>正在加载抖音推荐视频…</p>
          </div>
        )}

        {!loading && error && items.length === 0 && (
          <div className='flex h-full items-center justify-center px-6'>
            <div className='max-w-sm text-center text-white'>
              <p className='text-red-300'>{error}</p>
              <button
                type='button'
                onClick={() => void checkStatus()}
                className='mt-4 inline-flex min-h-11 items-center gap-2 rounded-full bg-white/10 px-5 py-2 text-sm hover:bg-white/20'
              >
                <RefreshCw className='h-4 w-4' />
                重试
              </button>
            </div>
          </div>
        )}

        {items.length > 0 && (
          <>
            <div
              ref={scrollerRef}
              className='h-full snap-y snap-mandatory overflow-y-auto overscroll-contain scroll-smooth bg-black [scrollbar-width:none] [&::-webkit-scrollbar]:hidden'
            >
              {items.map((item, index) => {
                const media = pickMedia(item);
                const isActive = index === activeIndex;
                return (
                  <article
                    key={item.id}
                    ref={(node) => {
                      itemRefs.current[index] = node;
                    }}
                    data-index={index}
                    data-social-ui={
                      SHORT_VIDEO_SOCIAL_UI_ENABLED ? 'enabled' : 'disabled'
                    }
                    className='relative h-full w-full snap-start snap-always overflow-hidden bg-black'
                  >
                    {item.cover && (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={item.cover}
                        alt=''
                        className='absolute inset-0 h-full w-full scale-110 object-cover opacity-25 blur-2xl'
                      />
                    )}

                    <div className='absolute inset-0 flex items-center justify-center'>
                      {isActive && media ? (
                        <TeslaPlayer
                          key={`${item.id}-${media.url}`}
                          url={media.url}
                          title={item.title}
                          poster={item.cover}
                          live={false}
                          playRecordKey={`short-video-${item.id}`}
                          onEnded={() => {
                            consecutiveFailuresRef.current = 0;
                            void advanceTo(index + 1);
                          }}
                          onPrevious={
                            index > 0
                              ? () => void advanceTo(index - 1)
                              : undefined
                          }
                          onNext={() => void advanceTo(index + 1)}
                          onPlaybackReady={() => {
                            consecutiveFailuresRef.current = 0;
                            setItemErrors((current) => {
                              if (!current[item.id]) return current;
                              const next = { ...current };
                              delete next[item.id];
                              return next;
                            });
                          }}
                          onPlaybackError={(message) => {
                            setItemErrors((current) => ({
                              ...current,
                              [item.id]: message,
                            }));
                            consecutiveFailuresRef.current += 1;
                            if (consecutiveFailuresRef.current >= 3) {
                              const stoppedMessage =
                                '连续 3 条视频加载异常，已停止自动连播';
                              setError(stoppedMessage);
                              setItemErrors((current) => ({
                                ...current,
                                [item.id]: stoppedMessage,
                              }));
                              return;
                            }
                            autoAdvanceTimerRef.current = window.setTimeout(
                              () => void advanceTo(index + 1),
                              900
                            );
                          }}
                        />
                      ) : item.cover ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={item.cover}
                          alt={item.title}
                          className='h-full w-full object-contain'
                        />
                      ) : (
                        <div className='flex h-full w-full items-center justify-center bg-zinc-950'>
                          <Play className='h-12 w-12 text-white/30' />
                        </div>
                      )}
                    </div>

                    {isActive && (!media || itemErrors[item.id]) && (
                      <div className='absolute inset-0 z-30 flex items-center justify-center bg-black/75 px-8 text-center text-sm text-red-300'>
                        {itemErrors[item.id] ||
                          '该视频没有 Tesla 可播放的 H.264/AAC 档位'}
                      </div>
                    )}

                    <div className='pointer-events-none absolute inset-x-0 bottom-0 z-20 bg-gradient-to-t from-black via-black/55 to-transparent px-4 pb-24 pt-28 text-white md:px-8 md:pb-20'>
                      <div className='max-w-[78%] md:max-w-[68%]'>
                        <div className='flex items-center gap-2'>
                          {item.authorAvatar && (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img
                              src={item.authorAvatar}
                              alt=''
                              className='h-9 w-9 rounded-full border border-white/30 object-cover'
                            />
                          )}
                          <span className='font-semibold'>@{item.author}</span>
                        </div>
                        <p className='mt-3 line-clamp-3 text-sm leading-6 text-white/90 md:text-base'>
                          {item.description || item.title}
                        </p>
                      </div>
                    </div>

                    {/* Social action data remains available in the resolver,
                        but no inactive like/comment/share controls are mounted. */}
                  </article>
                );
              })}

              {loadingMore && (
                <div className='pointer-events-none sticky bottom-4 z-50 flex justify-center'>
                  <div className='flex items-center gap-2 rounded-full bg-black/70 px-4 py-2 text-xs text-white backdrop-blur'>
                    <Loader2 className='h-4 w-4 animate-spin' />
                    正在加载更多
                  </div>
                </div>
              )}
            </div>

            <div className='absolute right-4 top-1/2 z-50 hidden -translate-y-1/2 flex-col gap-3 md:flex'>
              <button
                type='button'
                onClick={() => scrollTo(activeIndex - 1)}
                disabled={activeIndex === 0}
                className='flex h-12 w-12 items-center justify-center rounded-full bg-black/45 text-white backdrop-blur disabled:opacity-25'
                aria-label='上一个视频'
              >
                <ChevronUp className='h-7 w-7' />
              </button>
              <button
                type='button'
                onClick={() => scrollTo(activeIndex + 1)}
                disabled={
                  activeIndex >= items.length - 1 && !hasMoreRef.current
                }
                className='flex h-12 w-12 items-center justify-center rounded-full bg-black/45 text-white backdrop-blur disabled:opacity-25'
                aria-label='下一个视频'
              >
                <ChevronDown className='h-7 w-7' />
              </button>
            </div>
          </>
        )}
      </div>
    </PageLayout>
  );
}
