// The call surface: an invite card while the phone rings, then a small floating dock
// so the two of you can keep watching and typing while you talk.
import { useEffect, useRef, useState } from 'react';
import { Maximize2, Mic, MicOff, Minimize2, Phone, PhoneOff, SwitchCamera, Video, VideoOff } from 'lucide-react';
import { toast } from 'sonner';
import { call, useCall } from '@/src/lib/call';
import { runtime, useRoom } from '@/src/lib/useRoom';

const clock = (secs: number) => `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;

function Face({ name, color, ring = false }: { name: string; color: string; ring?: boolean }) {
  return (
    <span className={`face${ring ? ' ringing' : ''}`}>
      <span className="face-inner" style={{ background: color }}>{name.slice(0, 1).toUpperCase()}</span>
    </span>
  );
}

export default function CallLayer() {
  const state = useCall();
  const { peers } = useRoom();
  const [mini, setMini] = useState(false);
  const [remoteVideo, setRemoteVideo] = useState(false);
  const previous = useRef(state.status);

  const partner = peers.find(peer => peer.name === state.peerName) ?? peers.find(peer => peer.peer !== runtime.session?.peer);
  const accent = partner?.color ?? '#ff7ba9';

  useEffect(() => {
    const before = previous.current;
    previous.current = state.status;
    if (state.note) { if (state.status === 'failed') toast.error(state.note); else toast.message(state.note); }
    if ((before === 'live' || before === 'connecting') && state.status === 'idle') toast.message('Call ended');
  }, [state.status, state.note]);

  // Whether the other side is actually sending a picture.
  useEffect(() => {
    const stream = state.remote;
    if (!stream) { setRemoteVideo(false); return; }
    const sync = () => setRemoteVideo(stream.getVideoTracks().some(track => track.readyState === 'live'));
    sync();
    stream.addEventListener('addtrack', sync);
    stream.addEventListener('removetrack', sync);
    return () => {
      stream.removeEventListener('addtrack', sync);
      stream.removeEventListener('removetrack', sync);
    };
  }, [state.remote]);

  useEffect(() => {
    if (state.status === 'idle') return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (state.status === 'incoming') void call.decline();
      else if (state.status === 'calling') void call.decline();
      else void call.hangup();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [state.status]);

  const talking = state.status === 'live' || state.status === 'connecting';

  if (state.status === 'incoming' || state.status === 'calling') {
    return (
      <div className="invite-sheet" role="dialog" aria-modal="true" aria-label={state.status === 'incoming' ? 'Incoming call' : 'Calling'}>
        <div className="invite-card">
          <span className="invite-avatar" style={{ background: accent }}>{state.peerName.slice(0, 1).toUpperCase() || '?'}</span>
          <p className="invite-name">{state.peerName}</p>
          <p className="invite-state">{state.status === 'incoming' ? 'is calling you' : 'calling…'}</p>
          <div className="invite-actions">
            {state.status === 'incoming' ? (
              <>
                <button type="button" className="hang" onClick={() => void call.decline()} aria-label="Decline the call"><PhoneOff aria-hidden="true" /></button>
                <button type="button" className="pick" onClick={() => void call.accept()} aria-label="Accept the call"><Phone aria-hidden="true" /></button>
              </>
            ) : (
              <>
                <span className="invite-pulse" aria-hidden="true" />
                <button type="button" className="hang" onClick={() => void call.decline()} aria-label="Cancel the call"><PhoneOff aria-hidden="true" /><span>cancel</span></button>
              </>
            )}
          </div>
        </div>
      </div>
    );
  }

  if (!talking) return null;

  return (
    <aside className={`call-dock${mini ? ' mini' : ''}`} aria-label="Call in progress">
      <div className="call-stage">
        {state.remote && (remoteVideo || state.video) ? (
          <video
            className="call-video"
            autoPlay
            playsInline
            ref={element => { if (element && element.srcObject !== state.remote) element.srcObject = state.remote; }}
          />
        ) : (
          <div className="call-idle">
            <Face name={state.peerName} color={accent} ring={state.status === 'connecting'} />
            <p>{state.status === 'connecting' ? 'Connecting…' : 'No camera on this call'}</p>
          </div>
        )}

        {state.local?.getVideoTracks().length ? (
          <video
            className="call-self"
            autoPlay
            playsInline
            muted
            ref={element => { if (element && element.srcObject !== state.local) element.srcObject = state.local; }}
          />
        ) : null}

        <div className="call-strip">
          <span className="call-name">{state.peerName}</span>
          <span className="call-clock">{state.status === 'connecting' ? 'ringing through' : clock(state.secs)}</span>
          <button type="button" className="call-mini" onClick={() => setMini(value => !value)} aria-label={mini ? 'Expand the call' : 'Shrink the call'}>
            {mini ? <Maximize2 aria-hidden="true" /> : <Minimize2 aria-hidden="true" />}
          </button>
        </div>
      </div>

      {!mini && (
        <div className="call-controls">
          <button type="button" className={state.micOn ? 'talk' : 'talk off'} onClick={() => call.toggleMic()} aria-pressed={state.micOn} aria-label={state.micOn ? 'Mute your microphone' : 'Unmute your microphone'}>
            {state.micOn ? <Mic aria-hidden="true" /> : <MicOff aria-hidden="true" />}
          </button>
          {state.video && (
            <button type="button" className={state.camOn ? 'talk' : 'talk off'} onClick={() => call.toggleCam()} aria-pressed={state.camOn} aria-label={state.camOn ? 'Turn your camera off' : 'Turn your camera on'}>
              {state.camOn ? <Video aria-hidden="true" /> : <VideoOff aria-hidden="true" />}
            </button>
          )}
          {state.video && state.camOn && (
            <button type="button" className="talk" onClick={() => void call.flipCamera()} aria-label="Switch to the other camera">
              <SwitchCamera aria-hidden="true" />
            </button>
          )}
          <button type="button" className="hang" onClick={() => void call.hangup()} aria-label="End the call"><PhoneOff aria-hidden="true" /></button>
        </div>
      )}
    </aside>
  );
}
