import { appendDanmakuToken } from './config';

describe('danmaku custom endpoint token path', () => {
  test('appends the configured token even when it equals the built-in token', () => {
    expect(appendDanmakuToken('https://danmu.dorezst.cn', '980728')).toBe(
      'https://danmu.dorezst.cn/980728'
    );
  });

  test('does not append the token twice', () => {
    expect(
      appendDanmakuToken('https://danmu.dorezst.cn/980728/', '980728')
    ).toBe('https://danmu.dorezst.cn/980728');
  });
});
