import {
  createStableLiveChannelId,
  findSameLiveChannel,
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
});
