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

  it('VOD 专用链路可处理缺失 ENDLIST 的不规范点播清单', () => {
    const malformedVod = VOD_PLAYLIST.replace(
      '#EXT-X-PLAYLIST-TYPE:VOD\n',
      ''
    ).replace('\n#EXT-X-ENDLIST', '');

    expect(
      applyConfiguredAdFilterSafely('test', malformedVod, '', true)
    ).not.toContain('preroll.ts');
    expect(applyConfiguredAdFilterSafely('test', malformedVod)).toBe(
      malformedVod
    );
  });

  it('隐式 AES IV 转为原序号显式 IV 后安全删除广告', () => {
    const encrypted = VOD_PLAYLIST.replace(
      '#EXT-X-PLAYLIST-TYPE:VOD',
      '#EXT-X-PLAYLIST-TYPE:VOD\n#EXT-X-KEY:METHOD=AES-128,URI="key.bin"'
    );

    const filtered = applyConfiguredAdFilterSafely('test', encrypted);
    expect(filtered).not.toContain('preroll.ts');
    expect(filtered).toContain('IV=0x00000000000000000000000000000000');
    expect(filtered).toContain('IV=0x00000000000000000000000000000002');
    expect(filtered).toContain('#EXT-X-DISCONTINUITY');
  });

  it('按真实资源 key 命中无 URL 关键词的广告映射', () => {
    const numericAdPlaylist = VOD_PLAYLIST.replace(
      'https://betting.example.com/preroll.ts',
      'https://cdn.example.com/000002.ts'
    );
    const customCode = `
      function filterAdsFromM3U8(type, m3u8Content) {
        if (type !== 'mapped-source') return m3u8Content;
        return m3u8Content.replace(
          '#EXTINF:5,\\nhttps://cdn.example.com/000002.ts\\n',
          ''
        );
      }
    `;

    expect(
      applyConfiguredAdFilterSafely(
        'mapped-source',
        numericAdPlaylist,
        customCode
      )
    ).not.toContain('000002.ts');
    expect(
      applyConfiguredAdFilterSafely('level', numericAdPlaylist, customCode)
    ).toBe(numericAdPlaylist);
  });
});
