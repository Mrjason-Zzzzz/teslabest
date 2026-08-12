"use client";

import {
  ChevronDown,
  ChevronUp,
  Heart,
  Loader2,
  MessageCircle,
  Play,
  RefreshCw,
  ServerOff,
  Share2,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import PageLayout from "@/components/PageLayout";
import TeslaPlayer from "@/components/TeslaPlayer";
import type {
  ShortVideoFeedResponse,
  ShortVideoMedia,
  ShortVideoResolveResponse,
  ShortVideoResolverStatus,
} from "@/lib/short-video/types";

const FEED_PAGE_SIZE = 8;

function formatCount(value?: number): string {
  if (!value) return "0";
  if (value >= 100_000_000) return `${(value / 100_000_000).toFixed(1)}亿`;
  if (value >= 10_000) return `${(value / 10_000).toFixed(1)}万`;
  return String(value);
}

function pickMedia(
  item: ShortVideoResolveResponse
): ShortVideoMedia | undefined {
  return [...item.media]
    .filter(
      (media) =>
        media.container === "hls" &&
        media.segmentFormat === "mpegts" &&
        media.videoCodec === "h264" &&
        media.audioCodec === "aac"
    )
    .sort((left, right) => {
      const leftHeight = left.height || 0;
      const rightHeight = right.height || 0;
      const leftDistance = Math.abs(leftHeight - 720);
      const rightDistance = Math.abs(rightHeight - 720);
      return (
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
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const itemRefs = useRef<Array<HTMLElement | null>>([]);
  const loadingRef = useRef(false);
  const cursorRef = useRef("");
  const hasMoreRef = useRef(true);

  const [status, setStatus] = useState<ShortVideoResolverStatus | null>(null);
  const [items, setItems] = useState<ShortVideoResolveResponse[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState("");
  const [likedIds, setLikedIds] = useState<Set<string>>(new Set());
  const [itemErrors, setItemErrors] = useState<Record<string, string>>({});

  const loadFeed = useCallback(async (reset = false) => {
    if (loadingRef.current || (!reset && !hasMoreRef.current)) return;
    loadingRef.current = true;
    reset ? setLoading(true) : setLoadingMore(true);
    setError("");
    try {
      const params = new URLSearchParams({ limit: String(FEED_PAGE_SIZE) });
      if (!reset && cursorRef.current) params.set("cursor", cursorRef.current);
      const response = await fetch(
        `/api/short-video/feed?${params.toString()}`,
        {
          cache: "no-store",
        }
      );
      const payload = (await response.json()) as ShortVideoFeedResponse & {
        error?: string;
      };
      if (!response.ok)
        throw new Error(payload.error || "短视频推荐流加载失败");

      cursorRef.current = payload.nextCursor || "";
      hasMoreRef.current = payload.hasMore;
      setItems((current) =>
        dedupeItems(reset ? payload.items : [...current, ...payload.items])
      );
      if (reset) setActiveIndex(0);
    } catch (feedError) {
      setError(
        feedError instanceof Error ? feedError.message : "短视频推荐流加载失败"
      );
    } finally {
      loadingRef.current = false;
      setLoading(false);
      setLoadingMore(false);
    }
  }, []);

  const checkStatus = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const response = await fetch("/api/short-video/resolve", {
        cache: "no-store",
      });
      const payload = (await response.json()) as ShortVideoResolverStatus & {
        error?: string;
      };
      if (!response.ok)
        throw new Error(payload.error || "无法读取短视频服务状态");
      setStatus(payload);
      if (payload.configured) await loadFeed(true);
      else setLoading(false);
    } catch (statusError) {
      setError(
        statusError instanceof Error ? statusError.message : "短视频服务不可用"
      );
      setLoading(false);
    }
  }, [loadFeed]);

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
    if (activeIndex >= items.length - 3) void loadFeed(false);
    const current = items[activeIndex];
    if (!current) return;
    try {
      localStorage.setItem("tesla_short_video_last_id", current.id);
    } catch {
      // localStorage may be unavailable in private browsing.
    }
  }, [activeIndex, items, loadFeed]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        itemRefs.current[
          Math.min(activeIndex + 1, items.length - 1)
        ]?.scrollIntoView({
          behavior: "smooth",
          block: "start",
        });
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        itemRefs.current[Math.max(activeIndex - 1, 0)]?.scrollIntoView({
          behavior: "smooth",
          block: "start",
        });
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [activeIndex, items.length]);

  const scrollTo = useCallback(
    (index: number) => {
      itemRefs.current[
        Math.max(0, Math.min(index, items.length - 1))
      ]?.scrollIntoView({
        behavior: "smooth",
        block: "start",
      });
    },
    [items.length]
  );

  const handleShare = useCallback(async (item: ShortVideoResolveResponse) => {
    const shareUrl = item.shareUrl || `https://www.douyin.com/video/${item.id}`;
    try {
      if (navigator.share) {
        await navigator.share({
          title: item.title,
          text: item.description,
          url: shareUrl,
        });
      } else {
        await navigator.clipboard.writeText(shareUrl);
      }
    } catch {
      // The user may cancel the native share sheet.
    }
  }, []);

  const activeItem = items[activeIndex];
  const pageTitle = useMemo(
    () => (activeItem ? `${activeItem.author} · ${activeIndex + 1}` : "刷视频"),
    [activeIndex, activeItem]
  );

  return (
    <PageLayout activePath="/short-video">
      <div className="relative h-[calc(100dvh-6.5rem-env(safe-area-inset-top)-env(safe-area-inset-bottom))] min-h-[420px] overflow-hidden bg-black md:h-screen">
        <div className="pointer-events-none absolute inset-x-0 top-0 z-50 flex items-center justify-center bg-gradient-to-b from-black/70 to-transparent px-4 pb-10 pt-3 text-white">
          <div className="rounded-full bg-black/35 px-4 py-1.5 text-sm font-semibold backdrop-blur">
            {pageTitle}
          </div>
        </div>

        {loading && items.length === 0 && (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-white">
            <Loader2 className="h-10 w-10 animate-spin text-green-400" />
            <p className="text-sm text-white/70">正在准备 Tesla 短视频流…</p>
          </div>
        )}

        {!loading && status && !status.configured && (
          <div className="flex h-full items-center justify-center px-6">
            <div className="max-w-md rounded-3xl border border-white/10 bg-white/5 p-7 text-center text-white shadow-2xl backdrop-blur">
              <ServerOff className="mx-auto h-12 w-12 text-amber-400" />
              <h1 className="mt-4 text-xl font-bold">
                入口已就位，解析服务待接通
              </h1>
              <p className="mt-3 text-sm leading-6 text-white/65">
                页面已经按抖音式上下刷设计，并固定使用 Tesla Canvas/WebCodecs。
                接入推荐流服务器后会自动出现持续更新的视频，不依赖昨天的测试链接。
              </p>
              <button
                type="button"
                onClick={() => void checkStatus()}
                className="mt-5 inline-flex min-h-11 items-center gap-2 rounded-full bg-green-500 px-5 py-2 text-sm font-semibold text-white active:scale-95"
              >
                <RefreshCw className="h-4 w-4" />
                重新检查
              </button>
            </div>
          </div>
        )}

        {!loading && error && items.length === 0 && (
          <div className="flex h-full items-center justify-center px-6">
            <div className="max-w-sm text-center text-white">
              <p className="text-red-300">{error}</p>
              <button
                type="button"
                onClick={() => void checkStatus()}
                className="mt-4 inline-flex min-h-11 items-center gap-2 rounded-full bg-white/10 px-5 py-2 text-sm hover:bg-white/20"
              >
                <RefreshCw className="h-4 w-4" />
                重试
              </button>
            </div>
          </div>
        )}

        {items.length > 0 && (
          <>
            <div
              ref={scrollerRef}
              className="h-full snap-y snap-mandatory overflow-y-auto overscroll-contain scroll-smooth bg-black [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
            >
              {items.map((item, index) => {
                const media = pickMedia(item);
                const isActive = index === activeIndex;
                const liked = likedIds.has(item.id);
                return (
                  <article
                    key={item.id}
                    ref={(node) => {
                      itemRefs.current[index] = node;
                    }}
                    data-index={index}
                    className="relative h-full w-full snap-start snap-always overflow-hidden bg-black"
                  >
                    {item.cover && (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={item.cover}
                        alt=""
                        className="absolute inset-0 h-full w-full scale-110 object-cover opacity-25 blur-2xl"
                      />
                    )}

                    <div className="absolute inset-0 flex items-center justify-center">
                      {isActive && media ? (
                        <TeslaPlayer
                          key={`${item.id}-${media.url}`}
                          url={media.url}
                          title={item.title}
                          poster={item.cover}
                          live={false}
                          playRecordKey={`short-video-${item.id}`}
                          onEnded={() => scrollTo(index + 1)}
                          onPlaybackError={(message) =>
                            setItemErrors((current) => ({
                              ...current,
                              [item.id]: message,
                            }))
                          }
                        />
                      ) : item.cover ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={item.cover}
                          alt={item.title}
                          className="h-full w-full object-contain"
                        />
                      ) : (
                        <div className="flex h-full w-full items-center justify-center bg-zinc-950">
                          <Play className="h-12 w-12 text-white/30" />
                        </div>
                      )}
                    </div>

                    {isActive && (!media || itemErrors[item.id]) && (
                      <div className="absolute inset-0 z-30 flex items-center justify-center bg-black/75 px-8 text-center text-sm text-red-300">
                        {itemErrors[item.id] ||
                          "该视频没有 Tesla 可播放的 H.264/AAC HLS-TS 档位"}
                      </div>
                    )}

                    <div className="pointer-events-none absolute inset-x-0 bottom-0 z-20 bg-gradient-to-t from-black via-black/55 to-transparent px-4 pb-24 pt-28 text-white md:px-8 md:pb-20">
                      <div className="max-w-[78%] md:max-w-[68%]">
                        <div className="flex items-center gap-2">
                          {item.authorAvatar && (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img
                              src={item.authorAvatar}
                              alt=""
                              className="h-9 w-9 rounded-full border border-white/30 object-cover"
                            />
                          )}
                          <span className="font-semibold">@{item.author}</span>
                        </div>
                        <p className="mt-3 line-clamp-3 text-sm leading-6 text-white/90 md:text-base">
                          {item.description || item.title}
                        </p>
                      </div>
                    </div>

                    <div className="absolute bottom-24 right-3 z-40 flex flex-col items-center gap-4 text-white md:bottom-20 md:right-7">
                      <button
                        type="button"
                        onClick={() =>
                          setLikedIds((current) => {
                            const next = new Set(current);
                            next.has(item.id)
                              ? next.delete(item.id)
                              : next.add(item.id);
                            return next;
                          })
                        }
                        className="flex min-h-12 min-w-12 flex-col items-center justify-center rounded-full bg-black/35 p-2 backdrop-blur active:scale-90"
                        aria-label="喜欢"
                      >
                        <Heart
                          className={`h-7 w-7 ${
                            liked ? "fill-red-500 text-red-500" : ""
                          }`}
                        />
                        <span className="mt-0.5 text-[10px]">
                          {formatCount(item.likeCount)}
                        </span>
                      </button>
                      <div className="flex min-h-12 min-w-12 flex-col items-center justify-center rounded-full bg-black/35 p-2 backdrop-blur">
                        <MessageCircle className="h-7 w-7" />
                        <span className="mt-0.5 text-[10px]">
                          {formatCount(item.commentCount)}
                        </span>
                      </div>
                      <button
                        type="button"
                        onClick={() => void handleShare(item)}
                        className="flex min-h-12 min-w-12 items-center justify-center rounded-full bg-black/35 p-2 backdrop-blur active:scale-90"
                        aria-label="分享"
                      >
                        <Share2 className="h-7 w-7" />
                      </button>
                    </div>
                  </article>
                );
              })}

              {loadingMore && (
                <div className="pointer-events-none sticky bottom-4 z-50 flex justify-center">
                  <div className="flex items-center gap-2 rounded-full bg-black/70 px-4 py-2 text-xs text-white backdrop-blur">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    正在加载更多
                  </div>
                </div>
              )}
            </div>

            <div className="absolute right-4 top-1/2 z-50 hidden -translate-y-1/2 flex-col gap-3 md:flex">
              <button
                type="button"
                onClick={() => scrollTo(activeIndex - 1)}
                disabled={activeIndex === 0}
                className="flex h-12 w-12 items-center justify-center rounded-full bg-black/45 text-white backdrop-blur disabled:opacity-25"
                aria-label="上一个视频"
              >
                <ChevronUp className="h-7 w-7" />
              </button>
              <button
                type="button"
                onClick={() => scrollTo(activeIndex + 1)}
                disabled={
                  activeIndex >= items.length - 1 && !hasMoreRef.current
                }
                className="flex h-12 w-12 items-center justify-center rounded-full bg-black/45 text-white backdrop-blur disabled:opacity-25"
                aria-label="下一个视频"
              >
                <ChevronDown className="h-7 w-7" />
              </button>
            </div>
          </>
        )}
      </div>
    </PageLayout>
  );
}
