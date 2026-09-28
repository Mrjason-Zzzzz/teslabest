export const WEB_LIVE_PLATFORMS = ['douyin', 'huya', 'bilibili'] as const;

export type WebLivePlatform = (typeof WEB_LIVE_PLATFORMS)[number];

const PLATFORM_LABELS: Record<WebLivePlatform, string> = {
  douyin: '抖音',
  huya: '虎牙',
  bilibili: '哔哩哔哩',
};

export function detectWebLivePlatform(value: string): WebLivePlatform | null {
  try {
    const host = new URL(value).hostname.toLowerCase();
    if (host === 'v.douyin.com' || host.endsWith('.douyin.com'))
      return 'douyin';
    if (host === 'huya.com' || host.endsWith('.huya.com')) return 'huya';
    if (host === 'bilibili.com' || host.endsWith('.bilibili.com'))
      return 'bilibili';
  } catch {
    // A bare room id is valid and keeps the manually selected platform.
  }
  return null;
}

export function normalizeWebLiveSource(
  platformValue: unknown,
  roomValue: unknown
) {
  let platform = String(platformValue || '')
    .trim()
    .toLowerCase() as WebLivePlatform;
  let roomId = String(roomValue || '').trim();
  const detected = detectWebLivePlatform(roomId);
  if (detected) platform = detected;
  if (!WEB_LIVE_PLATFORMS.includes(platform)) {
    throw new Error('目前仅支持虎牙、哔哩哔哩和抖音直播');
  }

  if (/^https?:\/\//i.test(roomId)) {
    const parsed = new URL(roomId);
    const segments = parsed.pathname.split('/').filter(Boolean);
    const roomSegments = segments.filter((part) => part !== 'live');
    roomId =
      parsed.searchParams.get('room_id') ||
      parsed.searchParams.get('roomid') ||
      parsed.searchParams.get('cid') ||
      roomSegments[roomSegments.length - 1] ||
      '';
  }
  roomId = roomId.replace(/[?#/].*$/, '').trim();
  if (!roomId || roomId.length > 128) throw new Error('直播间 ID 或链接无效');
  return { platform, roomId };
}

function isHttpRedirect(response: Response): boolean {
  return response.status >= 300 && response.status < 400;
}

/**
 * Resolves only public share URLs for the platforms we already support. The
 * redirect walk is deliberately manual: following an arbitrary Location would
 * turn this utility into an SSRF primitive. A final URL must remain on the
 * same supported platform and the loop is short and time-bounded.
 */
export async function resolvePublicWebLiveSource(value: string) {
  const initial = String(value || '').trim();
  const initialPlatform = detectWebLivePlatform(initial);
  if (!initialPlatform) {
    throw new Error('请粘贴抖音、虎牙或哔哩哔哩的公开直播间链接');
  }

  let current = new URL(initial);
  const mustResolveShortLink = current.hostname.toLowerCase() === 'v.douyin.com';
  if (!mustResolveShortLink) return normalizeWebLiveSource(initialPlatform, current.toString());

  for (let hop = 0; hop < 4; hop += 1) {
    const response = await fetch(current, {
      method: 'GET',
      redirect: 'manual',
      signal: AbortSignal.timeout(8000),
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; DorezstTeslaLive/1.0)',
      },
    });
    if (!isHttpRedirect(response)) break;
    const location = response.headers.get('location');
    if (!location) throw new Error('直播分享链接没有返回跳转地址');
    const next = new URL(location, current);
    if (detectWebLivePlatform(next.toString()) !== initialPlatform) {
      throw new Error('直播分享链接跳转到了不受支持的站点');
    }
    current = next;
  }

  const resolved = normalizeWebLiveSource(initialPlatform, current.toString());
  if (resolved.roomId.length < 2) throw new Error('未识别到公开直播间，请改用直播间页面链接');
  return resolved;
}

export function getDefaultWebLiveName(
  platform: WebLivePlatform,
  roomId: string
) {
  return `${PLATFORM_LABELS[platform]} ${roomId}`;
}
