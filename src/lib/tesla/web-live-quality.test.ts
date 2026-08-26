import {
  getBilibiliAvcTsVariant,
  parseHuyaAvcQualities,
} from './web-live-quality';

describe('web live quality parsing', () => {
  test('extracts only AVC Huya qualities in low-to-high order', () => {
    const html = `"vMultiStreamInfo":[{"sDisplayName":"2K","iBitRate":14000,"iCodecType":1},{"sDisplayName":"原画","iBitRate":0,"iCodecType":0},{"sDisplayName":"流畅","iBitRate":500,"iCodecType":0},{"sDisplayName":"超清","iBitRate":2000,"iCodecType":0}],"iWebDefaultBitRate":2000`;
    expect(parseHuyaAvcQualities(html)).toEqual([
      { id: 'HUYA_500', label: '流畅', bitrate: 500 },
      { id: 'HUYA_2000', label: '超清', bitrate: 2000 },
      { id: 'HUYA_0', label: '原画', bitrate: 0 },
    ]);
  });

  test('selects Bilibili HLS MPEG-TS AVC and rejects HEVC/fMP4', () => {
    const variant = getBilibiliAvcTsVariant({
      stream: [
        {
          protocol_name: 'http_hls',
          format: [
            {
              format_name: 'fmp4',
              codec: [{ codec_name: 'avc', base_url: '/bad/index.m3u8' }],
            },
            {
              format_name: 'ts',
              codec: [
                { codec_name: 'hevc', base_url: '/hevc.m3u8' },
                {
                  codec_name: 'avc',
                  current_qn: 250,
                  accept_qn: [10000, 400, 250],
                  base_url: '/avc.m3u8',
                  url_info: [
                    { host: 'https://cdn.example', extra: '?token=1' },
                  ],
                },
              ],
            },
          ],
        },
      ],
    });
    expect(variant).toEqual({
      currentQn: 250,
      acceptQn: [10000, 400, 250],
      urls: ['https://cdn.example/avc.m3u8?token=1'],
    });
  });
});
