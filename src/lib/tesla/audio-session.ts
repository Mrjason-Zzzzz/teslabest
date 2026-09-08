'use client';

export interface TeslaAudioSessionSnapshot {
  unlocked: boolean;
  muted: boolean;
  volume: number;
}

const STORAGE_KEY = 'tesla_audio_session_v1';
const DEFAULT_SESSION: TeslaAudioSessionSnapshot = {
  unlocked: false,
  muted: false,
  volume: 1,
};

let session: TeslaAudioSessionSnapshot = { ...DEFAULT_SESSION };
let hydrated = false;
let sharedAudioContext: AudioContext | null = null;
let focusDestination: MediaStreamAudioDestinationNode | null = null;
let focusSource: ConstantSourceNode | OscillatorNode | null = null;
let focusGain: GainNode | null = null;
let focusAudioElement: HTMLAudioElement | null = null;
let focusReleaseTimer: number | null = null;
let activeMediaControls: TeslaMediaSessionOptions | null = null;
let activeMediaControlsToken = 0;
let internalKeeperAction: 'play' | 'pause' | null = null;
let internalKeeperActionTimer: number | null = null;

function invokeMediaControl(handler: (() => void) | null | undefined): void {
  if (!handler) return;
  try {
    handler();
  } catch {
    // Vehicle media controls must never break the playback event loop.
  }
}

function markInternalKeeperAction(action: 'play' | 'pause'): void {
  internalKeeperAction = action;
  if (internalKeeperActionTimer !== null) {
    window.clearTimeout(internalKeeperActionTimer);
  }
  internalKeeperActionTimer = window.setTimeout(() => {
    internalKeeperAction = null;
    internalKeeperActionTimer = null;
  }, 1500);
}

function consumeInternalKeeperAction(action: 'play' | 'pause'): boolean {
  if (internalKeeperAction !== action) return false;
  internalKeeperAction = null;
  if (internalKeeperActionTimer !== null) {
    window.clearTimeout(internalKeeperActionTimer);
    internalKeeperActionTimer = null;
  }
  return true;
}

function syncFocusKeeperState(state: MediaSessionPlaybackState): void {
  if (!focusAudioElement) return;
  try {
    if (state === 'playing' && focusAudioElement.paused) {
      markInternalKeeperAction('play');
      void focusAudioElement.play().catch(() => undefined);
    } else if (state === 'paused' && !focusAudioElement.paused) {
      markInternalKeeperAction('pause');
      focusAudioElement.pause();
    }
  } catch {
    // The keeper only bridges Tesla's native media card; playback stays valid.
  }
}

function hydrate(): void {
  if (hydrated || typeof window === 'undefined') return;
  hydrated = true;
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const saved = JSON.parse(raw);
    session = {
      unlocked: saved?.unlocked === true,
      muted: saved?.muted === true,
      volume: Number.isFinite(saved?.volume)
        ? Math.max(0, Math.min(1, saved.volume))
        : 1,
    };
  } catch {
    session = { ...DEFAULT_SESSION };
  }
}

function persist(): void {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(session));
  } catch {
    // Session persistence is an enhancement; playback must still work without it.
  }
}

export function getTeslaAudioSession(): TeslaAudioSessionSnapshot {
  hydrate();
  return { ...session };
}

export function updateTeslaAudioSession(
  patch: Partial<TeslaAudioSessionSnapshot>
): TeslaAudioSessionSnapshot {
  hydrate();
  session = {
    unlocked: patch.unlocked ?? session.unlocked,
    muted: patch.muted ?? session.muted,
    volume: Number.isFinite(patch.volume)
      ? Math.max(0, Math.min(1, patch.volume as number))
      : session.volume,
  };
  persist();
  return { ...session };
}

export function getTeslaAudioContext(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  if (sharedAudioContext && sharedAudioContext.state !== 'closed') {
    return sharedAudioContext;
  }

  const Ctor =
    window.AudioContext ||
    (window as typeof window & { webkitAudioContext?: typeof AudioContext })
      .webkitAudioContext;
  if (!Ctor) return null;
  sharedAudioContext = new Ctor({ latencyHint: 'playback' });
  return sharedAudioContext;
}

export function setTeslaMediaSessionState(
  state: MediaSessionPlaybackState
): void {
  syncFocusKeeperState(state);
  if (typeof navigator === 'undefined' || !('mediaSession' in navigator))
    return;
  try {
    navigator.mediaSession.playbackState = state;
  } catch {
    // Media Session is best-effort on embedded Chromium builds.
  }
}

export function setTeslaMediaSessionPosition(
  duration: number,
  position: number,
  playbackRate = 1
): void {
  if (typeof navigator === 'undefined' || !('mediaSession' in navigator))
    return;
  if (!Number.isFinite(duration) || duration <= 0) return;
  const safePosition = Math.max(0, Math.min(duration, position));
  try {
    navigator.mediaSession.setPositionState({
      duration,
      position: safePosition,
      playbackRate: Math.max(0.1, playbackRate),
    });
  } catch {
    // Older Tesla Chromium versions may expose Media Session without position.
  }
}

export interface TeslaMediaSessionOptions {
  title?: string;
  poster?: string;
  onPlay: () => void;
  onPause: () => void;
  onPrevious?: () => void;
  onNext?: () => void;
  onSeekTo?: (seconds: number) => void;
  onSeekBy?: (deltaSeconds: number) => void;
}

/**
 * Bind the active web player to Tesla's system media controls.
 *
 * The handlers only call the existing player methods. They never create a
 * second media element or audio graph, so Media Session cannot introduce echo
 * or move the A/V clock.
 */
export function bindTeslaMediaSession(
  options: TeslaMediaSessionOptions
): () => void {
  if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) {
    return () => {
      // Media Session is unavailable on this browser.
    };
  }

  const mediaSession = navigator.mediaSession;
  const bindingToken = ++activeMediaControlsToken;
  activeMediaControls = options;
  try {
    mediaSession.metadata = new MediaMetadata({
      title: options.title || 'Tesla 视频播放',
      artist: 'Tesla 播放器',
      artwork: options.poster
        ? [{ src: options.poster, sizes: '512x512' }]
        : undefined,
    });
  } catch {
    // Artwork and metadata support differs between vehicle browser releases.
  }

  const register = (
    action: MediaSessionAction,
    handler: MediaSessionActionHandler | null
  ) => {
    try {
      mediaSession.setActionHandler(action, handler);
    } catch {
      // Some Tesla Chromium versions expose Media Session but omit track keys.
    }
  };

  register('play', () => invokeMediaControl(activeMediaControls?.onPlay));
  register('pause', () => invokeMediaControl(activeMediaControls?.onPause));
  register('stop', () => invokeMediaControl(activeMediaControls?.onPause));
  register(
    'previoustrack',
    options.onPrevious
      ? () => invokeMediaControl(activeMediaControls?.onPrevious)
      : null
  );
  register(
    'nexttrack',
    options.onNext
      ? () => invokeMediaControl(activeMediaControls?.onNext)
      : null
  );
  register(
    'seekbackward',
    options.onSeekBy
      ? (details) =>
          activeMediaControls?.onSeekBy?.(
            -Math.max(1, details.seekOffset || 10)
          )
      : null
  );
  register(
    'seekforward',
    options.onSeekBy
      ? (details) =>
          activeMediaControls?.onSeekBy?.(Math.max(1, details.seekOffset || 10))
      : null
  );
  register(
    'seekto',
    options.onSeekTo
      ? (details) => {
          const seekTime = details.seekTime;
          if (Number.isFinite(seekTime)) {
            activeMediaControls?.onSeekTo?.(seekTime as number);
          }
        }
      : null
  );

  const handleHardwareMediaKey = (event: KeyboardEvent) => {
    if (event.repeat) return;
    if (event.key === 'MediaPlayPause') {
      const state = mediaSession.playbackState;
      invokeMediaControl(
        state === 'playing'
          ? activeMediaControls?.onPause
          : activeMediaControls?.onPlay
      );
    } else if (event.key === 'MediaPlay') {
      invokeMediaControl(activeMediaControls?.onPlay);
    } else if (event.key === 'MediaPause' || event.key === 'MediaStop') {
      invokeMediaControl(activeMediaControls?.onPause);
    } else if (event.key === 'MediaTrackPrevious') {
      invokeMediaControl(activeMediaControls?.onPrevious);
    } else if (event.key === 'MediaTrackNext') {
      invokeMediaControl(activeMediaControls?.onNext);
    } else {
      return;
    }
    event.preventDefault();
  };
  window.addEventListener('keydown', handleHardwareMediaKey, true);

  return () => {
    window.removeEventListener('keydown', handleHardwareMediaKey, true);
    if (activeMediaControlsToken !== bindingToken) return;
    activeMediaControls = null;
    register('play', null);
    register('pause', null);
    register('stop', null);
    register('previoustrack', null);
    register('nexttrack', null);
    register('seekbackward', null);
    register('seekforward', null);
    register('seekto', null);
  };
}

function ensureFocusKeeper(context: AudioContext): HTMLAudioElement | null {
  if (
    focusAudioElement &&
    focusDestination &&
    focusSource &&
    focusGain &&
    focusAudioElement.srcObject === focusDestination.stream
  ) {
    return focusAudioElement;
  }

  try {
    focusDestination = context.createMediaStreamDestination();
    focusGain = context.createGain();
    // Keep an active but silent media track. It is deliberately separate from
    // the audible graph, so claiming the vehicle media session cannot add
    // latency or alter the A/V master clock.
    focusGain.gain.value = 0;
    focusGain.connect(focusDestination);

    if (typeof context.createConstantSource === 'function') {
      const source = context.createConstantSource();
      source.offset.value = 0;
      source.connect(focusGain);
      source.start();
      focusSource = source;
    } else {
      const source = context.createOscillator();
      source.frequency.value = 20;
      source.connect(focusGain);
      source.start();
      focusSource = source;
    }

    const audio = document.createElement('audio');
    audio.style.display = 'none';
    audio.autoplay = true;
    audio.setAttribute('playsinline', '');
    audio.setAttribute('aria-hidden', 'true');
    audio.srcObject = focusDestination.stream;
    // Tesla's media card can control the active native media element without
    // dispatching Media Session action handlers. Bridge those native state
    // changes back to the real Canvas/WebCodecs player. Internal keeper calls
    // are marked and ignored, so they cannot pause/play the program twice.
    audio.addEventListener('play', () => {
      if (consumeInternalKeeperAction('play')) return;
      invokeMediaControl(activeMediaControls?.onPlay);
    });
    audio.addEventListener('pause', () => {
      if (consumeInternalKeeperAction('pause')) return;
      invokeMediaControl(activeMediaControls?.onPause);
    });
    document.body.appendChild(audio);
    focusAudioElement = audio;
    return audio;
  } catch {
    return null;
  }
}

/**
 * Best-effort Tesla/embedded-Chromium media-session claim.
 *
 * Web pages cannot call Android's native AudioManager directly. Keeping one
 * silent HTMLMediaElement active and marking Media Session as playing gives the
 * vehicle browser a stable media owner while the audible WebAudio graph is
 * rebuilt. The keeper never carries program audio, so it cannot create echo or
 * change synchronization.
 */
export async function claimTeslaAudioFocus(
  title = 'Tesla 视频播放'
): Promise<boolean> {
  if (typeof window === 'undefined') return false;
  if (focusReleaseTimer !== null) {
    window.clearTimeout(focusReleaseTimer);
    focusReleaseTimer = null;
  }

  const context = getTeslaAudioContext();
  if (!context) return false;
  try {
    await context.resume();
  } catch {
    return false;
  }

  const keeper = ensureFocusKeeper(context);
  try {
    if ('mediaSession' in navigator) {
      const existingMetadata = navigator.mediaSession.metadata;
      if (!existingMetadata || existingMetadata.title !== title) {
        navigator.mediaSession.metadata = new MediaMetadata({
          title,
          artist: 'Tesla 播放器',
        });
      }
    }
  } catch {
    // Metadata support differs between Tesla browser releases.
  }
  setTeslaMediaSessionState('playing');

  if (!keeper) return context.state === 'running';
  try {
    if (keeper.paused) {
      markInternalKeeperAction('play');
      await keeper.play();
    }
  } catch {
    // A previous explicit user gesture may still keep WebAudio available even
    // when the silent media keeper is blocked.
  }
  return context.state === 'running';
}

export function deferTeslaAudioFocusRelease(delayMs = 2500): void {
  if (typeof window === 'undefined') return;
  if (focusReleaseTimer !== null) window.clearTimeout(focusReleaseTimer);
  focusReleaseTimer = window.setTimeout(() => {
    focusReleaseTimer = null;
    try {
      if (focusAudioElement && !focusAudioElement.paused) {
        markInternalKeeperAction('pause');
        focusAudioElement.pause();
      }
    } catch {
      // The page may already be tearing down; focus release is best-effort.
    }
    setTeslaMediaSessionState('none');
  }, Math.max(0, delayMs));
}

export async function unlockTeslaAudioSession(): Promise<boolean> {
  const context = getTeslaAudioContext();
  if (!context) {
    updateTeslaAudioSession({ unlocked: true, muted: false });
    return true;
  }

  try {
    await context.resume();
  } catch {
    return false;
  }

  const unlocked = context.state === 'running';
  if (unlocked) {
    updateTeslaAudioSession({ unlocked: true, muted: false });
    await claimTeslaAudioFocus();
  }
  return unlocked;
}
