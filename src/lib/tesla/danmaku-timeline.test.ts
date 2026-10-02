import { resolveTeslaDanmakuTimeline } from './danmaku-timeline';

describe('Tesla danmaku presentation timeline', () => {
  test('uses the presented frame PTS translated to the content timeline', () => {
    expect(
      resolveTeslaDanmakuTimeline({
        contentTime: 603,
        mediaTime: 628,
        timelineOffsetSec: 25,
      })
    ).toEqual({ time: 603, aligned: true });
  });

  test('refuses a stale presented-frame timestamp', () => {
    expect(
      resolveTeslaDanmakuTimeline({
        contentTime: 603,
        mediaTime: 610,
        timelineOffsetSec: 0,
      })
    ).toEqual({ time: 603, aligned: false });
  });
});
