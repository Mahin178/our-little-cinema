import { useState } from 'react';
import { runtime } from '@/src/lib/runtime';
import { explain, isLocalPreview } from '@/src/lib/api';
import type { Session } from '@/src/lib/types';

// The first swatch matches the runtime default, so a first visit is never unselected.
const COLORS = ['#ff8fb1', '#a78bfa', '#7fd8c4', '#ffc978', '#ff9a76', '#8ab6ff'];

export default function Join({ known, invite, serviceDown, onEnter }: { known: Session | null; invite: string; serviceDown?: boolean; onEnter?: () => void }) {
  const [name, setName] = useState(runtime.identity.name || '');
  const [color, setColor] = useState(runtime.identity.color || COLORS[0]);
  const [code, setCode] = useState(invite);
  const [mode, setMode] = useState<'create' | 'join'>(invite ? 'join' : 'create');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const go = async (which: 'create' | 'join') => {
    if (busy) return;
    setBusy(true);
    setError('');
    const joined = which === 'join' ? code.trim().toLowerCase() : '';
    try {
      // Re-adding the same room keeps this person's identity; a different room is a new peer.
      await runtime.enter({
        name,
        color,
        code: which === 'join' ? joined : undefined,
        known: which === 'join' && known && joined === known.code ? known : undefined,
      });
      window.history.replaceState({}, '', `?r=${runtime.session?.code}`);
      onEnter?.();
    } catch (cause) {
      setError(explain(cause));
      setBusy(false);
    }
  };

  return (
    <main className="join-wrap">
      <div className="join-card">
        <div className="join-mark" aria-hidden="true">
          <span className="join-reel" />
          <span className="join-heart" />
        </div>
        <h1 className="join-title">Our Little Cinema</h1>
        <p className="join-sub">A tiny private room where the two of you press play at the same time, even when the miles say otherwise.</p>

        {serviceDown && (
          <p className="join-warn" role="status">
            This copy of the cinema is not reaching its room service yet, so joining will not work.
            {isLocalPreview()
              ? ' Start it with npm run dev, which brings the local service up beside the page.'
              : ' If this site was deployed on its own, its owner still needs to connect the backend.'}
          </p>
        )}

        <label className="field-label" htmlFor="join-name">What should they see you as?</label>
        <input
          id="join-name"
          className="field"
          value={name}
          maxLength={24}
          autoComplete="nickname"
          placeholder="your nickname"
          onChange={event => setName(event.target.value)}
        />

        <span className="field-label">Pick your colour</span>
        <div className="swatches" role="radiogroup" aria-label="avatar colour">
          {COLORS.map(option => (
            <button
              key={option}
              type="button"
              role="radio"
              aria-checked={color === option}
              className={`swatch${color === option ? ' on' : ''}`}
              style={{ background: option }}
              onClick={() => setColor(option)}
            />
          ))}
        </div>

        <div className="tabs" role="tablist">
          <button type="button" role="tab" aria-selected={mode === 'create'} className={`tab${mode === 'create' ? ' on' : ''}`} onClick={() => { setMode('create'); setError(''); }}>Start a room</button>
          <button type="button" role="tab" aria-selected={mode === 'join'} className={`tab${mode === 'join' ? ' on' : ''}`} onClick={() => { setMode('join'); setError(''); }}>I have a code</button>
        </div>

        {mode === 'join' && (
          <>
            <label className="field-label" htmlFor="join-code">Room code</label>
            <input
              id="join-code"
              className="field mono"
              value={code}
              maxLength={12}
              autoCapitalize="none"
              spellCheck={false}
              placeholder="abcdefghij"
              onChange={event => setCode(event.target.value.trim().toLowerCase())}
              onKeyDown={event => { if (event.key === 'Enter') void go('join'); }}
            />
          </>
        )}

        <button className="cta" type="button" disabled={busy || !name.trim() || (mode === 'join' && code.trim().length < 8)} onClick={() => void go(mode)}>
          {busy ? 'Opening the doors…' : mode === 'create' ? 'Start our cinema' : 'Join the room'}
        </button>

        {error && <p className="form-error" role="alert">{error}</p>}
        {isLocalPreview() && <p className="local-note">Local preview · sample data only, nothing is stored. <a href="/__local/">test console</a></p>}
        <p className="join-foot">Paste a YouTube link, and it plays in perfect step for both of you. Chat, voice notes, photos, silly stickers and video calls come included.</p>
      </div>
    </main>
  );
}
