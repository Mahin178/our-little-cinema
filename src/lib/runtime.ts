// One runtime per browser tab, deliberately outside React so a StrictMode remount or a
// re-render can never start a second long-poll loop.
import { api, BackendError, explain } from './api';
import { EMPTY_PLAYER, type Message, type Peer, type PlayerState, type Session, type Signal } from './types';

export type Pending = { pending?: boolean; failed?: boolean; uploading?: string };
export type ChatMessage = Message & Pending;

export type CallSignalHandler = (signals: Signal[]) => void;

type Listener = () => void;

const KEY = 'little-cinema:v1';
const ONLINE_SLACK = 14_000;
const TYPING_WINDOW = 2_600;

export class Runtime {
  session: Session | null = null;
  identity = { name: '', color: '#ff8fb1' };
  messages: ChatMessage[] = [];
  peers: Peer[] = [];
  player: PlayerState = EMPTY_PLAYER;
  offset = 0;
  rtt = 0;
  connected = false;
  connecting = true;
  error = '';
  oldest = 0;
  loadingOlder = false;
  atBottom = true;
  setAtBottom(value: boolean) {
    if (this.atBottom === value) return;
    this.atBottom = value;
    this.emit('state');
  }
  /** Set by the theatre when the driver re-anchors the shared clock. */
  lastHeartbeat = 0;
  mediaUrls = new Map<string, { url: string; at: number }>();
  mediaPending = new Map<string, Promise<string>>();

  private stateListeners = new Set<Listener>();
  private messageListeners = new Set<Listener>();
  private signalListeners = new Set<CallSignalHandler>();
  private pending = new Map<string, ChatMessage>();
  private cursor = { messages: 0, signals: 0 };
  private controller: AbortController | null = null;
  private pingTimer: number | null = null;
  private typingUntil = 0;
  private lastPlayerWrite = 0;
  private lastAction = 0;
  private started = false;
  private generation = 0;
  private version = { state: 0, messages: 0 };
  private snapshotState: object = {};
  private snapshotMessages: ChatMessage[] = [];

  serverNow() { return Date.now() + this.offset; }
  /** Milliseconds since the last control this person touched, for echo suppression. */
  sinceAction() { return Date.now() - this.lastAction; }
  markAction() { this.lastAction = Date.now(); }

  // ---------- persistence ----------
  load(): Session | null {
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) return null;
      const saved = JSON.parse(raw);
      if (saved?.session?.code && typeof saved.session.token === 'string') {
        this.session = saved.session;
        this.identity = { name: saved.identity?.name ?? 'friend', color: saved.identity?.color ?? '#ff8fb1' };
        this.cursor.messages = Number(saved.cursor?.messages) || 0;
        this.cursor.signals = 0;
        return this.session;
      }
    } catch { /* a corrupt entry is just a fresh start */ }
    return null;
  }
  private save() {
    try {
      if (!this.session) return;
      localStorage.setItem(KEY, JSON.stringify({ session: this.session, identity: this.identity, cursor: { messages: this.cursor.messages } }));
    } catch { /* private mode still gets a working session for this tab */ }
  }

  // ---------- store plumbing ----------
  // Bound as fields: React passes these straight to useSyncExternalStore, so they are
  // invoked without a receiver and would lose `this` as prototype methods.
  subscribeState = (listener: Listener) => { this.stateListeners.add(listener); return () => { this.stateListeners.delete(listener); }; };
  subscribeMessages = (listener: Listener) => { this.messageListeners.add(listener); return () => { this.messageListeners.delete(listener); }; };
  onSignals = (listener: CallSignalHandler) => { this.signalListeners.add(listener); return () => { this.signalListeners.delete(listener); }; };
  getState = () => this.snapshotState;
  getMessages = () => this.snapshotMessages;
  private emit(kind: 'state' | 'messages' | 'both') {
    this.version.state += 1;
    this.snapshotState = {
      session: this.session, identity: this.identity, peers: this.peers, player: this.player,
      connected: this.connected, connecting: this.connecting, error: this.error, offset: this.offset,
      oldest: this.oldest, loadingOlder: this.loadingOlder, atBottom: this.atBottom, mediaVersion: this.mediaUrls.size,
    };
    if (kind === 'messages' || kind === 'both') {
      this.version.messages += 1;
      this.snapshotMessages = [...this.messages];
    }
    if (kind !== 'messages') this.stateListeners.forEach(listener => listener());
    if (kind !== 'state') this.messageListeners.forEach(listener => listener());
  }

  // ---------- sign in ----------
  async enter(input: { code?: string; name: string; color: string; known?: Session }) {
    this.identity = { name: input.name.trim().slice(0, 24) || 'friend', color: /^#[0-9a-f]{6}$/.test(input.color) ? input.color : '#ff8fb1' };
    const known = input.known;
    const sameRoom = Boolean(known && known.code === (input.code || known.code));
    const peer = sameRoom && known ? known.peer : crypto.randomUUID();
    const result = await api.enter({ code: input.code || undefined, name: this.identity.name, color: this.identity.color, peer });
    this.session = { code: result.code, peer: result.peer, token: result.token };
    this.offset = result.now - Date.now();
    this.messages = [];
    this.pending.clear();
    this.cursor = { messages: 0, signals: 0 };
    this.save();
    this.emit('both');
    await this.bootstrap();
    this.start();
    return this.session;
  }
  /** Opens on the newest page, then lets the live cursor continue forward. */
  private async bootstrap() {
    try {
      const data = await api.history(this.query(`&before=${this.serverNow() + 1}`));
      const rows: Message[] = data.messages ?? [];
      if (rows.length) {
        this.merge(rows);
        this.cursor.messages = Math.max(this.cursor.messages, ...rows.map(row => row.created));
      }
      this.oldest = this.messages.length ? this.messages[0].created : 0;
      this.save();
      this.emit('both');
    } catch { /* the live loop still connects; history can be re-read on scroll */ }
  }
  private scope() {
    if (!this.session) throw new BackendError('not_a_member', 403);
    return this.session;
  }
  private query(extra = '') {
    const { code, peer, token } = this.scope();
    return `code=${code}&peer=${peer}&token=${token}${extra}`;
  }

  // ---------- realtime loop ----------
  start() {
    if (this.started || !this.session) return;
    this.started = true;
    this.connecting = true;
    const generation = ++this.generation;
    this.controller = new AbortController();
    void this.loop(generation, this.controller.signal);
    const beat = async () => {
      if (!this.started || !this.session) return;
      try {
        const result = await api.ping({
          ...this.scope(),
          name: this.identity.name,
          color: this.identity.color,
          typing: this.typingUntil > Date.now() ? this.typingUntil : 0,
          lastRead: this.cursor.messages,
          callState: this.callState,
        });
        this.offset = result.now - Date.now() + Math.round(this.rtt / 2);
        if (!this.connected) { this.connected = true; this.connecting = false; this.error = ''; this.emit('state'); }
      } catch { /* the pull loop reports connectivity */ }
      this.pingTimer = window.setTimeout(beat, this.connected ? 4_000 : 2_000);
    };
    this.pingTimer = window.setTimeout(beat, 200);
    this.emit('state');
  }

  callState: 'idle' | 'ringing' | 'live' = 'idle';
  setCallState(state: 'idle' | 'ringing' | 'live') {
    if (this.callState === state) return;
    this.callState = state;
    this.emit('state');
  }

  stop() {
    this.started = false;
    this.controller?.abort();
    this.controller = null;
    if (this.pingTimer) window.clearTimeout(this.pingTimer);
    this.pingTimer = null;
    this.connected = false;
    this.connecting = false;
    this.emit('state');
  }

  /** Forget this room on this device: the next visit starts from the front door. */
  forget() {
    this.stop();
    this.session = null;
    this.messages = [];
    this.peers = [];
    this.pending.clear();
    this.cursor = { messages: 0, signals: 0 };
    this.mediaUrls.clear();
    try { localStorage.removeItem(KEY); } catch { /* nothing saved anyway */ }
    this.emit('both');
  }

  private async loop(generation: number, signal: AbortSignal) {
    let backoff = 500;
    while (this.started && generation === this.generation && !signal.aborted) {
      try {
        const query = this.query(`&messages=${this.cursor.messages}&signals=${this.cursor.signals}`);
        const t0 = Date.now();
        const data = await api.pull(query, signal);
        if (generation !== this.generation) return;
        const t1 = Date.now();
        this.rtt = Math.min(this.rtt ? Math.round(this.rtt * 0.6 + (t1 - t0) * 0.4) : t1 - t0, 8_000);
        // One-way estimate: the server stamped `now` roughly half a round trip ago.
        this.offset = data.now + Math.round(this.rtt / 2) - t1;
        if (!this.connected) { this.connected = true; this.error = ''; }
        this.connecting = false;
        backoff = 500;
        this.apply(data);
      } catch (error) {
        if (signal.aborted || generation !== this.generation) return;
        this.connected = false;
        this.error = error instanceof BackendError ? error.code : 'network_error';
        this.emit('both');
        await new Promise(resolve => window.setTimeout(resolve, backoff));
        backoff = Math.min(Math.round(backoff * 1.8), 8_000);
      }
    }
  }

  private apply(data: any) {
    const newSignals: Signal[] = [];
    for (const row of data.signals ?? []) {
      // The read window deliberately overlaps; only rows past the cursor are new.
      if (row.created > this.cursor.signals) {
        newSignals.push(row);
        this.cursor.signals = row.created;
      }
    }
    const arrived = (data.messages ?? []).filter((row: Message) => row.created > this.cursor.messages || this.pending.has(row.id));
    if (data.messages?.length) this.cursor.messages = Math.max(this.cursor.messages, ...data.messages.map((row: Message) => row.created));
    if (arrived.length) this.merge(arrived);
    this.peers = (data.peers ?? []).map((row: any) => ({ ...row }));
    this.player = data.player ?? EMPTY_PLAYER;
    this.oldest = this.messages.length ? this.messages[0].created : 0;
    this.save();
    this.emit('both');
    if (newSignals.length) this.signalListeners.forEach(listener => listener(newSignals));
  }

  private merge(rows: Message[]) {
    const byId = new Map(this.messages.map(row => [row.id, row]));
    for (const row of rows) {
      const local = byId.get(row.id);
      byId.set(row.id, local ? { ...row, pending: false, failed: false } : { ...row });
      if (this.pending.has(row.id)) this.pending.delete(row.id);
    }
    this.messages = [...byId.values()].sort((a, b) => a.created - b.created).slice(-600);
  }

  // ---------- typing and read state ----------
  noteTyping() {
    this.typingUntil = Date.now() + 1_800;
  }
  /** The other person is typing when their heartbeat landed inside a short window. */
  typingPeer(): Peer | null {
    const now = this.serverNow();
    return this.peers.find(peer => peer.peer !== this.session?.peer && peer.online && now - peer.typing < TYPING_WINDOW) ?? null;
  }
  otherPeer(): Peer | null {
    return this.peers.find(peer => peer.peer !== this.session?.peer) ?? null;
  }
  seenThrough() { return this.otherPeer()?.last_read ?? 0; }

  // ---------- history ----------
  async loadOlder() {
    if (this.loadingOlder || !this.messages.length) return;
    this.loadingOlder = true;
    this.emit('state');
    try {
      const data = await api.history(this.query(`&before=${this.messages[0].created}`));
      const byId = new Map(this.messages.map(row => [row.id, row]));
      for (const row of data.messages ?? []) if (!this.pending.has(row.id)) byId.set(row.id, { ...row });
      this.messages = [...byId.values()].sort((a, b) => a.created - b.created);
      this.oldest = this.messages.length ? this.messages[0].created : 0;
    } catch (error) {
      this.error = error instanceof BackendError ? error.code : 'network_error';
    } finally {
      this.loadingOlder = false;
      this.emit('both');
    }
  }

  // ---------- sending ----------
  private localMessage(kind: Message['kind'], body: string, extra: Partial<ChatMessage> = {}): ChatMessage {
    const message: ChatMessage = {
      id: crypto.randomUUID(),
      peer: this.scope().peer,
      name: this.identity.name,
      color: this.identity.color,
      kind,
      body,
      media: null,
      reactions: {},
      reply_to: null,
      created: this.serverNow(),
      pending: true,
      ...extra,
    };
    this.messages = [...this.messages, message].sort((a, b) => a.created - b.created);
    this.pending.set(message.id, message);
    this.emit('messages');
    return message;
  }

  /** Wire-only extras: the server reads `replyTo`, the local row keeps `reply_to`. */
  private async post(message: ChatMessage, kind: Message['kind'], body: string, extra: { media?: string | null; replyTo?: string } = {}) {
    try {
      const row = await api.send({ ...this.scope(), id: message.id, kind, body, ...extra });
      this.merge([row]);
      this.cursor.messages = Math.max(this.cursor.messages, row.created);
      this.save();
      return row as Message;
    } catch (error) {
      // An unknown outcome stays visibly uncertain rather than being resent blindly.
      const uncertain = error instanceof BackendError && error.uncertain;
      const index = this.messages.findIndex(row => row.id === message.id);
      if (index >= 0) {
        const updated = { ...this.messages[index], pending: false, failed: !uncertain };
        this.messages = this.messages.map((row, at) => (at === index ? updated : row));
        if (!uncertain) this.pending.delete(message.id);
      }
      this.error = error instanceof BackendError ? error.code : 'network_error';
      this.emit('both');
      return null;
    }
  }

  async sendText(text: string) {
    const value = text.trim().slice(0, 2000);
    if (!value) return null;
    this.markAction();
    return this.post(this.localMessage('text', value), 'text', value);
  }

  async sendSticker(id: string) {
    this.markAction();
    return this.post(this.localMessage('sticker', id), 'sticker', id);
  }

  /** Photo: shrink in the browser first, then sign, PUT and verify before posting. */
  async sendImage(file: File) {
    this.markAction();
    const blob = await shrinkImage(file);
    return this.deliver('image', blob, '', this.localMessage('image', ''));
  }

  async sendVoice(blob: Blob, secs: number, peaks: number[]) {
    this.markAction();
    const body = JSON.stringify({ secs, peaks });
    return this.deliver('voice', blob, body, this.localMessage('voice', body));
  }

  private retryable = new Map<string, { kind: 'image' | 'voice'; blob: Blob; body: string }>();

  private async deliver(kind: 'image' | 'voice', blob: Blob, body: string, message: ChatMessage) {
    this.retryable.set(message.id, { kind, blob, body });
    this.patch(message.id, { pending: true, failed: false, uploading: 'Getting it ready…' });
    try {
      const media = await this.upload(kind, blob);
      const row = await this.post(message, kind, body, { media });
      if (row) this.retryable.delete(message.id);
      return row;
    } catch (error) {
      this.fail(message.id, error);
      return null;
    }
  }

  private patch(id: string, changes: Partial<ChatMessage>) {
    const index = this.messages.findIndex(row => row.id === id);
    if (index < 0) return;
    this.messages = this.messages.map((row, at) => (at === index ? { ...row, ...changes } : row));
    this.emit('messages');
  }

  /** Tap a failed bubble to repeat the identical send; its id keeps that idempotent. */
  async retry(id: string) {
    const message = this.messages.find(row => row.id === id);
    if (!message || message.kind === 'recalled' || message.pending) return null;
    this.markAction();
    const held = this.retryable.get(id);
    if (held) return this.deliver(held.kind, held.blob, held.body, message);
    if ((message.kind === 'image' || message.kind === 'voice') && !message.media) return null;
    this.patch(id, { pending: true, failed: false, uploading: undefined });
    return this.post(message, message.kind, message.body, {
      ...(message.media ? { media: message.media } : {}),
      ...(message.reply_to ? { replyTo: message.reply_to } : {}),
    });
  }

  private fail(id: string, error: unknown) {
    this.patch(id, { pending: false, failed: true, uploading: undefined });
    this.error = error instanceof BackendError ? error.code : 'network_error';
    this.emit('state');
  }

  private async upload(kind: 'image' | 'voice', blob: Blob): Promise<string> {
    const mime = blob.type || (kind === 'image' ? 'image/jpeg' : 'audio/webm');
    const begun = await api.beginUpload({ ...this.scope(), kind, mime, bytes: blob.size });
    await putUploadSafe(begun.signedUrl, blob);
    const done = await api.finishUpload(this.query(), begun.id, 'complete');
    if (done.status !== 'ready') throw new BackendError('upload_pending', 409);
    return begun.id;
  }

  async react(id: string, emoji: string) {
    try {
      const result = await api.react({ ...this.scope(), id, emoji });
      const index = this.messages.findIndex(row => row.id === id);
      if (index >= 0) {
        const updated = { ...this.messages[index], reactions: result.reactions ?? {} };
        this.messages = this.messages.map((row, at) => (at === index ? updated : row));
        this.emit('messages');
      }
    } catch (error) {
      this.error = error instanceof BackendError ? error.code : 'network_error';
      this.emit('state');
    }
  }

  async recall(id: string) {
    try {
      await api.recall({ ...this.scope(), id });
      const index = this.messages.findIndex(row => row.id === id);
      if (index >= 0) {
        const updated = { ...this.messages[index], kind: 'recalled' as const, body: '', media: null, reactions: {} };
        this.messages = this.messages.map((row, at) => (at === index ? updated : row));
        this.emit('messages');
      }
    } catch (error) {
      this.error = error instanceof BackendError ? error.code : 'network_error';
      this.emit('state');
    }
  }

  // ---------- signed media, refreshed before it expires ----------
  mediaUrl(id: string): string | null {
    const cached = this.mediaUrls.get(id);
    // Re-sign ahead of the 900 s expiry so an open chat never shows a broken image.
    if (cached && Date.now() - cached.at < 7 * 60_000) return cached.url;
    if (!this.mediaPending.has(id)) {
      const work = api.finishUpload(this.query(), id, 'download')
        .then(result => {
          if (typeof result.signedUrl !== 'string') throw new BackendError('invalid_response', 0);
          this.mediaUrls.set(id, { url: result.signedUrl, at: Date.now() });
          this.mediaPending.delete(id);
          this.emit('state');
          return result.signedUrl;
        })
        .catch(error => {
          this.mediaPending.delete(id);
          this.error = error instanceof BackendError ? error.code : 'network_error';
          this.emit('state');
          throw error;
        });
      this.mediaPending.set(id, work);
    }
    return cached?.url ?? null;
  }
  /** Drops a cached signature so the next read re-signs, e.g. after a load error. */
  invalidateMedia(id: string) {
    this.mediaUrls.delete(id);
    this.emit('state');
  }

  // ---------- shared player ----------
  /** Only the person who last touched playback keeps the room timed. */
  isDriver() { return !this.player.updated_by || this.player.updated_by === this.session?.peer; }
  async setPlayer(patch: { video?: string; title?: string; position?: number; playing?: boolean; queue?: { video: string; title: string }[] }, force = false) {
    if (!this.session) return;
    if (!force && Date.now() - this.lastPlayerWrite < 350 && !patch.video) return;
    this.lastPlayerWrite = Date.now();
    this.markAction();
    const body = {
      ...this.scope(),
      video: patch.video ?? this.player.video,
      title: patch.title ?? this.player.title,
      position: Math.round(patch.position ?? this.player.position),
      playing: patch.playing ?? this.player.playing === 1,
      queue: patch.queue,
    };
    try {
      const result = await api.player(body);
      this.player = { ...this.player, ...body, playing: body.playing ? 1 : 0, updated: result.updated, updated_by: this.session.peer } as PlayerState;
      this.emit('state');
    } catch (error) {
      this.error = error instanceof BackendError ? error.code : 'network_error';
      this.emit('state');
    }
  }

  // ---------- call signalling ----------
  async signal(to: string, kind: string, payload: unknown) {
    if (!this.session) return;
    try {
      await api.signal({ ...this.scope(), to, kind, payload: typeof payload === 'string' ? payload : JSON.stringify(payload) });
    } catch (error) {
      this.error = error instanceof BackendError ? error.code : 'network_error';
      this.emit('state');
    }
  }
}

async function putUploadSafe(signedUrl: string, blob: Blob) {
  const response = await fetch(signedUrl, {
    method: 'PUT',
    credentials: 'same-origin',
    headers: { 'content-type': blob.type || 'application/octet-stream' },
    body: blob,
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) throw new BackendError('upload_failed', response.status, true);
}

/** Keeps rooms light: photos arrive as JPEG under ~1.6k on the long edge. */
export async function shrinkImage(file: File): Promise<Blob> {
  if (file.type === 'image/gif') return file;
  const maxEdge = 1600;
  const quality = 0.85;
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
    if (scale === 1 && file.size < 400_000) return file;
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) return file;
    context.drawImage(bitmap, 0, 0, width, height);
    bitmap.close?.();
    const result = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/jpeg', quality));
    return result ?? file;
  } catch {
    return file;
  }
}

export const runtime = new Runtime();
export { explain };
