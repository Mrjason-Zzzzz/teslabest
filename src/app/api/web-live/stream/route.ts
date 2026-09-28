import crypto from 'crypto';
import { NextRequest, NextResponse } from 'next/server';

import { getConfig } from '@/lib/config';
import {
  isSourceAllowedForUser,
  requireFeaturePermission,
} from '@/lib/permissions';
import {
  getBilibiliAvcTsVariant,
  getBilibiliQualityLabels,
  parseHuyaAvcQualities,
} from '@/lib/tesla/web-live-quality';
import { normalizeWebLiveSource } from '@/lib/tesla/web-live-source';

function getAntiCode(oldAntiCode: string, streamName: string): string {
  const paramsT = 100;
  const sdkVersion = 2403051612;
  const t13 = Date.now();
  const sdkSid = t13;
  const initUuid =
    (Math.floor((t13 % 10000000000) * 1000) +
      Math.floor(1000 * Math.random())) %
    4294967295;
  const uid =
    Math.floor(Math.random() * (1400009999999 - 1400000000000 + 1)) +
    1400000000000;
  const seqId = uid + sdkSid;
  const targetUnixTime = Math.floor((t13 + 110624) / 1000);
  const wsTime = targetUnixTime.toString(16).toLowerCase();

  const urlQuery = new URLSearchParams(oldAntiCode);
  const fm = urlQuery.get('fm');
  if (!fm) return oldAntiCode;

  const wsSecretPf = Buffer.from(decodeURIComponent(fm), 'base64')
    .toString()
    .split('_')[0];
  const wsSecretHash = crypto
    .createHash('md5')
    .update(`${seqId}|${urlQuery.get('ctype')}|${paramsT}`)
    .digest('hex');
  const wsSecret = `${wsSecretPf}_${uid}_${streamName}_${wsSecretHash}_${wsTime}`;
  const wsSecretMd5 = crypto.createHash('md5').update(wsSecret).digest('hex');

  return `wsSecret=${wsSecretMd5}&wsTime=${wsTime}&seqid=${seqId}&ctype=${urlQuery.get(
    'ctype'
  )}&ver=1&fs=${urlQuery.get(
    'fs'
  )}&uuid=${initUuid}&u=${uid}&t=${paramsT}&sv=${sdkVersion}&sdk_sid=${sdkSid}&codec=264`;
}

async function getBilibiliStream(roomId: string) {
  const headers = {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    Referer: 'https://live.bilibili.com/',
    ...(process.env.BILIBILI_COOKIE
      ? { Cookie: process.env.BILIBILI_COOKIE }
      : {}),
  };

  // 获取房间初始化信息
  const roomInitRes = await fetch(
    `https://api.live.bilibili.com/room/v1/Room/room_init?id=${roomId}`,
    {
      headers,
    }
  );
  const roomInitData = await roomInitRes.json();

  if (roomInitData.code !== 0) {
    throw new Error(roomInitData.message || '获取房间信息失败');
  }

  const roomData = roomInitData.data;
  const realRoomId = roomData.room_id;
  const liveStatus = roomData.live_status; // 0=未开播, 1=直播中, 2=轮播
  const uid = roomData.uid;

  if (liveStatus !== 1) {
    throw new Error('直播未开启');
  }

  // 获取主播信息
  let ownerName = '';
  try {
    const userRes = await fetch(
      `https://api.live.bilibili.com/live_user/v1/Master/info?uid=${uid}`,
      {
        headers,
      }
    );
    const userData = await userRes.json();
    if (userData.code === 0) {
      ownerName = userData.data?.info?.uname || '';
    }
  } catch (err) {
    console.warn('获取主播信息失败:', err);
  }

  // 获取房间详细信息（包含标题）
  let title = '';
  try {
    const roomInfoRes = await fetch(
      `https://api.live.bilibili.com/room/v1/Room/get_info?room_id=${realRoomId}`,
      {
        headers,
      }
    );
    const roomInfoData = await roomInfoRes.json();
    if (roomInfoData.code === 0) {
      title = roomInfoData.data?.title || '';
    }
  } catch (err) {
    console.warn('获取房间标题失败:', err);
  }

  const getPlayInfo = async (qn: number) => {
    const response = await fetch(
      `https://api.live.bilibili.com/xlive/web-room/v2/index/getRoomPlayInfo?room_id=${realRoomId}&protocol=0,1&format=0,1,2&codec=0&qn=${qn}&platform=web&ptype=8`,
      { headers, cache: 'no-store', signal: AbortSignal.timeout(8000) }
    );
    const data = await response.json();
    if (data.code !== 0) throw new Error(data.message || '获取播放信息失败');
    return data.data?.playurl_info?.playurl;
  };

  const initialPlayurl = await getPlayInfo(10000);
  const initialVariant = getBilibiliAvcTsVariant(initialPlayurl);
  if (!initialVariant) throw new Error('未找到 Tesla 可用的 H.264 HLS 线路');
  const labels = getBilibiliQualityLabels(initialPlayurl);
  const requestedQns = Array.from(
    new Set([initialVariant.currentQn, ...initialVariant.acceptQn])
  )
    .filter((qn) => qn > 0)
    .sort((left, right) => left - right);
  const resolved = await Promise.all(
    requestedQns.map(async (qn) => {
      try {
        const playurl =
          qn === initialVariant.currentQn
            ? initialPlayurl
            : await getPlayInfo(qn);
        return getBilibiliAvcTsVariant(playurl);
      } catch {
        return null;
      }
    })
  );
  const variants = new Map<number, NonNullable<typeof initialVariant>>();
  for (const variant of resolved) {
    if (variant && variant.currentQn > 0 && !variants.has(variant.currentQn))
      variants.set(variant.currentQn, variant);
  }
  const qualities = Array.from(variants.values())
    .sort((left, right) => left.currentQn - right.currentQn)
    .map((variant) => ({
      id: `BILI_${variant.currentQn}`,
      label: labels.get(variant.currentQn) || `清晰度 ${variant.currentQn}`,
      urls: variant.urls,
    }));
  if (!qualities.length) throw new Error('未找到可用的 B 站清晰度');

  return {
    url: qualities[0].urls[0],
    name: ownerName,
    title: title,
    qualities,
    authenticated: Boolean(process.env.BILIBILI_COOKIE),
  };
}

async function getDouyinStream(roomId: string) {
  const baseHeaders = {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.5845.97 Safari/537.36',
    Referer: 'https://live.douyin.com/',
  };
  // 构建API参数
  const params = new URLSearchParams({
    aid: '6383',
    app_name: 'douyin_web',
    live_id: '1',
    device_platform: 'web',
    language: 'zh-CN',
    browser_language: 'zh-CN',
    browser_platform: 'Win32',
    browser_name: 'Chrome',
    browser_version: '116.0.0.0',
    web_rid: roomId,
    msToken: '',
  });

  const apiUrl = `https://live.douyin.com/webcast/room/web/enter/?${params.toString()}`;

  const requestRoom = async (
    headers: Record<string, string>,
    timeoutMs: number
  ) => {
    const response = await fetch(apiUrl, {
      headers,
      cache: 'no-store',
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok)
      throw new Error(`抖音解析接口响应异常（${response.status}）`);
    return response.json();
  };

  // Most public rooms resolve without a visitor cookie. Try that fast path
  // first so Tesla is not forced through two sequential Douyin requests.
  const landingPromise = fetch(`https://live.douyin.com/${roomId}`, {
    headers: baseHeaders,
    redirect: 'follow',
    cache: 'no-store',
    signal: AbortSignal.timeout(5500),
  }).catch(() => null);
  let jsonData: any = null;
  try {
    jsonData = await requestRoom(baseHeaders, 5500);
  } catch {
    // Some rooms require the anonymous ttwid cookie. The landing-page retry
    // below is intentionally only paid when the fast request fails.
  }
  if (!jsonData?.data?.data?.length) {
    const landing = await landingPromise;
    if (!landing) throw new Error('抖音直播页响应超时');
    const setCookies =
      (
        landing.headers as Headers & { getSetCookie?: () => string[] }
      ).getSetCookie?.() ||
      (landing.headers.get('set-cookie') || '')
        .split(/,(?=\s*[^;,=]+=[^;,]*)/)
        .filter(Boolean);
    const cookie = setCookies
      .map((item) => item.split(';')[0]?.trim())
      .filter(Boolean)
      .join('; ');
    if (cookie)
      jsonData = await requestRoom({ ...baseHeaders, Cookie: cookie }, 7500);
  }

  if (!jsonData.data || !jsonData.data.data) {
    throw new Error('获取直播间信息失败');
  }

  const roomData = jsonData.data.data[0];
  const status = roomData.status;

  if (status !== 2) {
    throw new Error('直播未开启');
  }

  const streamUrl = roomData.stream_url;
  if (!streamUrl) {
    throw new Error('未找到流地址');
  }

  // 获取m3u8地址
  const hlsPullUrlMap = streamUrl.hls_pull_url_map;
  if (!hlsPullUrlMap) {
    throw new Error('未找到m3u8地址');
  }

  // Low-to-high order matches the page's fallback policy: start with the most
  // reliable Tesla stream, while higher qualities remain manually selectable.
  const qualityOrder = [
    ['SD2', '流畅'],
    ['SD1', '标清'],
    ['HD1', '高清'],
    ['FULL_HD1', '超清'],
    ['ORIGIN', '原画'],
  ] as const;
  const qualities = qualityOrder
    .map(([id, label]) => ({
      id,
      label,
      url:
        typeof hlsPullUrlMap[id] === 'string'
          ? hlsPullUrlMap[id].replace(/^http:\/\//i, 'https://')
          : '',
    }))
    .filter((item) => typeof item.url === 'string' && item.url);
  const m3u8Url = qualities[0]?.url;

  if (!m3u8Url) {
    throw new Error('未找到可用的m3u8地址');
  }

  // 返回流地址和主播信息
  return {
    url: m3u8Url,
    name: jsonData.data.user?.nickname || '',
    title: roomData.title || '',
    qualities,
  };
}

export async function GET(request: NextRequest) {
  try {
    const authResult = await requireFeaturePermission(
      request,
      'web_live',
      '无权限访问网络直播'
    );
    if (authResult instanceof NextResponse) return authResult;
    const { searchParams } = new URL(request.url);
    const sourceKey = searchParams.get('source') || '';
    const isHandoff = searchParams.get('handoff') === '1';
    let resolvedPlatform = '';
    let resolvedRoomId = '';

    if (sourceKey) {
      const config = await getConfig();
      const configuredSource = config.WebLiveConfig?.find(
        (source) => source.key === sourceKey && !source.disabled
      );
      if (
        !configuredSource ||
        !(await isSourceAllowedForUser(authResult.username, configuredSource))
      ) {
        return NextResponse.json(
          { error: '无权限访问该网络直播源' },
          { status: 403 }
        );
      }
      // The stored source key is authoritative. Client platform/room values may
      // be stale after an admin edit and must not cause a false 403.
      resolvedPlatform = configuredSource.platform;
      resolvedRoomId = configuredSource.roomId;
    } else if (isHandoff) {
      try {
        const normalized = normalizeWebLiveSource(
          searchParams.get('platform'),
          searchParams.get('roomId')
        );
        resolvedPlatform = normalized.platform;
        resolvedRoomId = normalized.roomId;
      } catch (error) {
        return NextResponse.json(
          { error: error instanceof Error ? error.message : '直播接力参数无效' },
          { status: 400 }
        );
      }
    } else {
      return NextResponse.json({ error: '缺少直播源参数' }, { status: 400 });
    }

    if (resolvedPlatform === 'huya') {
      const res = await fetch(`https://www.huya.com/${resolvedRoomId}`, {
        cache: 'no-store',
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        },
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) {
        throw new Error(`虎牙页面请求失败（${res.status}）`);
      }
      const html = await res.text();

      const match = html.match(/stream:\s*(\{"data".*?),"iWebDefaultBitRate"/);
      if (!match) {
        return NextResponse.json({ error: '未找到直播数据' }, { status: 404 });
      }

      const jsonData = JSON.parse(match[1] + '}');
      const gameLiveInfo = jsonData.data?.[0]?.gameLiveInfo;
      const streamInfoList =
        jsonData.data?.[0]?.gameStreamInfoList?.filter(
          (item: Record<string, unknown>) =>
            item.sHlsUrl &&
            item.sStreamName &&
            item.sHlsUrlSuffix &&
            item.sHlsAntiCode
        ) || [];

      if (streamInfoList.length === 0) {
        return NextResponse.json({ error: '直播未开启' }, { status: 404 });
      }
      const huyaQualities = parseHuyaAvcQualities(html);
      const qualityRows = huyaQualities.length
        ? huyaQualities
        : [{ id: 'HUYA_0', label: '原画', bitrate: 0 }];
      const qualities = qualityRows.map((quality) => ({
        id: quality.id,
        label: quality.label,
        transports: streamInfoList.flatMap(
          (streamInfo: Record<string, string>, index: number) => {
            const antiCode = getAntiCode(
              streamInfo.sHlsAntiCode,
              streamInfo.sStreamName
            );
            const ratio = `&ratio=${quality.bitrate}`;
            const originalUrl = `${streamInfo.sHlsUrl}/${streamInfo.sStreamName}.${streamInfo.sHlsUrlSuffix}?${antiCode}${ratio}`;
            return [
              {
                id: `huya-${quality.bitrate}-direct-${index + 1}`,
                label: `直连 ${index + 1}`,
                url: originalUrl,
                originalUrl,
                streamType: 'hls',
              },
              {
                id: `huya-${quality.bitrate}-proxy-${index + 1}`,
                label: `代理备用 ${index + 1}`,
                url: `/api/web-live/proxy/proxy.m3u8?url=${encodeURIComponent(
                  originalUrl
                )}`,
                originalUrl,
                streamType: 'hls',
              },
            ];
          }
        ),
      }));
      const preferred = qualities[0].transports[0];

      return NextResponse.json({
        url: preferred.url,
        originalUrl: preferred.originalUrl,
        name: gameLiveInfo?.nick || '',
        title: gameLiveInfo?.introduction || '',
        streamType: 'hls',
        qualities,
      });
    }

    if (resolvedPlatform === 'bilibili') {
      const streamData = await getBilibiliStream(resolvedRoomId);
      const toProxy = (url: string) =>
        `/api/web-live/proxy/proxy.m3u8?url=${encodeURIComponent(url)}`;

      return NextResponse.json({
        url: toProxy(streamData.url),
        originalUrl: streamData.url,
        name: streamData.name,
        title: streamData.title,
        streamType: 'hls',
        qualityNotice:
          !streamData.authenticated && streamData.qualities.length === 1
            ? 'B 站当前仅向未登录服务端返回一档可播清晰度'
            : '',
        qualities: streamData.qualities.map((quality) => ({
          id: quality.id,
          label: quality.label,
          transports: quality.urls.map((url, index) => ({
            id: `${quality.id}-cdn-${index + 1}`,
            label: `CDN ${index + 1}`,
            url: toProxy(url),
            originalUrl: url,
            streamType: 'hls',
          })),
        })),
      });
    }

    if (resolvedPlatform === 'douyin') {
      const streamData = await getDouyinStream(resolvedRoomId);
      const toProxy = (url: string) =>
        `/api/web-live/proxy/proxy.m3u8?url=${encodeURIComponent(url)}`;
      return NextResponse.json({
        url: streamData.url,
        originalUrl: streamData.url,
        name: streamData.name,
        title: streamData.title,
        streamType: 'hls',
        qualities: streamData.qualities.map((item) => ({
          id: item.id,
          label: item.label,
          transports: [
            {
              id: `${item.id}-direct`,
              label: '直连线路',
              url: item.url,
              originalUrl: item.url,
              streamType: 'hls',
            },
            {
              id: `${item.id}-proxy`,
              label: '代理备用',
              url: toProxy(item.url),
              originalUrl: item.url,
              streamType: 'hls',
            },
          ],
        })),
      });
    }

    return NextResponse.json({ error: '不支持的平台' }, { status: 400 });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : '获取失败' },
      { status: 500 }
    );
  }
}
