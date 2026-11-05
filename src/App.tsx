import { useEffect, useState } from 'react';
import { Toaster } from 'sonner';
import Join from '@/src/components/Join';
import Room from '@/src/components/Room';
import { BackendError } from '@/src/lib/api';
import { call } from '@/src/lib/call';
import { runtime } from '@/src/lib/runtime';

// StrictMode runs effects twice in development; a room re-entry must not happen twice.
let resumed = false;

export default function App() {
  const [screen, setScreen] = useState<'boot' | 'join' | 'room'>('boot');

  useEffect(() => {
    if (resumed) return;
    resumed = true;
    const saved = runtime.load();
    const invite = (new URLSearchParams(window.location.search).get('r') ?? '').trim().toLowerCase();
    if (!saved) {
      setScreen('join');
      return;
    }
    call.watch();
    // Quietly take the same seat again; if the room is gone, the front door reopens.
    void runtime
      .enter({ name: runtime.identity.name, color: runtime.identity.color, code: saved.code, known: saved })
      .then(() => setScreen('room'))
      .catch(error => {
        const gone = error instanceof BackendError && (error.code === 'room_not_found' || error.code === 'not_a_member');
        if (gone) {
          runtime.forget();
          setScreen('join');
          return;
        }
        // Offline is not a lost room: the live loop keeps retrying on its own.
        setScreen('room');
      });
  }, []);

  const invite = (new URLSearchParams(window.location.search).get('r') ?? '').trim().toLowerCase();

  return (
    <>
      {screen === 'join' && <Join known={null} invite={invite} onEnter={() => setScreen('room')} />}
      {screen === 'room' && <Room onLeave={() => setScreen('join')} />}
      {screen === 'boot' && (
        <main className="join-wrap">
          <p className="boot-note" role="status">Turning the projector on…</p>
        </main>
      )}
      <Toaster
        position="top-center"
        offset={12}
        toastOptions={{
          style: { background: '#fffdfd', color: '#43333d', border: '1px solid #f6dfe6', borderRadius: '16px', fontSize: '13.5px', boxShadow: '0 12px 30px -12px rgba(120, 60, 90, .35)' },
        }}
      />
    </>
  );
}
