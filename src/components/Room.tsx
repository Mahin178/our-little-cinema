// The room around the screen: who is here, how to bring them in, the call buttons,
// and the switch between the cinema and the chat.
import { useEffect, useState } from 'react';
import { Clapperboard, Copy, LogOut, MessageCircle, Phone, Popcorn, Settings, Video, WifiOff, X } from 'lucide-react';
import { toast } from 'sonner';
import Theatre from './Theatre';
import Chat from './Chat';
import Composer from './Composer';
import CallLayer from './CallLayer';
import { call, readTurn, writeTurn } from '@/src/lib/call';
import { runtime, useMessages, useRoom } from '@/src/lib/useRoom';

async function copy(value: string, done: string) {
  try {
    await navigator.clipboard.writeText(value);
    toast.success(done);
    return;
  } catch { /* older browsers and http origins fall through */ }
  try {
    const field = document.createElement('textarea');
    field.value = value;
    field.setAttribute('readonly', '');
    field.style.position = 'fixed';
    field.style.opacity = '0';
    document.body.appendChild(field);
    field.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(field);
    if (ok) toast.success(done);
    else toast.message(`Copy it by hand: ${value}`);
  } catch {
    toast.message(`Copy it by hand: ${value}`);
  }
}

function Face({ name, color, online, empty = false }: { name: string; color: string; online?: boolean; empty?: boolean }) {
  if (empty) return <span className="face" title="Waiting for them to join"><span className="face-inner ghost-face"><Popcorn aria-hidden="true" /></span></span>;
  return (
    <span className="face" title={`${name}${online ? ' · here now' : ' · away'}`}>
      <span className="face-inner" style={{ background: color, opacity: online ? 1 : 0.45 }}>{name.slice(0, 1).toUpperCase()}</span>
      <i className={`face-badge${online ? ' on' : ''}`} aria-hidden="true" />
    </span>
  );
}

export default function Room({ onLeave }: { onLeave: () => void }) {
  const { session, peers, connected, connecting, error, identity } = useRoom();
  const messages = useMessages();
  const [tab, setTab] = useState<'cinema' | 'chat'>('cinema');
  const [sheet, setSheet] = useState(false);
  const [seenAt, setSeenAt] = useState(() => Date.now());
  const [turn, setTurn] = useState(() => {
    const saved = readTurn()[0] as { urls?: string; username?: string; credential?: string } | undefined;
    return { urls: saved?.urls ?? '', username: saved?.username ?? '', credential: saved?.credential ?? '' };
  });

  useEffect(() => { call.watch(); }, []);

  const me = session?.peer ?? '';
  const partner = peers.find(peer => peer.peer !== me) ?? null;
  const invite = `${window.location.origin}${window.location.pathname}?r=${session?.code ?? ''}`;
  const unread = messages.filter(row => row.peer !== me && row.created > seenAt && !row.pending && row.kind !== 'system').length;
  const dead = error === 'room_not_found' || error === 'not_a_member';

  const openChat = () => { setTab('chat'); setSeenAt(Date.now()); };

  const startCall = (video: boolean) => {
    if (!partner) {
      toast.error('They are not in the room yet. Send them the invite link first.');
      return;
    }
    call.watch();
    void call.start({ peer: partner.peer, name: partner.name }, video);
  };

  useEffect(() => {
    if (!sheet) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') setSheet(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [sheet]);

  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true"><Clapperboard /></span>
          <span className="brand-text">
            <span className="brand-name">Our Little Cinema</span>
            <span className="brand-sub">{partner ? `${partner.online ? 'two seats warm' : 'saving their seat'}` : 'a room for two'}</span>
          </span>
        </div>

        <div className="faces">
          <Face name={identity.name} color={identity.color} online />
          {partner
            ? <Face name={partner.name} color={partner.color} online={partner.online} />
            : <Face name="" color="" online={false} empty />}
        </div>

        <div className="actions">
          <button type="button" className="code-chip" onClick={() => void copy(session?.code ?? '', 'Room code copied — send it to them.')} title="Copy the room code">
            <Copy aria-hidden="true" /> {session?.code}
          </button>
          <button type="button" className="round small" onClick={() => startCall(true)} aria-label="Start a video call" title="Video call"><Video aria-hidden="true" /></button>
          <button type="button" className="round small" onClick={() => startCall(false)} aria-label="Start a voice call" title="Voice call"><Phone aria-hidden="true" /></button>
          <button type="button" className="quiet" onClick={() => setSheet(true)} aria-label="Room settings" aria-expanded={sheet} title="Settings"><Settings aria-hidden="true" /></button>
        </div>
      </header>

      {dead ? (
        <p className="net-note bad" role="status">
          <WifiOff aria-hidden="true" /> This room no longer exists here.
          <button type="button" className="linkline" onClick={onLeave}>Start a new one</button>
        </p>
      ) : !connected ? (
        <p className="net-note" role="status"><WifiOff aria-hidden="true" /> {connecting ? 'reconnecting…' : 'offline — it keeps retrying by itself'}</p>
      ) : null}

      <main className="stage" data-tab={tab}>
        <section className="pane cinema-pane"><Theatre /></section>
        <section className="pane chat-pane"><Chat onCall={startCall} /><Composer /></section>
      </main>

      <nav className="mobile-tabs" role="tablist" aria-label="Cinema or chat">
        <button type="button" role="tab" aria-selected={tab === 'cinema'} className={`tab-btn${tab === 'cinema' ? ' on' : ''}`} onClick={() => setTab('cinema')}>
          <Clapperboard aria-hidden="true" /><span>Cinema</span>
        </button>
        <button type="button" role="tab" aria-selected={tab === 'chat'} className={`tab-btn${tab === 'chat' ? ' on' : ''}`} onClick={openChat}>
          <MessageCircle aria-hidden="true" /><span>Chat</span>
          {tab !== 'chat' && unread > 0 && <em className="badge">{unread > 9 ? '9+' : unread}</em>}
        </button>
        <button type="button" className="tab-btn invite" onClick={() => void copy(invite, 'Invite link copied — send it in any chat app.')}>
          <Copy aria-hidden="true" /><span>Invite</span>
        </button>
      </nav>

      {sheet && (
        <div className="sheet-veil" onClick={() => setSheet(false)}>
          <div className="sheet" role="dialog" aria-modal="true" aria-label="Room settings" onClick={event => event.stopPropagation()}>
            <button type="button" className="sheet-x" onClick={() => setSheet(false)} aria-label="Close settings"><X aria-hidden="true" /></button>
            <h2 className="sheet-title">Little settings</h2>

            <p className="sheet-label">Invite</p>
            <p className="sheet-note">Anyone with this link takes a seat in your room. Keep it between the two of you.</p>
            <button type="button" className="cta small wide" onClick={() => void copy(invite, 'Invite link copied.')}>Copy the invite link</button>

            <p className="sheet-label">Call relay (only if calls won’t connect)</p>
            <p className="sheet-note">Calls run directly between the two of you. Some networks — mobile data, hotels, strict offices — need a relay. If you have a TURN address, save it here; it stays on this device and never leaves your browser.</p>
            <label className="field-label" htmlFor="turn-urls">Server</label>
            <input id="turn-urls" className="field mono" value={turn.urls} placeholder="turn:relay.example.com:3478" autoCapitalize="none" spellCheck={false} onChange={event => setTurn({ ...turn, urls: event.target.value })} />
            <label className="field-label" htmlFor="turn-user">Username</label>
            <input id="turn-user" className="field" value={turn.username} autoCapitalize="none" spellCheck={false} onChange={event => setTurn({ ...turn, username: event.target.value })} />
            <label className="field-label" htmlFor="turn-pass">Credential</label>
            <input id="turn-pass" className="field" type="password" value={turn.credential} autoComplete="off" onChange={event => setTurn({ ...turn, credential: event.target.value })} />
            <div className="sheet-actions">
              <button type="button" className="cta small" onClick={() => { writeTurn(turn); setSheet(false); toast.success('Relay saved for the next call.'); }}>Save relay</button>
              <button type="button" className="ghost" onClick={() => { writeTurn({ urls: '', username: '', credential: '' }); setTurn({ urls: '', username: '', credential: '' }); toast.message('Relay cleared.'); }}>Clear</button>
            </div>

            <p className="sheet-divider" />
            <button type="button" className="ghost danger" onClick={() => { call.dispose(); runtime.forget(); setSheet(false); onLeave(); }}>
              <LogOut aria-hidden="true" /> Leave this room on this device
            </button>
          </div>
        </div>
      )}

      <CallLayer />
    </div>
  );
}
