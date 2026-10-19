import {
  resolveTeslaDanmakuAnimationDuration,
  resolveTeslaDanmakuTimeline,
} from './danmaku-timeline';

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

  test('delays comments without changing the media clock', () => {
    expect(
      resolveTeslaDanmakuTimeline({
        contentTime: 603,
        mediaTime: 628,
        timelineOffsetSec: 25,
        danmakuDelaySec: 2,
      })
    ).toEqual({ time: 601, aligned: true });
  });

  test('allows comments to be advanced and clamps calibration safely', () => {
    expect(
      resolveTeslaDanmakuTimeline({
        contentTime: 603,
        danmakuDelaySec: -2,
      })
    ).toEqual({ time: 605, aligned: false });
    expect(
      resolveTeslaDanmakuTimeline({
        contentTime: 10,
        danmakuDelaySec: 120,
      })
    ).toEqual({ time: 0, aligned: false });
  });
});

describe('Tesla danmaku animation rate', () => {
  test('keeps screen travel aligned with media time at playback speed', () => {
    expect(resolveTeslaDanmakuAnimationDuration(10, 1)).toBe(10);
    expect(resolveTeslaDanmakuAnimationDuration(10, 1.25)).toBe(8);
    expect(resolveTeslaDanmakuAnimationDuration(10, 2)).toBe(5);
  });
});
