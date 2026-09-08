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

export function getDefaultWebLiveName(
  platform: WebLivePlatform,
  roomId: string
) {
  return `${PLATFORM_LABELS[platform]} ${roomId}`;
}
