import { applyConfiguredAdFilterSafely } from './ad-filter-custom';

const VOD_PLAYLIST = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-PLAYLIST-TYPE:VOD
#EXTINF:5,
https://media.example.com/program-1.ts
#EXTINF:5,
https://betting.example.com/preroll.ts
#EXTINF:5,
https://media.example.com/program-2.ts
#EXT-X-ENDLIST`;

describe('applyConfiguredAdFilterSafely', () => {
  it('将自定义规则限制为完整分片删除并保留时间轴边界', () => {
    const customCode = `
      function filterAdsFromM3U8(type, m3u8Content) {
        return m3u8Content.replace(
          '#EXTINF:5,\\nhttps://betting.example.com/preroll.ts\\n',
          ''
        );
      }
    `;

    const filtered = applyConfiguredAdFilterSafely(
      'configured-source',
      VOD_PLAYLIST,
      customCode
    );

    expect(filtered).toContain('program-1.ts');
    expect(filtered).toContain('program-2.ts');
    expect(filtered).not.toContain('preroll.ts');
    expect(filtered).toContain('#EXT-X-DISCONTINUITY');
  });

  it('可识别 Tesla 代理 url 参数内的赌博广告分片', () => {
    const proxied = VOD_PLAYLIST.replace(
      'https://betting.example.com/preroll.ts',
      '/api/proxy/vod/segment?url=https%3A%2F%2Fcasino.example%2Fpreroll.ts&source=test'
    );
    const filtered = applyConfiguredAdFilterSafely('test', proxied);

    expect(filtered).not.toContain('casino.example');
    expect(filtered).toContain('program-1.ts');
    expect(filtered).toContain('program-2.ts');
  });

  it('隐式 AES IV 时宁可保留广告也不破坏解密和音画同步', () => {
    const encrypted = VOD_PLAYLIST.replace(
      '#EXT-X-PLAYLIST-TYPE:VOD',
      '#EXT-X-PLAYLIST-TYPE:VOD\n#EXT-X-KEY:METHOD=AES-128,URI="key.bin"'
    );

    const filtered = applyConfiguredAdFilterSafely('test', encrypted);
    expect(filtered).toBe(encrypted);
  });
});
