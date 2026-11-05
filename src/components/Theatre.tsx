import { useCallback, useEffect, useRef, useState } from 'react';
import { Clapperboard, Pause, Play, Plus, RotateCcw, RotateCw, Sparkles, Volume1, Volume2, VolumeX, X } from 'lucide-react';
import { loadYouTubeApi, STATE, type YtPlayer } from '@/src/lib/yt';
import { parseYouTube, startAt, watchUrl, clockLabel, isVideoId } from '@/src/lib/youtube';
import { runtime, useRoom } from '@/src/lib/useRoom';
import type { QueueItem } from '@/src/lib/types';

const DRIFT_MS = 1_300;
const HEARTBEAT_MS = 10_000;
const LOCAL_GUARD_MS = 1_100;

/** The widget API answers NaN before a video is cued. Never let that reach the screen or the wire. */
const nz = (value: number) => (Number.isFinite(value) ? value : 0);

export default function Theatre() {
  const { player, peers, session } = useRoom();
  const mount = useRef<HTMLDivElement | null>(null);
  const yt = useRef<YtPlayer | null>(null);
  const loaded = useRef('');
  const localWrite = useRef(0);
  const ready = useRef(false);

  const [now, setNow] = useState(0);
  const [duration, setDuration] = useState(0);
  const [title, setTitle] = useState('');
  const [muted, setMuted] = useState(false);
  const [volume] = useState(() => {
    try { return Number(JSON.parse(localStorage.getItem('little-cinema:sound') ?? '{}').volume) || 80; } catch { return 80; }
  });
  const [needsTap, setNeedsTap] = useState(false);
  const [issue, setIssue] = useState('');
  const [link, setLink] = useState('');
  const [drag, setDrag] = useState<number | null>(null);

  const other = peers.find(peer => peer.peer !== session?.peer) ?? null;

  /** Where the film should be right now, on the room clock — not where a message said to be. */
  const expected = useCallback(() => {
    const state = runtime.player;
    if (!state.video) return 0;
    const elapsed = state.playing ? Math.max(0, runtime.serverNow() - state.updated) : 0;
    return state.position + elapsed;
  }, []);

  const write = useCallback(async (patch: Partial<{ video: string; title: string; position: number; playing: boolean; queue: QueueItem[] }>) => {
    localWrite.current = Date.now();
    const current = yt.current;
    await runtime.setPlayer({
      video: patch.video ?? runtime.player.video,
      title: patch.title ?? runtime.player.title,
      position: Math.round(patch.position ?? (current ? nz(current.getCurrentTime()) * 1000 : runtime.player.position)),
      playing: patch.playing ?? current?.getPlayerState() === STATE.playing,
      queue: patch.queue,
    }, true);
  }, []);

  /** Bring this player in line with the room. */
  const follow = useCallback(() => {
    const current = yt.current;
    if (!current || !ready.current) return;
    const state = runtime.player;
    const mine = state.updated_by === runtime.session?.peer;
    // Never let a partner command land on top of a control this person just touched.
    if (!mine && Date.now() - localWrite.current < LOCAL_GUARD_MS) return;
    if (!isVideoId(state.video)) {
      if (loaded.current) { current.pauseVideo(); loaded.current = ''; }
      return;
    }
    if (loaded.current !== state.video) {
      loaded.current = state.video;
      const at = Math.max(0, state.position / 1000);
      if (state.playing) current.loadVideoById(state.video, at);
      else current.cueVideoById(state.video, at);
      setIssue('');
      return;
    }
    const seconds = Math.max(0, expected() / 1000);
    const playerState = current.getPlayerState();
    if (Math.abs(nz(current.getCurrentTime()) - seconds) * 1000 > DRIFT_MS) current.seekTo(seconds, true);
    if (state.playing && playerState !== STATE.playing && playerState !== STATE.buffering) {
      current.playVideo();
      window.setTimeout(() => {
        const after = yt.current?.getPlayerState();
        if (after !== STATE.playing && after !== STATE.buffering) setNeedsTap(true);
      }, 1_400);
    }
    if (!state.playing && (playerState === STATE.playing || playerState === STATE.buffering)) current.pauseVideo();
  }, [expected]);

  const playIndex = useCallback(async (index: number) => {
    const queue = [...(runtime.player.queue ?? [])];
    const item = queue[index];
    if (!item) return;
    queue.splice(index, 1);
    await write({ video: item.video, title: item.title, position: 0, playing: true, queue });
    loaded.current = item.video;
    yt.current?.loadVideoById(item.video, 0);
    setNeedsTap(true);
  }, [write]);

  const dropFromQueue = (index: number) => {
    const queue = [...(runtime.player.queue ?? [])];
    queue.splice(index, 1);
    void write({ queue });
  };

  const loadLink = (raw: string, queueOnly = false) => {
    const id = parseYouTube(raw);
    if (!id) {
      setIssue('That is not a YouTube link yet. Try youtu.be/… or youtube.com/watch?v=…');
      window.setTimeout(() => setIssue(''), 5_000);
      return false;
    }
    const from = startAt(raw) * 1000;
    if (queueOnly) {
      void write({ queue: [...(runtime.player.queue ?? []), { video: id, title: runtime.player.title || '' }] });
      return true;
    }
    void write({ video: id, title: '', position: from, playing: true });
    loaded.current = id;
    yt.current?.loadVideoById(id, from / 1000);
    setTitle('');
    setIssue('');
    setNeedsTap(true);
    return true;
  };

  // ---------- build the player once ----------
  useEffect(() => {
    let cancelled = false;
    let saved: { volume?: number; muted?: boolean } = {};
    try { saved = JSON.parse(localStorage.getItem('little-cinema:sound') ?? '{}'); } catch { /* first visit */ }
    setMuted(Boolean(saved.muted));

    loadYouTubeApi().then(YT => {
      if (cancelled || !mount.current) return;
      const first = runtime.player.video;
      yt.current = new YT.Player(mount.current, {
        // The widget API throws "Invalid video id" for an empty or half-shaped id, even
        // when the key is merely present — so only pass one that is real.
        ...(isVideoId(first) ? { videoId: first } : {}),
        playerVars: {
          autoplay: 0, controls: 0, rel: 0, modestbranding: 1, playsinline: 1,
          iv_load_policy: 3, disablekb: 1, fs: 0, origin: window.location.origin,
        },
        events: {
          onReady: () => {
            if (cancelled) return;
            ready.current = true;
            loaded.current = runtime.player.video;
            setIssue('');
            const current = yt.current;
            if (current) {
              if (saved.muted) current.mute();
              else { current.unMute(); current.setVolume(saved.volume ?? 80); }
              setDuration(nz(current.getDuration()));
              setNow(nz(current.getCurrentTime()));
            }
            follow();
          },
          onStateChange: (event: { data: number }) => {
            const current = yt.current;
            if (!current) return;
            setNow(nz(current.getCurrentTime()));
            setDuration(nz(current.getDuration()));
            const data = current.getVideoData?.();
            if (data?.title) setTitle(String(data.title));
            if (event.data === STATE.playing) setNeedsTap(false);
            if (event.data === STATE.ended && runtime.isDriver() && (runtime.player.queue ?? []).length) void playIndex(0);
            follow();
          },
          onError: (event: { data: number }) => {
            const code = Number(event.data);
            // The widget API also fires a stray "bad id" while a cue is still settling.
            // If the room's film is actually loaded, that noise is not worth a warning.
            if (runtime.player.video && nz(yt.current?.getDuration?.() ?? 0) > 0) return;
            setIssue(code === 101 || code === 150
              ? 'That video blocks playback outside YouTube. Pick another one.'
              : code === 2 ? 'That link does not point at a real video id.' : 'That one refuses to play here. Try a different link.');
          },
        },
      });
    }).catch((error: unknown) => {
      if (cancelled) return;
      // Construction failures are not connectivity failures; keep them distinguishable
      // in the console so a broken player is not blamed on the network.
      console.error('Little Cinema: the shared screen could not start.', error);
      setIssue('YouTube would not load here. Check the connection, or any blocker extension.');
    });

    return () => {
      cancelled = true;
      ready.current = false;
      try { yt.current?.destroy(); } catch { /* already gone */ }
      yt.current = null;
      loaded.current = '';
    };
  }, [follow, playIndex]);

  // ---------- keep the picture honest ----------
  useEffect(() => {
    const tick = window.setInterval(() => {
      const current = yt.current;
      if (!current || !ready.current) return;
      setNow(nz(current.getCurrentTime()));
      setDuration(nz(current.getDuration()));
      follow();
      // Whoever last touched playback re-anchors the shared clock so drift stays invisible —
      // but only while this tab is actually playing the room's current film, otherwise a
      // stale local player would push an older video back over a fresh paste.
      if (runtime.isDriver() && runtime.player.playing && current.getPlayerState() === STATE.playing
        && loaded.current === runtime.player.video
        && Date.now() - runtime.lastHeartbeat > HEARTBEAT_MS) {
        runtime.lastHeartbeat = Date.now();
        localWrite.current = Date.now();
        void runtime.setPlayer({ video: runtime.player.video, position: nz(current.getCurrentTime()) * 1000, playing: true }, true);
      }
    }, 400);
    return () => window.clearInterval(tick);
  }, [follow]);

  useEffect(() => { follow(); }, [player.updated, player.video, player.playing, follow]);

  const togglePlay = () => {
    const current = yt.current;
    if (!current || !runtime.player.video) return;
    const playing = current.getPlayerState() === STATE.playing;
    if (playing) current.pauseVideo();
    else { current.playVideo(); setNeedsTap(false); }
    void write({ playing: !playing });
  };

  const nudge = (delta: number) => {
    const current = yt.current;
    if (!current || !runtime.player.video) return;
    const target = Math.max(0, Math.min(nz(current.getCurrentTime()) + delta, nz(current.getDuration()) || 1e9));
    current.seekTo(target, true);
    setNow(target);
    void write({ position: target * 1000 });
  };

  const scrubTo = (fraction: number) => {
    const current = yt.current;
    if (!current || !runtime.player.video || !duration) return;
    const target = Math.max(0, Math.min(fraction * duration, duration));
    current.seekTo(target, true);
    setNow(target);
    void write({ position: target * 1000 });
  };

  const playing = player.playing === 1;
  const shown = drag ?? (duration ? Math.min(now / duration, 1) : 0);
  const driverName = player.updated_by === session?.peer ? 'you' : (peers.find(peer => peer.peer === player.updated_by)?.name ?? 'your partner');

  return (
    <section className="theatre" aria-label="Shared screen">
      <div className={`screen${playing ? ' live' : ''}`}>
        <div className="screen-frame"><div ref={mount} /></div>
        {!player.video && (
          <div className="screen-dark">
            <Clapperboard className="screen-icon" aria-hidden="true" />
            <p className="screen-line">The screen is dark.</p>
            <p className="screen-hint">Paste a YouTube link below — it lights up for both of you at the same second.</p>
          </div>
        )}
        {needsTap && player.video && (
          <button type="button" className="screen-tap" onClick={() => { yt.current?.playVideo(); setNeedsTap(false); }}>
            <Play aria-hidden="true" /> Tap to join the screen
          </button>
        )}
        {issue && <p className="screen-issue" role="status">{issue}</p>}
        {player.video && (
          <div className="screen-top">
            <span className={`pill${runtime.isDriver() ? ' mine' : ''}`}><Sparkles aria-hidden="true" /> {runtime.isDriver() ? 'you are driving' : `${driverName} drives`}</span>
            {other?.online && <span className="pill soft"><span className="dot on" aria-hidden="true" /> {other.name} watching</span>}
          </div>
        )}
      </div>

      <div className="bar">
        <button type="button" className="round" onClick={() => nudge(-10)} aria-label="Back 10 seconds" disabled={!player.video}><RotateCcw aria-hidden="true" /></button>
        <button type="button" className="round big" onClick={togglePlay} aria-label={playing ? 'Pause for both of you' : 'Play for both of you'} disabled={!player.video}>
          {playing ? <Pause aria-hidden="true" /> : <Play aria-hidden="true" />}
        </button>
        <button type="button" className="round" onClick={() => nudge(10)} aria-label="Forward 10 seconds" disabled={!player.video}><RotateCw aria-hidden="true" /></button>
        <div
          className="track"
          role="slider"
          aria-label="Seek through the video"
          aria-valuemin={0}
          aria-valuemax={Math.round(duration)}
          aria-valuenow={Math.round(now)}
          tabIndex={0}
          onPointerDown={event => {
            if (!duration) return;
            const rect = event.currentTarget.getBoundingClientRect();
            setDrag((event.clientX - rect.left) / rect.width);
            event.currentTarget.setPointerCapture(event.pointerId);
          }}
          onPointerMove={event => {
            if (drag === null) return;
            const rect = event.currentTarget.getBoundingClientRect();
            setDrag((event.clientX - rect.left) / rect.width);
          }}
          onPointerUp={() => { if (drag !== null) scrubTo(Math.max(0, Math.min(drag, 1))); setDrag(null); }}
          onPointerCancel={() => setDrag(null)}
          onKeyDown={event => {
            if (event.key === 'ArrowRight') nudge(5);
            else if (event.key === 'ArrowLeft') nudge(-5);
            else if (event.key === ' ' || event.key === 'Enter') { event.preventDefault(); togglePlay(); }
          }}
        >
          <div className="track-fill" style={{ width: `${shown * 100}%` }} />
          <div className="track-knob" style={{ left: `${shown * 100}%` }} />
        </div>
        <span className="time">{clockLabel((drag !== null && duration ? drag * duration : now) * 1000)}<em>/{clockLabel(duration * 1000)}</em></span>
        <button
          type="button"
          className="round quiet"
          aria-label={muted ? 'Unmute for you' : 'Mute for you'}
          title="Mute only changes your own sound"
          onClick={() => {
            const current = yt.current;
            const next = !muted;
            setMuted(next);
            if (next) current?.mute();
            else { current?.unMute(); current?.setVolume(volume); }
            try { localStorage.setItem('little-cinema:sound', JSON.stringify({ volume, muted: next })); } catch { /* preference only */ }
          }}
        >
          {muted ? <VolumeX aria-hidden="true" /> : volume < 45 ? <Volume1 aria-hidden="true" /> : <Volume2 aria-hidden="true" />}
        </button>
      </div>

      <form className="paste" onSubmit={event => { event.preventDefault(); if (link.trim() && loadLink(link)) setLink(''); }}>
        <input
          className="field grow"
          value={link}
          placeholder="Paste a YouTube link…"
          inputMode="url"
          autoCapitalize="none"
          spellCheck={false}
          aria-label="YouTube link"
          onChange={event => setLink(event.target.value)}
        />
        <button type="submit" className="cta small">Play together</button>
        <button type="button" className="ghost" title="Add to the queue instead" aria-label="Add to queue" onClick={() => { if (link.trim() && loadLink(link, true)) setLink(''); }}><Plus aria-hidden="true" /></button>
      </form>

      {title ? <p className="now-playing" title={title}>{title}</p> : null}

      {(player.queue?.length ?? 0) > 0 && (
        <div className="queue">
          <span className="queue-label">Up next</span>
          {player.queue.map((item, index) => (
            <span className="chip" key={`${item.video}-${index}`}>
              <button type="button" className="chip-play" onClick={() => void playIndex(index)} aria-label={`Play ${item.title || 'the next video'} now`}><Play aria-hidden="true" /></button>
              <button type="button" className="chip-text" onClick={() => void playIndex(index)}>{item.title || watchUrl(item.video)}</button>
              <button type="button" className="chip-x" onClick={() => dropFromQueue(index)} aria-label="Remove from queue"><X aria-hidden="true" /></button>
            </span>
          ))}
        </div>
      )}
    </section>
  );
}
