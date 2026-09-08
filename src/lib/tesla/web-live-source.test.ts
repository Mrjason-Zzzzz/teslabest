import {
  detectWebLivePlatform,
  getDefaultWebLiveName,
  normalizeWebLiveSource,
} from './web-live-source';

describe('Tesla web live source input', () => {
  test('detects platform and room from a pasted link', () => {
    expect(
      normalizeWebLiveSource('douyin', 'https://www.huya.com/660000')
    ).toEqual({ platform: 'huya', roomId: '660000' });
    expect(
      normalizeWebLiveSource('huya', 'https://live.bilibili.com/12345?foo=1')
    ).toEqual({ platform: 'bilibili', roomId: '12345' });
  });

  test('keeps selected platform for a bare room id', () => {
    expect(normalizeWebLiveSource('douyin', '998877')).toEqual({
      platform: 'douyin',
      roomId: '998877',
    });
  });

  test('provides a compact fallback name', () => {
    expect(detectWebLivePlatform('https://www.douyin.com/live/88')).toBe(
      'douyin'
    );
    expect(getDefaultWebLiveName('douyin', '88')).toBe('抖音 88');
  });
});
