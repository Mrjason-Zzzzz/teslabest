import { applyConfiguredAdFilterSafely } from './ad-filter-custom';
import { detectExplicitLiveAdSignal } from './ad-filter-core';

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
  it('直播滑动窗口只识别明确广告信号，不重写媒体序号', () => {
    const live = `#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:21\n#EXT-X-CUE-OUT:30\n#EXTINF:6,\nad/segment.ts`;
    expect(detectExplicitLiveAdSignal(live)).toBe('cue-out');
    expect(
      detectExplicitLiveAdSignal('#EXTM3U\n#EXTINF:6,\nmain/21.ts')
    ).toBeNull();
  });
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

  it('删除短暂离开正片路径后返回的 discontinuity 广告岛', () => {
    const playlist = `#EXTM3U
#EXT-X-PLAYLIST-TYPE:VOD
#EXTINF:10,
https://vod.example/program/001.ts
#EXT-X-DISCONTINUITY
#EXTINF:10,
https://other-cdn.example/insert/101.ts
#EXTINF:10,
https://other-cdn.example/insert/102.ts
#EXT-X-DISCONTINUITY
#EXTINF:10,
https://vod.example/program/002.ts
#EXT-X-ENDLIST`;
    const filtered = applyConfiguredAdFilterSafely('test', playlist);
    expect(filtered).not.toContain('other-cdn.example');
    expect(filtered).toContain('/program/001.ts');
    expect(filtered).toContain('/program/002.ts');
  });

  it('识别相对正片路径切到绝对 CDN 后包围的外来广告岛', () => {
    // 魔都资源「重生废皇子」真实清单的结构：正片在清单前半段为相对
    // URI，广告岛后回到同一目录的绝对 CDN URI。两边的节目目录相同，
    // 但广告目录和日期均不同；不能因相对/绝对形式不同而漏掉广告岛。
    const playlist = `#EXTM3U
#EXT-X-PLAYLIST-TYPE:VOD
#EXTINF:10,
/20260923/UVqm0CSC/3050kb/hls/original-001.ts
#EXT-X-DISCONTINUITY
#EXTINF:10,
/20260917/khKm9Z55/10110kb/hls/insert-001.ts
#EXTINF:10,
/20260917/khKm9Z55/10110kb/hls/insert-002.ts
#EXT-X-DISCONTINUITY
#EXTINF:10,
https://bf.modujx17.com/20260923/UVqm0CSC/3050kb/hls/original-002.ts
#EXT-X-ENDLIST`;
    const filtered = applyConfiguredAdFilterSafely('modum3u8', playlist);

    expect(filtered).toContain('original-001.ts');
    expect(filtered).toContain('original-002.ts');
    expect(filtered).not.toContain('khKm9Z55');
    expect(filtered).toContain('#EXT-X-DISCONTINUITY');
  });

  it('移除同一清单内已被证实广告岛的重复末尾插入', () => {
    const playlist = `#EXTM3U
#EXT-X-PLAYLIST-TYPE:VOD
#EXTINF:10,
https://vod.example/program/001.ts
#EXT-X-DISCONTINUITY
#EXTINF:10,
https://ads.example/foreign/insert-001.ts
#EXT-X-DISCONTINUITY
#EXTINF:10,
https://vod.example/program/002.ts
#EXTINF:10,
https://vod.example/program/003.ts
#EXTINF:10,
https://vod.example/program/004.ts
#EXTINF:10,
https://vod.example/program/005.ts
#EXTINF:10,
https://vod.example/program/006.ts
#EXT-X-DISCONTINUITY
#EXTINF:10,
https://ads.example/foreign/insert-002.ts
#EXT-X-ENDLIST`;
    const filtered = applyConfiguredAdFilterSafely('test', playlist);

    expect(filtered).toContain('/program/001.ts');
    expect(filtered).toContain('/program/003.ts');
    expect(filtered).not.toContain('ads.example/foreign');
  });

  it('移除同一已证实广告目录的长尾片段，不按结尾时长放行', () => {
    const playlist = `#EXTM3U
#EXT-X-PLAYLIST-TYPE:VOD
#EXTINF:10,
https://vod.example/program/001.ts
#EXT-X-DISCONTINUITY
#EXTINF:10,
https://ads.example/foreign/insert-001.ts
#EXT-X-DISCONTINUITY
#EXTINF:10,
https://vod.example/program/002.ts
#EXT-X-DISCONTINUITY
#EXTINF:60,
https://ads.example/foreign/insert-long-tail.ts
#EXT-X-ENDLIST`;

    const filtered = applyConfiguredAdFilterSafely('test', playlist);

    expect(filtered).toContain('/program/001.ts');
    expect(filtered).toContain('/program/002.ts');
    expect(filtered).not.toContain('insert-long-tail.ts');
  });

  it('不按时长猜测删除未标记或同路径正片', () => {
    const playlist = `#EXTM3U
#EXT-X-PLAYLIST-TYPE:VOD
#EXTINF:10,
https://vod.example/program/001.ts
#EXTINF:10,
https://vod.example/program/002.ts
#EXT-X-ENDLIST`;
    expect(applyConfiguredAdFilterSafely('test', playlist)).toBe(playlist);
  });
});
