// Minimal surface of the YouTube IFrame API that this theatre actually uses.
export interface YtPlayer {
  cueVideoById(videoId: string, startSeconds?: number): void;
  loadVideoById(videoId: string, startSeconds?: number): void;
  playVideo(): void;
  pauseVideo(): void;
  seekTo(seconds: number, allowSeekAhead: boolean): void;
  getCurrentTime(): number;
  getDuration(): number;
  getPlayerState(): number;
  mute(): void;
  unMute(): void;
  setVolume(volume: number): void;
  isMuted(): boolean;
  getVideoData(): { title?: string; video_id?: string };
  destroy(): void;
}

export const STATE = { unstarted: -1, ended: 0, playing: 1, paused: 2, buffering: 3, videoCued: 5 } as const;

let pending: Promise<any> | null = null;
let tag: HTMLScriptElement | null = null;

export function loadYouTubeApi(): Promise<any> {
  const w = window as any;
  if (w.YT?.Player) return Promise.resolve(w.YT);
  if (pending) return pending;
  pending = new Promise((resolve, reject) => {
    let timer = 0;
    // A slow first fetch must not poison the whole session: the cached promise is dropped
    // on failure, and the script tag stays in the page, so a later retry just waits
    // for the load that is already under way.
    const fail = (reason: string) => {
      window.clearTimeout(timer);
      pending = null;
      reject(new Error(reason));
    };
    timer = window.setTimeout(() => fail('youtube_api_timeout'), 15_000);
    const previous = w.onYouTubeIframeAPIReady;
    w.onYouTubeIframeAPIReady = () => {
      window.clearTimeout(timer);
      if (typeof previous === 'function') previous();
      resolve(w.YT);
    };
    if (tag) return;
    tag = document.createElement('script');
    tag.src = 'https://www.youtube.com/iframe_api';
    tag.async = true;
    tag.onerror = () => { tag = null; fail('youtube_api_blocked'); };
    document.head.appendChild(tag);
  });
  return pending;
}
