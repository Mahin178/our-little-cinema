import { useEffect, useRef, useState } from 'react';
import { Image as ImageIcon, Mic, Send, Smile, Sparkles, Trash2, X } from 'lucide-react';
import { toast } from 'sonner';
import EmojiKeyboard from '@/src/components/EmojiKeyboard';
import { runtime } from '@/src/lib/runtime';
import { STICKERS } from '@/src/lib/stickers';
import { clockLabel } from '@/src/lib/youtube';

const MAX_SECONDS = 120;

/** The composer grows with the message but stops at four lines, like Instagram's box. */
function grow(element: HTMLTextAreaElement) {
  element.style.height = 'auto';
  element.style.height = `${Math.min(element.scrollHeight, 132)}px`;
}

export default function Composer() {
  const [text, setText] = useState('');
  const [tray, setTray] = useState<'none' | 'emoji' | 'sticker'>('none');
  const [recording, setRecording] = useState(false);
  const [secs, setSecs] = useState(0);
  const [levels, setLevels] = useState<number[]>([]);
  const [sending, setSending] = useState(false);
  const area = useRef<HTMLTextAreaElement | null>(null);
  const file = useRef<HTMLInputElement | null>(null);

  const recorder = useRef<MediaRecorder | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const ctx = useRef<AudioContext | null>(null);
  const meter = useRef<number | null>(null);
  const timer = useRef<number | null>(null);
  const startedAt = useRef(0);
  const peaks = useRef<number[]>([]);
  // Synchronous claim on the mic. State updates are async, so `recording` alone lets a fast
  // double-tap start two recorders, and an interval callback reads a stale `recording` forever.
  const live = useRef(false);

  useEffect(() => () => {
    // A torn-down composer must not finish a recording into the room.
    live.current = false;
    if (recorder.current) recorder.current.onstop = null;
    void stopAll();
  }, []);

  const send = async () => {
    const value = text.trim();
    if (!value || sending) return;
    setSending(true);
    setText('');
    // Keep the emoji sheet open after a send; Instagram does, and a second message usually
    // wants another one. The sticker tray closes because its tap already sent a sticker.
    setTray(value => (value === 'emoji' ? value : 'none'));
    const result = await runtime.sendText(value);
    if (!result) toast.error('Not sent. Tap the bubble to try again.');
    setSending(false);
    area.current?.focus();
  };

  const pickPhoto = async (chosen: File | undefined) => {
    if (!chosen) return;
    if (!chosen.type.startsWith('image/')) { toast.error('That file is not a photo.'); return; }
    const result = await runtime.sendImage(chosen);
    if (!result) toast.error('The photo could not be sent.');
  };

  /** Inserts at the caret when the message box already has focus, otherwise appends.
   *  Focus is deliberately not stolen back: on a phone that would raise the system
   *  keyboard on top of the picker. */
  const insertEmoji = (emoji: string) => {
    const element = area.current;
    const focused = !!element && document.activeElement === element;
    const caret = focused ? element.selectionStart ?? text.length : text.length;
    const next = (text.slice(0, caret) + emoji + text.slice(caret)).slice(0, 2000);
    setText(next);
    const after = Math.min(caret + emoji.length, next.length);
    window.requestAnimationFrame(() => {
      const box = area.current;
      if (!box) return;
      if (focused) box.setSelectionRange(after, after);
      grow(box);
    });
  };

  /** Frees the microphone. Kept separate because MediaRecorder is still writing its tail
   *  when stop() returns; killing the tracks too early truncates the last packet. */
  const releaseInput = () => {
    stream.current?.getTracks().forEach(track => track.stop());
    stream.current = null;
    try { void ctx.current?.close(); } catch { /* already closed */ }
    ctx.current = null;
  };

  const stopAll = async (releaseNow = true) => {
    if (timer.current) window.clearInterval(timer.current);
    if (meter.current) window.clearInterval(meter.current);
    timer.current = null;
    meter.current = null;
    // stop() throws when the recorder already finished; an uncaught throw here would skip teardown.
    if (recorder.current && recorder.current.state !== 'inactive') recorder.current.stop();
    if (releaseNow) releaseInput();
    if (releaseNow) recorder.current = null;
  };

  const micFailure = (error: unknown) => {
    const name = error instanceof DOMException ? error.name : '';
    if (!window.isSecureContext) return 'Voice notes need a secure address. Open the site over https and try again.';
    if (!navigator.mediaDevices?.getUserMedia) return 'This browser has no microphone access. Try Chrome, Safari or Firefox.';
    if (name === 'NotAllowedError' || name === 'SecurityError') return 'Microphone blocked — allow it in your browser settings, then tap again.';
    if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'No microphone found. Plug one in or check your device settings.';
    if (name === 'NotReadableError') return 'Something else is using the microphone. Close it and tap again.';
    return 'The microphone would not start. Tap again to try once more.';
  };

  const beginRecording = async () => {
    if (live.current) return;
    if (!window.MediaRecorder) { toast.error('This browser cannot record voice notes yet.'); return; }
    live.current = true;
    try {
      const media = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      stream.current = media;
      peaks.current = [];
      setLevels([]);
      setSecs(0);
      startedAt.current = Date.now();

      const AudioCtor = window.AudioContext ?? (window as any).webkitAudioContext;
      if (AudioCtor) {
        const audio = new AudioCtor();
        ctx.current = audio;
        // iOS starts every AudioContext suspended until a gesture unlocks it; without this
        // the waveform stays flat for the whole take.
        if (audio.state === 'suspended') { try { await audio.resume(); } catch { /* meter only; recording continues */ } }
        const analyser = audio.createAnalyser();
        analyser.fftSize = 512;
        audio.createMediaStreamSource(media).connect(analyser);
        const buffer = new Uint8Array(analyser.frequencyBinCount);
        meter.current = window.setInterval(() => {
          analyser.getByteFrequencyData(buffer);
          const average = buffer.reduce((total, value) => total + value, 0) / buffer.length;
          const level = Math.max(0.08, Math.min(1, average / 140));
          peaks.current = [...peaks.current, level].slice(-90);
          setLevels(peaks.current.slice(-34));
        }, 100);
      }

      const type = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'].find(candidate => MediaRecorder.isTypeSupported(candidate)) ?? '';
      const rec = new MediaRecorder(media, type ? { mimeType: type } : undefined);
      recorder.current = rec;
      const chunks: BlobPart[] = [];
      rec.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
      rec.onstop = async () => {
        const seconds = (Date.now() - startedAt.current) / 1000;
        // The last packet can land a beat after the stop event, so give the bytes a moment.
        if (!chunks.length) await new Promise(resolve => window.setTimeout(resolve, 150));
        const blob = new Blob(chunks, { type: (rec.mimeType || 'audio/webm').split(';')[0] });
        releaseInput();
        if (seconds < 0.7) { toast.error('That was too short to hear anything.'); return; }
        if (!blob.size) { toast.error('The recording came out empty. Tap the mic and try again.'); return; }
        const result = await runtime.sendVoice(blob, seconds, peaks.current.filter((_, index) => index % 2 === 0).slice(0, 60));
        if (!result) toast.error('The voice note could not be sent.');
      };
      rec.start();
      setRecording(true);
      timer.current = window.setInterval(() => {
        const elapsed = (Date.now() - startedAt.current) / 1000;
        setSecs(elapsed);
        if (elapsed >= MAX_SECONDS) void finishRecording();
      }, 200);
    } catch (error) {
      live.current = false;
      toast.error(micFailure(error));
      void stopAll();
      setRecording(false);
    }
  };

  const finishRecording = async () => {
    if (!live.current) return;
    live.current = false;
    setRecording(false);
    // Stop the recorder but leave the mic open a moment: onstop reads the final chunks,
    // then releases the input. Closing tracks first truncates the tail of the note.
    await stopAll(false);
  };

  const cancelRecording = async () => {
    const rec = recorder.current;
    live.current = false;
    setRecording(false);
    if (rec) rec.onstop = null;
    await stopAll();
    setLevels([]);
  };

  return (
    <div className="composer" data-tray={tray}>
      {recording && (
        <div className="recorder">
          <span className="rec-dot" aria-hidden="true" />
          <span className="rec-time">{clockLabel(secs * 1000)}</span>
          <div className="rec-wave" aria-hidden="true">
            {levels.length ? levels.map((level, index) => <i key={index} style={{ height: `${Math.max(12, level * 100)}%` }} />) : <i style={{ height: '12%' }} />}
          </div>
          <button type="button" className="quiet" onClick={() => void cancelRecording()} aria-label="Discard recording"><Trash2 aria-hidden="true" /></button>
          <button type="button" className="cta small" onClick={() => void finishRecording()}>Send voice</button>
        </div>
      )}

      {!recording && tray === 'emoji' && (
        <EmojiKeyboard onPick={insertEmoji} onClose={() => setTray('none')} />
      )}

      {!recording && tray === 'sticker' && (
        <div className="tray" role="region" aria-label="Sticker pack">
          <button type="button" className="tray-x" onClick={() => setTray('none')} aria-label="Close tray"><X aria-hidden="true" /></button>
          <div className="tray-grid">
            {STICKERS.map(item => (
              <button
                key={item.id}
                type="button"
                title={item.label}
                aria-label={`Send the ${item.label} sticker`}
                onClick={() => { void runtime.sendSticker(item.id); }}
              >
                <span className={`sticker small anim-${item.anim}`}>{item.glyph}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="composer-row">
        <input
          ref={file}
          type="file"
          accept="image/*"
          className="hidden-file"
          onChange={event => { void pickPhoto(event.target.files?.[0]); event.target.value = ''; }}
        />
        <button type="button" className="quiet" onClick={() => setTray(value => value === 'sticker' ? 'none' : 'sticker')} aria-label="Sticker pack" aria-pressed={tray === 'sticker'}><Sparkles aria-hidden="true" /></button>
        <button type="button" className="quiet" onClick={() => setTray(value => value === 'emoji' ? 'none' : 'emoji')} aria-label="Emoji" aria-pressed={tray === 'emoji'}><Smile aria-hidden="true" /></button>
        <button type="button" className="quiet" onClick={() => file.current?.click()} aria-label="Send a photo"><ImageIcon aria-hidden="true" /></button>
        <textarea
          ref={area}
          className="composer-input"
          rows={1}
          value={text}
          placeholder="Message"
          maxLength={2000}
          aria-label="Message"
          onChange={event => {
            setText(event.target.value);
            runtime.noteTyping();
            grow(event.target);
          }}
          onKeyDown={event => {
            if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void send(); }
          }}
        />
        {text.trim()
          ? <button type="button" className="round send" onClick={() => void send()} disabled={sending} aria-label="Send message"><Send aria-hidden="true" /></button>
          : <button type="button" className="round mic" onPointerDown={event => { event.preventDefault(); void beginRecording(); }} aria-label="Record a voice note"><Mic aria-hidden="true" /></button>}
      </div>
    </div>
  );
}
