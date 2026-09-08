import {
  createStableLiveChannelId,
  findSameLiveChannel,
  findSuspiciousLivePlaylistUri,
  findStableLiveChannelById,
  groupLiveChannelVariants,
  isLivePlaylistPlaceholder,
  isSuspiciousLiveRedirect,
} from './live-channel-identity';

describe('Tesla live channel identity', () => {
  const cctv6 = {
    id: createStableLiveChannelId('govin', {
      tvgId: 'CCTV6',
      name: 'CCTV-6 电影',
      group: '央视',
      url: 'https://cdn.example.com/cctv6/index.m3u8?token=old',
    }),
    legacyId: 'govin-6',
    tvgId: 'CCTV6',
    name: 'CCTV-6 电影',
    group: '央视',
    url: 'https://cdn.example.com/cctv6/index.m3u8?token=old',
  };

  test('keeps the same id when only an expiring query changes', () => {
    expect(
      createStableLiveChannelId('govin', {
        ...cctv6,
        url: 'https://cdn.example.com/cctv6/index.m3u8?token=new',
      })
    ).toBe(cctv6.id);
  });

  test('does not follow the old list index after channels reorder', () => {
    const refreshed = [
      {
        ...cctv6,
        legacyId: 'govin-7',
        url: 'https://cdn.example.com/cctv6/index.m3u8?token=new',
      },
      {
        id: 'govin-cctv7',
        legacyId: 'govin-6',
        tvgId: 'CCTV7',
        name: 'CCTV-7 国防军事',
        group: '央视',
        url: 'https://cdn.example.com/cctv7/index.m3u8',
      },
    ];
    expect(findSameLiveChannel(refreshed, cctv6)?.tvgId).toBe('CCTV6');
  });

  test('fails closed when a channel name is ambiguous', () => {
    expect(
      findSameLiveChannel(
        [
          { id: 'one', name: 'CCTV6', url: 'https://a.example/live.m3u8' },
          { id: 'two', name: 'CCTV6', url: 'https://b.example/live.m3u8' },
        ],
        { name: 'CCTV6' }
      )
    ).toBeNull();
  });

  test('does not recover through a positional legacy id', () => {
    expect(
      findSameLiveChannel(
        [{ id: 'stable-cctv7', legacyId: 'govin-6', name: 'CCTV7' }],
        { id: 'govin-6' }
      )
    ).toBeNull();
  });

  test('automatic recovery refuses a metadata-only channel replacement', () => {
    expect(
      findStableLiveChannelById(
        [
          {
            id: 'replacement-cctv7',
            tvgId: 'CCTV6',
            name: 'CCTV-6 电影',
            url: 'https://cdn.example.com/cctv7/index.m3u8',
          },
        ],
        cctv6.id
      )
    ).toBeNull();
  });

  test('filters Guovin timestamp and explicit ad placeholders', () => {
    expect(
      isLivePlaylistPlaceholder({
        name: '2026-08-27 14:06:22',
        group: '🕘️更新时间',
      })
    ).toBe(true);
    expect(
      isLivePlaylistPlaceholder({ name: 'CCTV-6', group: '央视频道' })
    ).toBe(false);
  });

  test('rejects a redirect to another CCTV channel or an ad endpoint', () => {
    expect(
      isSuspiciousLiveRedirect(
        'https://cdn.example/cctv6/index.m3u8',
        'https://cdn.example/cctv7/index.m3u8',
        cctv6
      )
    ).toBe(true);
    expect(
      isSuspiciousLiveRedirect(
        'https://cdn.example/cctv6/index.m3u8',
        'https://edge.example/ad/live.m3u8',
        cctv6
      )
    ).toBe(true);
  });

  test('rejects a rolling playlist that injects another CCTV channel', () => {
    expect(
      findSuspiciousLivePlaylistUri(
        '#EXTM3U\n#EXTINF:6,\n../cctv7/segment-22.ts',
        'https://cdn.example/live/cctv6/index.m3u8',
        cctv6
      )
    ).toContain('/cctv7/');
  });

  test('merges same logical channel for display without deleting its lines', () => {
    const grouped = groupLiveChannelVariants([
      { id: 'one', tvgId: 'CCTV6', name: 'CCTV-6', url: 'https://a/live' },
      { id: 'two', tvgId: 'cctv6', name: 'CCTV6电影', url: 'https://b/live' },
      { id: 'three', tvgId: 'CCTV7', name: 'CCTV-7', url: 'https://c/live' },
    ]);
    expect(grouped).toHaveLength(2);
    expect(grouped[0].variants.map((item) => item.id)).toEqual(['one', 'two']);
  });
});
