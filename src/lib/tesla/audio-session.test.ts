import { bindTeslaMediaSession } from './audio-session';

describe('Tesla Media Session binding', () => {
  test('registers play, pause, track and seek controls when available', () => {
    const handlers = new Map<string, ((details?: any) => void) | null>();
    Object.defineProperty(navigator, 'mediaSession', {
      configurable: true,
      value: {
        metadata: null,
        playbackState: 'none',
        setActionHandler: (
          action: string,
          handler: ((details?: any) => void) | null
        ) => handlers.set(action, handler),
        setPositionState: () => undefined,
      },
    });
    const onPlay = jest.fn();
    const onPause = jest.fn();
    const onPrevious = jest.fn();
    const onNext = jest.fn();
    const onSeekTo = jest.fn();

    const cleanup = bindTeslaMediaSession({
      onPlay,
      onPause,
      onPrevious,
      onNext,
      onSeekTo,
    });

    handlers.get('play')?.();
    handlers.get('pause')?.();
    handlers.get('previoustrack')?.();
    handlers.get('nexttrack')?.();
    handlers.get('seekto')?.({ seekTime: 42 });

    expect(onPlay).toHaveBeenCalledTimes(1);
    expect(onPause).toHaveBeenCalledTimes(1);
    expect(onPrevious).toHaveBeenCalledTimes(1);
    expect(onNext).toHaveBeenCalledTimes(1);
    expect(onSeekTo).toHaveBeenCalledWith(42);
    cleanup();
  });
});
