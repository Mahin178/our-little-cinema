// Peer-to-peer calls. Media never touches the server: the Function only relays the
// offer and answer, so signalling travels over the same room bus as chat.
// ICE is non-trickle — candidates are gathered first and carried inside the SDP —
// because a poll-relayed channel cannot deliver them in arrival order.
import { useSyncExternalStore } from 'react';
import { runtime } from './runtime';
import type { Signal } from './types';

export type CallStatus = 'idle' | 'calling' | 'incoming' | 'connecting' | 'live' | 'failed';

export type CallSnapshot = {
  status: CallStatus;
  peerName: string;
  video: boolean;
  micOn: boolean;
  camOn: boolean;
  secs: number;
  note: string;
  remote: MediaStream | null;
  local: MediaStream | null;
};

const DEFAULT_SERVERS: RTCIceServer[] = [
  { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
];
const SETTINGS_KEY = 'little-cinema:turn';
const GATHER_WAIT = 6_000;
const RING_WAIT = 45_000;

export function readTurn(): RTCIceServer[] {
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? 'null');
    if (saved?.urls && saved?.username && saved?.credential) {
      return [{ urls: String(saved.urls), username: String(saved.username), credential: String(saved.credential) }];
    }
  } catch { /* an edited value simply falls back to the defaults */ }
  return [];
}
export function writeTurn(value: { urls: string; username: string; credential: string }) {
  if (!value.urls || !value.username || !value.credential) localStorage.removeItem(SETTINGS_KEY);
  else localStorage.setItem(SETTINGS_KEY, JSON.stringify(value));
}

class Call {
  status: CallStatus = 'idle';
  peerName = '';
  video = true;
  micOn = true;
  camOn = true;
  secs = 0;
  note = '';
  remote: MediaStream | null = null;
  local: MediaStream | null = null;

  private pc: RTCPeerConnection | null = null;
  private peerId = '';
  private timer: number | null = null;
  private ringTimer: number | null = null;
  private stopRing: (() => void) | null = null;
  private listeners = new Set<() => void>();
  private snapshot: CallSnapshot = { status: 'idle', peerName: '', video: true, micOn: true, camOn: true, secs: 0, note: '', remote: null, local: null };
  private startedAt = 0;
  private unsubscribe: (() => void) | null = null;
  private restartTried = false;

  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };

  private emit(patch: Partial<CallSnapshot> = {}) {
    this.status = patch.status ?? this.status;
    this.peerName = patch.peerName ?? this.peerName;
    this.video = patch.video ?? this.video;
    this.micOn = patch.micOn ?? this.micOn;
    this.camOn = patch.camOn ?? this.camOn;
    this.secs = patch.secs ?? this.secs;
    this.note = 'note' in patch ? patch.note ?? '' : this.note;
    this.remote = patch.remote !== undefined ? patch.remote : this.remote;
    this.local = patch.local !== undefined ? patch.local : this.local;
    this.snapshot = {
      status: this.status, peerName: this.peerName, video: this.video, micOn: this.micOn,
      camOn: this.camOn, secs: this.secs, note: this.note, remote: this.remote, local: this.local,
    };
    runtime.setCallState(this.status === 'live' || this.status === 'connecting' ? 'live' : this.status === 'incoming' || this.status === 'calling' ? 'ringing' : 'idle');
    this.listeners.forEach(listener => listener());
  }

  /** Only signals that arrive after the page is ready can ring it. */
  watch() {
    if (this.unsubscribe) return;
    this.startedAt = Date.now();
    this.unsubscribe = runtime.onSignals(incoming => {
      const usable = incoming.filter(row => row.created >= this.startedAt - 3_000);
      if (usable.length) void this.receive(usable);
    });
  }

  private servers(): RTCIceServer[] {
    const turn = readTurn();
    return turn.length ? [...DEFAULT_SERVERS, ...turn] : DEFAULT_SERVERS;
  }

  private async media(wantVideo: boolean) {
    // A missing or blocked camera should not cost them the call.
    try {
      return await navigator.mediaDevices.getUserMedia({ audio: true, video: wantVideo ? { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } } : false });
    } catch {
      if (!wantVideo) throw new Error('microphone');
      return await navigator.mediaDevices.getUserMedia({ audio: true });
    }
  }

  private async gather(timeoutMs = GATHER_WAIT) {
    const pc = this.pc;
    if (!pc) return;
    await new Promise<void>(resolve => {
      let settled = false;
      const finish = () => { if (!settled) { settled = true; resolve(); } };
      const poll = window.setInterval(() => { if (pc.iceGatheringState === 'complete') finish(); }, 150);
      const timer = window.setTimeout(() => { window.clearInterval(poll); finish(); }, timeoutMs);
      pc.addEventListener('icegatheringstatechange', () => {
        if (pc.iceGatheringState === 'complete') { window.clearInterval(poll); window.clearTimeout(timer); finish(); }
      });
    });
  }

  private build(video: boolean) {
    const pc = new RTCPeerConnection({ iceServers: this.servers(), bundlePolicy: 'max-bundle' });
    this.pc = pc;
    this.video = video;
    pc.ontrack = event => { this.remote = event.streams[0] ?? new MediaStream([event.track]); this.emit(); };
    pc.onconnectionstatechange = () => { void this.onConnection(); };
    return pc;
  }

  private async onConnection() {
    const pc = this.pc;
    if (!pc) return;
    if (pc.connectionState === 'connected') {
      if (this.status !== 'live') this.beginTimer();
      this.emit({ status: 'live', note: '' });
    } else if (pc.connectionState === 'failed') {
      if (!this.restartTried) {
        this.restartTried = true;
        try { await pc.restartIce(); } catch { /* fall through to the friendly note */ }
        return;
      }
      const turnless = readTurn().length === 0;
      this.fail(turnless
        ? 'Your networks could not reach each other directly. Adding a relay (TURN) address in settings fixes this.'
        : 'The relay could not connect either. Try again, or keep watching together in chat.');
    }
  }

  private beginTimer() {
    if (this.timer) return;
    const at = Date.now();
    this.timer = window.setInterval(() => this.emit({ secs: Math.floor((Date.now() - at) / 1000) }), 1000);
  }

  /**
   * Say why the call stopped, then hand the phone back. Without the return to idle every
   * later attempt would be refused by the guard in start(), so one blocked microphone would
   * silence calls for the rest of the session.
   */
  private fail(note: string) {
    this.teardown();
    this.emit({ status: 'failed', note });
    window.setTimeout(() => { if (this.status === 'failed') this.end(''); }, 4_000);
  }

  async start(target?: { peer: string; name: string }, wantVideo = true) {
    if (this.status !== 'idle' || !target) return;
    this.watch();
    this.emit({ status: 'calling', peerName: target.name, note: '', secs: 0, video: wantVideo });
    try {
      this.local = await this.media(wantVideo);
      const pc = this.build(wantVideo);
      this.peerId = target.peer;
      for (const track of this.local.getTracks()) pc.addTrack(track, this.local);
      await pc.setLocalDescription(await pc.createOffer());
      await this.gather();
      await runtime.signal(target.peer, 'call-offer', { sdp: pc.localDescription?.sdp ?? '', video: this.video });
      this.ringTimer = window.setTimeout(() => {
        if (this.status === 'calling') this.fail(`${target.name} did not pick up.`);
      }, RING_WAIT);
    } catch {
      this.fail('Allow camera and microphone access to start a call.');
    }
  }

  private async receive(incoming: Signal[]) {
    for (const row of incoming) {
      let data: any = {};
      try { data = JSON.parse(row.payload); } catch { continue; }
      if (row.kind === 'call-offer') {
        if (this.status !== 'idle') { await runtime.signal(row.from_peer, 'call-reject', { reason: 'busy' }); continue; }
        const from = runtime.peers.find(peer => peer.peer === row.from_peer);
        this.peerId = row.from_peer;
        this.emit({ status: 'incoming', peerName: from?.name ?? 'Your partner', video: data.video !== false, note: '' });
        this.pendingOffer = typeof data.sdp === 'string' ? data.sdp : '';
        this.startRingtone();
      } else if (row.kind === 'call-answer' && (this.status === 'calling' || this.status === 'connecting')) {
        this.stopRingtone();
        const pc = this.pc;
        if (!pc || !data.sdp) continue;
        try {
          await pc.setRemoteDescription({ type: 'answer', sdp: String(data.sdp) });
          this.emit({ status: 'connecting' });
        } catch { this.fail('The call could not be connected.'); }
      } else if (row.kind === 'call-reject') {
        this.fail(`${this.peerName || 'They'} declined the call.`);
      } else if (row.kind === 'call-hangup') {
        this.end('');
      }
    }
  }
  private pendingOffer = '';

  async accept() {
    if (this.status !== 'incoming' || !this.pendingOffer) return;
    this.stopRingtone();
    try {
      this.local = await this.media(this.video);
      const pc = this.build(this.video);
      for (const track of this.local.getTracks()) pc.addTrack(track, this.local);
      await pc.setRemoteDescription({ type: 'offer', sdp: this.pendingOffer });
      this.pendingOffer = '';
      await pc.setLocalDescription(await pc.createAnswer());
      await this.gather();
      await runtime.signal(this.peerId, 'call-answer', { sdp: pc.localDescription?.sdp ?? '' });
      this.emit({ status: 'connecting' });
    } catch {
      await runtime.signal(this.peerId, 'call-reject', { reason: 'denied' });
      this.fail('Allow camera and microphone access to take this call.');
    }
  }

  async decline() {
    await runtime.signal(this.peerId, 'call-reject', { reason: 'declined' });
    this.end('');
  }

  async hangup() {
    if (this.peerId) await runtime.signal(this.peerId, 'call-hangup', {});
    this.end('');
  }

  toggleMic() {
    const stream = this.local;
    if (!stream) return;
    const next = !this.micOn;
    stream.getAudioTracks().forEach(track => { track.enabled = next; });
    this.emit({ micOn: next });
  }
  toggleCam() {
    const stream = this.local;
    if (!stream) return;
    const next = !this.camOn;
    stream.getVideoTracks().forEach(track => { track.enabled = next; });
    this.emit({ camOn: next });
  }
  /** Swap the camera without renegotiating: the track keeps its direction. */
  async flipCamera() {
    const stream = this.local;
    const pc = this.pc;
    if (!stream || !pc) return;
    try {
      const next = await navigator.mediaDevices.getUserMedia({ video: { facingMode: stream.getVideoTracks()[0]?.getSettings()?.facingMode === 'user' ? 'environment' : 'user' } });
      const track = next.getVideoTracks()[0];
      const sender = pc.getSenders().find(item => item.track?.kind === 'video');
      if (sender && track) {
        await sender.replaceTrack(track);
        stream.getVideoTracks().forEach(old => { old.stop(); stream.removeTrack(old); });
        stream.addTrack(track);
        this.emit({ local: stream });
      } else {
        track?.stop();
      }
    } catch { /* back-facing cameras are optional */ }
  }

  private startRingtone() {
    try {
      const Context = window.AudioContext ?? (window as any).webkitAudioContext;
      if (!Context) return;
      const ctx = new Context();
      const gain = ctx.createGain();
      gain.gain.value = 0.05;
      gain.connect(ctx.destination);
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.connect(gain);
      const lfo = ctx.createOscillator();
      const depth = ctx.createGain();
      depth.gain.value = 0.05;
      lfo.frequency.value = 1.6;
      lfo.connect(depth);
      depth.connect(gain.gain);
      osc.frequency.value = 660;
      lfo.start();
      osc.start();
      void ctx.resume();
      this.stopRing = () => { try { osc.stop(); lfo.stop(); void ctx.close(); } catch { /* already closed */ } };
    } catch { /* a blocked audio context is not worth failing a call over */ }
  }
  private stopRingtone() {
    this.stopRing?.();
    this.stopRing = null;
  }

  private end(note: string) {
    this.teardown();
    this.emit({ status: 'idle', note, secs: 0, peerName: note ? this.peerName : '' });
  }
  private teardown() {
    if (this.timer) window.clearInterval(this.timer);
    if (this.ringTimer) window.clearTimeout(this.ringTimer);
    this.timer = null;
    this.ringTimer = null;
    this.stopRingtone();
    this.local?.getTracks().forEach(track => track.stop());
    try { this.pc?.close(); } catch { /* already closed */ }
    this.pc = null;
    this.local = null;
    this.remote = null;
    this.peerId = '';
    this.pendingOffer = '';
    this.restartTried = false;
  }
  dispose() {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.teardown();
  }
}

export const call = new Call();

export function useCall() {
  return useSyncExternalStore(call.subscribe, call.getSnapshot, call.getSnapshot);
}
