import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle, Heart, Pause, Phone, Play, Popcorn, Sparkles, Video } from 'lucide-react';
import { runtime, useMessages, useRoom } from '@/src/lib/useRoom';
import type { ChatMessage } from '@/src/lib/useRoom';
import { parseVoice } from '@/src/lib/types';
import { REACTIONS, stickerById } from '@/src/lib/stickers';

const dayKey = (ms: number) => new Date(ms).toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
const timeOf = (ms: number) => new Date(ms).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

/** Signed media URLs expire, so the runtime re-signs them and bumps a version stamp. */
function useMediaUrl(id: string | null) {
  const { mediaVersion } = useRoom();
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!id) { setUrl(null); return; }
    setUrl(runtime.mediaUrl(id));
  }, [id, mediaVersion]);
  return url;
}

function Photo({ message, onOpen }: { message: ChatMessage; onOpen: (url: string) => void }) {
  const url = useMediaUrl(message.media);
  if (!url) return <div className="media-skeleton" aria-busy="true" aria-label="Loading photo" />;
  return (
    <button type="button" className="photo" onClick={() => onOpen(url)}>
      <img
        src={url}
        alt={`Photo from ${message.name}`}
        loading="lazy"
        onError={() => message.media && runtime.invalidateMedia(message.media)}
      />
    </button>
  );
}

function VoiceBubble({ message }: { message: ChatMessage }) {
  const url = useMediaUrl(message.media);
  const audio = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [ratio, setRatio] = useState(0);
  const meta = useMemo(() => parseVoice(message), [message.body]);
  const bars = meta.peaks.length ? meta.peaks : Array.from({ length: 22 }, (_, index) => 0.3 + Math.abs(Math.sin(index * 0.7)) * 0.45);

  useEffect(() => () => { audio.current?.pause(); }, []);

  /** MediaRecorder webm has no duration header, so fall back to the recorded seconds. */
  const totalSeconds = () => {
    const duration = audio.current?.duration;
    return duration && Number.isFinite(duration) && duration > 0 ? duration : meta.secs;
  };

  const toggle = () => {
    const element = audio.current;
    if (!element || !url) return;
    if (playing) { element.pause(); setPlaying(false); return; }
    try { element.currentTime = 0; } catch { /* nothing loaded yet; play starts it */ }
    // A rejected play() (autoplay policy, unsupported codec) must not leave the pill stuck.
    element.play().then(() => setPlaying(true)).catch(() => { setPlaying(false); setRatio(0); });
  };

  const label = meta.secs < 60 ? `${Math.round(meta.secs)} sec` : `${Math.floor(meta.secs / 60)} min ${Math.round(meta.secs % 60)} sec`;

  return (
    <div className="voice">
      <button type="button" className="round small" onClick={toggle} aria-label={playing ? `Pause ${label}` : `Play ${label}`}>
        {playing ? <Pause aria-hidden="true" /> : <Play aria-hidden="true" />}
      </button>
      <div className="wave">
        {bars.slice(0, 34).map((peak, index) => (
          <i
            key={index}
            style={{
              height: `${Math.max(16, Math.min(100, peak * 120))}%`,
              background: playing && index / bars.length <= ratio ? 'currentColor' : undefined,
            }}
          />
        ))}
      </div>
      <span className="voice-time">{meta.secs < 60 ? `${Math.round(meta.secs)}″` : `${Math.floor(meta.secs / 60)}:${String(Math.round(meta.secs % 60)).padStart(2, '0')}`}</span>
      {url && (
        <audio
          // React owns src here. Assigning it inside a callback ref re-runs on every render,
          // and each reassignment restarts the media load — which silently cancelled playback.
          ref={audio}
          src={url}
          onTimeUpdate={() => setRatio(audio.current?.currentTime ? audio.current.currentTime / Math.max(0.1, totalSeconds()) : 0)}
          onEnded={() => { setPlaying(false); setRatio(0); }}
          onPause={() => setPlaying(false)}
          onError={() => {
            setPlaying(false);
            // A source that never started loading is usually an expired signature; re-sign it.
            if (message.media && audio.current?.readyState === 0) runtime.invalidateMedia(message.media);
          }}
          preload="none"
        />
      )}
    </div>
  );
}

function Bubble({ message, mine, showName, showAvatar, onPhoto, onDoubleTap }: {
  message: ChatMessage;
  mine: boolean;
  showName: boolean;
  showAvatar: boolean;
  onPhoto: (url: string) => void;
  onDoubleTap: (message: ChatMessage) => void;
}) {
  const [menu, setMenu] = useState(false);
  const [burst, setBurst] = useState(0);
  const sticker = message.kind === 'sticker' ? stickerById(message.body) : null;
  const reactions = Object.entries(message.reactions ?? {}).filter(([, who]) => who.length);

  // Instagram's shortcut: a double tap loves the message outright, with the heart pop for feedback.
  const doubleTap = () => {
    if (message.kind === 'system' || message.kind === 'recalled') return;
    setBurst(value => value + 1);
    onDoubleTap(message);
  };

  return (
    <li className={`row${mine ? ' me' : ''}${message.kind === 'sticker' ? ' alone' : ''}`} onDoubleClick={doubleTap}>
      {burst > 0 && <span key={burst} className="heart-burst" aria-hidden="true" onAnimationEnd={() => setBurst(0)}>❤️</span>}
      {!mine && showAvatar && (
        <span className="row-face" style={{ background: message.color }} aria-hidden="true">{message.name.slice(0, 1).toUpperCase()}</span>
      )}
      <div className={`bubble-wrap${menu ? ' menu-open' : ''}`}>
        {showName && !mine && message.kind !== 'system' && <span className="row-name" style={{ color: message.color }}>{message.name}</span>}
        {message.kind === 'system' ? (
          <p className="system-line">{message.body}</p>
        ) : message.kind === 'recalled' ? (
          <p className="system-line"><Sparkles aria-hidden="true" /> {mine ? 'You' : message.name} recalled a message</p>
        ) : message.kind === 'sticker' && sticker ? (
          <div className={`sticker anim-${sticker.anim}`} role="img" aria-label={sticker.label}>{sticker.glyph}</div>
        ) : message.kind === 'image' ? (
          <Photo message={message} onOpen={onPhoto} />
        ) : message.kind === 'voice' ? (
          <VoiceBubble message={message} />
        ) : (
          <p className="bubble">{message.body}</p>
        )}
        {reactions.length > 0 && (
          <div className="reacts">
            {reactions.map(([emoji, who]) => (
              <button
                key={emoji}
                type="button"
                className={`react${who.includes(message.peer) ? ' own' : ''}`}
                onClick={() => void runtime.react(message.id, emoji)}
                aria-label={`${who.length} reaction${who.length > 1 ? 's' : ''} ${emoji}`}
              >{emoji}<b>{who.length}</b></button>
            ))}
          </div>
        )}
        <div className="row-foot">
          <time>{timeOf(message.created)}</time>
          {message.pending && <span className="sending">sending…</span>}
          {message.uploading && <span className="sending">{message.uploading}</span>}
          {message.failed && (
            <button type="button" className="retry" onClick={() => void runtime.retry(message.id)}>
              <AlertCircle aria-hidden="true" /> not sent · tap to retry
            </button>
          )}
        </div>
        {message.kind !== 'recalled' && message.kind !== 'system' && (
          <button type="button" className="row-menu" aria-label="Message reactions" aria-expanded={menu} onClick={() => setMenu(value => !value)}>
            <Heart aria-hidden="true" />
          </button>
        )}
        {menu && (
          <div className="quick-reacts" role="menu">
            {REACTIONS.map(emoji => (
              <button key={emoji} type="button" role="menuitem" onClick={() => { void runtime.react(message.id, emoji); setMenu(false); }}>{emoji}</button>
            ))}
            {mine && (
              <button type="button" role="menuitem" className="recall" onClick={() => { void runtime.recall(message.id); setMenu(false); }}>recall</button>
            )}
          </div>
        )}
      </div>
    </li>
  );
}

export default function Chat({ onCall }: { onCall: (video: boolean) => void }) {
  const messages = useMessages();
  const { session, peers, loadingOlder, atBottom } = useRoom();
  const list = useRef<HTMLDivElement | null>(null);
  const anchor = useRef<{ bottom: boolean; sh: number; st: number } | null>(null);
  const [photo, setPhoto] = useState('');
  const typing = runtime.typingPeer();
  const seenThrough = runtime.seenThrough();
  const me = session?.peer ?? '';
  const partner = peers.find(peer => peer.peer !== me) ?? null;
  const lastMine = useMemo(() => [...messages].reverse().find(row => row.peer === session?.peer && !row.pending && !row.failed), [messages, session?.peer]);

  const grouped = useMemo(() => {
    const out: { day: string; items: ChatMessage[] }[] = [];
    for (const message of messages) {
      const day = dayKey(message.created);
      const bucket = out[out.length - 1];
      if (bucket?.day === day) bucket.items.push(message);
      else out.push({ day, items: [message] });
    }
    return out;
  }, [messages]);

  const stick = useCallback((smooth = false) => {
    const element = list.current;
    if (!element) return;
    element.scrollTop = element.scrollHeight;
    if (smooth) element.scrollTo({ top: element.scrollHeight, behavior: 'smooth' });
  }, []);

  // Remember where the reader was before older messages arrive.
  const loadOlder = useCallback(() => {
    const element = list.current;
    if (!element || runtime.loadingOlder || !messages.length) return;
    anchor.current = { bottom: runtime.atBottom, sh: element.scrollHeight, st: element.scrollTop };
    void runtime.loadOlder();
  }, [messages.length]);

  useLayoutEffect(() => {
    const element = list.current;
    if (!element) return;
    if (anchor.current) {
      const { sh, st } = anchor.current;
      element.scrollTop = element.scrollHeight - sh + st;
      anchor.current = null;
      return;
    }
    if (runtime.atBottom) stick();
  }, [messages, stick]);

  const onScroll = () => {
    const element = list.current;
    if (!element) return;
    const nearBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 130;
    runtime.setAtBottom(nearBottom);
    if (element.scrollTop < 80) loadOlder();
  };

  const status = !partner
    ? 'Send the invite link and they appear here'
    : typing?.peer === partner.peer
      ? 'Typing…'
      : partner.online ? 'Active now' : 'Away';

  return (
    <section className="chat" aria-label="Messages">
      <header className="chat-head">
        {partner ? (
          <span className={`chat-face${partner.online ? ' live' : ''}`} style={{ background: partner.color }} aria-hidden="true">
            {partner.name.slice(0, 1).toUpperCase()}
          </span>
        ) : (
          <span className="chat-face alone" aria-hidden="true"><Popcorn /></span>
        )}
        <span className="chat-who">
          <strong>{partner?.name ?? 'Your second seat'}</strong>
          <span className="chat-state">{status}</span>
        </span>
        <span className="chat-calls">
          <button type="button" className="round small" onClick={() => onCall(false)} aria-label="Start a voice call" title="Voice call"><Phone aria-hidden="true" /></button>
          <button type="button" className="round small" onClick={() => onCall(true)} aria-label="Start a video call" title="Video call"><Video aria-hidden="true" /></button>
        </span>
      </header>
      <div className="chat-scroll" ref={list} onScroll={onScroll}>
        {loadingOlder && <p className="older-note">loading earlier messages…</p>}
        {messages.length === 0 && !loadingOlder && (
          <div className="chat-empty">
            <p className="big-line">Say something sweet.</p>
            <p className="small-line">Photos, voice notes, silly stickers — all of it lands here in real time.</p>
          </div>
        )}
        {grouped.map(bucket => (
          <div key={bucket.day}>
            <p className="day"><span>{bucket.day}</span></p>
            <ul className="rows">
              {bucket.items.map((message, index) => {
                const previous = bucket.items[index - 1];
                const next = bucket.items[index + 1];
                const showName = !previous || previous.peer !== message.peer || message.created - previous.created > 180_000;
                // Instagram hangs the face on the last message of a run, not the first.
                const showAvatar = !next || next.peer !== message.peer || next.created - message.created > 180_000;
                return (
                  <Bubble
                    key={message.id}
                    message={message}
                    mine={message.peer === session?.peer}
                    showName={showName}
                    showAvatar={showAvatar}
                    onPhoto={setPhoto}
                    onDoubleTap={row => void runtime.react(row.id, '\u2764\uFE0F')}
                  />
                );
              })}
            </ul>
          </div>
        ))}
        {typing && <p className="typing"><span style={{ color: typing.color }}>{typing.name}</span> is typing<i /><i /><i /></p>}
        {lastMine && seenThrough >= lastMine.created && (
          <p className="seen-line"><span aria-hidden="true">✓✓</span> seen {timeOf(seenThrough)}</p>
        )}
      </div>
      {!atBottom && <button type="button" className="jump" onClick={() => { runtime.setAtBottom(true); stick(true); }}>new messages below</button>}
      {photo && (
        <div className="lightbox" role="dialog" aria-label="Photo, close on click" onClick={() => setPhoto('')}>
          <img src={photo} alt="Full size photo from your partner" />
          <p className="lightbox-hint">tap anywhere to close</p>
        </div>
      )}
    </section>
  );
}
