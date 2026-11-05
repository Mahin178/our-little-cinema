// Our Little Cinema — application routes.
// Dependency injection is only for local tests; index.ts retains Deno.serve.
// This module never accepts object paths, DB tokens or platform credentials from clients.
// Identity is application-owned: an unguessable server-generated room code plus a
// member token derived by HMAC from the room secret, which only the Function can read.

const CODE = /^[a-z0-9]{8,12}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// The Gateway preserves the suffix but replaces the logical `app` segment with the
// physical Function name, so the route must not assume either spelling. On a host that mounts
// the function by path prefix and hands the isolate only `/api/...`, the prefix is simply absent.
const ROUTE = /^\/(?:(?:functions\/v1\/)?(?:app|app-d[0-9a-f]{32}))?(\/.*)?$/;
const VIDEO_ID = /^[0-9A-Za-z_-]{11}$/;
const HEX_COLOR = /^#[0-9a-f]{6}$/;
// A reaction is one emoji: base glyph plus an optional variation selector, skin tone,
// or a short zero-width-joiner sequence (👨‍👩‍👧), and nothing else.
const EMOJI = /^\p{Extended_Pictographic}[\uFE0F\u{1F3FB}-\u{1F3FF}]?(\u200D\p{Extended_Pictographic}[\uFE0F\u{1F3FB}-\u{1F3FF}]?){0,3}$/u;

const MESSAGE_KINDS = ['text', 'image', 'voice', 'sticker', 'system'];
const SIGNAL_KINDS = ['call-offer', 'call-answer', 'call-offer-negotiate', 'call-answer-negotiate', 'ice', 'call-hangup', 'call-reject'];
const CALL_STATES = ['idle', 'ringing', 'live'];
const IMAGE_TYPES = { 'image/jpeg': 1, 'image/png': 1, 'image/webp': 1, 'image/gif': 1 };
const VOICE_TYPES = ['audio/webm', 'audio/ogg', 'audio/mp4', 'audio/mpeg'];
const MAX_NAME = 24;
const MAX_TEXT = 2000;
const MAX_BODY = 4000;
const MAX_QUEUE = 40;
const IMAGE_BYTES = 12 * 1024 * 1024;
const VOICE_BYTES = 8 * 1024 * 1024;
const ONLINE_MS = 14_000;
const HOLD_MS = 9_000;
const SIGNAL_TTL_MS = 15 * 60_000;
const MAX_MS = 41024454496000;

const base64url = bytes => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export function application({ db, storage, BackendError, publicBase = null }) {
  const fail = (code, status) => { throw new BackendError(code, status); };
  const rows = result => {
    if (result?.error) fail(result.error.code ?? 'database_error', 503);
    return result?.data ?? null;
  };
  const json = (value, status = 200) => Response.json(value, { status, headers: { 'cache-control': 'no-store' } });
  const text = (value, max) => (typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null);
  const int = (value, min, max) => (Number.isFinite(value) && Math.trunc(value) === value && value >= min && value <= max ? value : null);
  const peerId = value => (typeof value === 'string' && UUID.test(value) ? value : null);

  // Bounded stream reader. Content-Length is optional and can be wrong, so the bytes
  // actually read decide whether a body is acceptable — for JSON and for upload bytes.
  async function readBytes(request, maxBytes, failure = 'invalid_input', failureStatus = 400) {
    const reader = request.body?.getReader();
    if (!reader) fail(failure, failureStatus);
    let size = 0;
    const chunks = [];
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value?.byteLength ?? 0;
        if (size > maxBytes) { await reader.cancel().catch(() => {}); fail('payload_too_large', 413); }
        chunks.push(value);
      }
    } catch (error) {
      if (error instanceof BackendError) throw error;
      fail(failure, failureStatus);
    } finally {
      reader.releaseLock();
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return bytes;
  }

  async function body(request, maxBytes) {
    if (!request.headers.get('content-type')?.startsWith('application/json')) fail('invalid_input', 400);
    const declared = Number(request.headers.get('content-length') ?? 0);
    if (declared > maxBytes) fail('payload_too_large', 413);
    const bytes = await readBytes(request, maxBytes);
    let parsed;
    try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
    catch { fail('invalid_input', 400); }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) fail('invalid_input', 400);
    return parsed;
  }

  const query = url => ({
    code: url.searchParams.get('code') ?? '',
    peer: url.searchParams.get('peer') ?? '',
    token: url.searchParams.get('token') ?? '',
  });

  // ---------- member token ----------
  async function sign(secret, peer) {
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    return base64url(new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(peer)))).slice(0, 32);
  }
  function equal(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return diff === 0;
  }
  // Every route except /api/enter proves membership before touching data.
  async function member({ code, peer, token }) {
    if (!CODE.test(code) || !UUID.test(peer) || typeof token !== 'string' || !token) fail('not_a_member', 403);
    const found = rows(await db.from('cine_rooms').select('code,secret').eq('code', code).limit(1));
    if (!found?.length) fail('room_not_found', 404);
    if (!equal(await sign(found[0].secret, peer), token)) fail('not_a_member', 403);
    return { code, peer };
  }
  const credentials = payload => ({ code: String(payload.code ?? ''), peer: String(payload.peer ?? ''), token: String(payload.token ?? '') });

  // ---------- room entry: creates the room on first use ----------
  async function enter(payload) {
    const name = text(payload.name, MAX_NAME) ?? 'friend';
    const color = HEX_COLOR.test(payload.color) ? payload.color : '#e5566f';
    const peer = peerId(payload.peer) ?? crypto.randomUUID();
    let code = typeof payload.code === 'string' ? payload.code.trim().toLowerCase() : '';
    let secret;
    if (code) {
      if (!CODE.test(code)) fail('invalid_code', 400);
      const found = rows(await db.from('cine_rooms').select('code,secret').eq('code', code).limit(1));
      if (!found?.length) fail('room_not_found', 404);
      secret = found[0].secret;
    } else {
      // Server-generated address, so a guessed code cannot reach another room.
      const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
      for (let attempt = 0; attempt < 5 && !code; attempt += 1) {
        const random = new Uint8Array(10);
        crypto.getRandomValues(random);
        const candidate = Array.from(random, value => alphabet[value % alphabet.length]).join('');
        const clash = rows(await db.from('cine_rooms').select('code').eq('code', candidate).limit(1));
        if (!clash?.length) code = candidate;
      }
      if (!code) fail('room_busy', 409);
      secret = base64url(crypto.getRandomValues(new Uint8Array(32)));
      rows(await db.from('cine_rooms').insert({ code, secret, host_peer: peer, created_at: new Date().toISOString() }));
      rows(await db.from('cine_player').insert({ room: code, video: '', title: '', position: 0, playing: 0, rate: 1000, queue: [], updated_by: '', updated: Date.now() }));
    }
    const record = { room: code, peer, name, color, last_seen: new Date().toISOString(), typing: 0, last_read: Date.now(), call_state: 'idle' };
    const existing = rows(await db.from('cine_peers').select('peer').eq('room', code).eq('peer', peer).limit(1));
    if (existing?.length) rows(await db.from('cine_peers').update({ name, color, last_seen: record.last_seen, call_state: 'idle' }).eq('room', code).eq('peer', peer));
    else rows(await db.from('cine_peers').insert(record));
    // Nobody is holding a phone across a reload, so drop stale call signalling.
    rows(await db.from('cine_signals').delete().eq('room', code).lt('created', Date.now() - SIGNAL_TTL_MS));
    return json({ code, peer, token: await sign(secret, peer), now: Date.now() });
  }

  // ---------- one realtime read: everything that can change ----------
  async function pull(url) {
    const scope = await member(query(url));
    const since = Number(url.searchParams.get('messages') ?? 0) || 0;
    const sinceSignal = Number(url.searchParams.get('signals') ?? 0) || 0;
    const read = async () => {
      // Overlap the cursor by 800 ms and let the client de-duplicate by id, so rows
      // committed in the same millisecond as the cursor are never skipped.
      const [messages, signals, player, peers] = await Promise.all([
        rows(await db.from('cine_messages').select('id,peer,name,color,kind,body,media,reactions,reply_to,created').eq('room', scope.code).gte('created', Math.max(0, since - 800)).order('created', { ascending: true }).limit(200)),
        rows(await db.from('cine_signals').select('id,from_peer,to_peer,kind,payload,created').eq('room', scope.code).gte('created', Math.max(0, sinceSignal - 800)).limit(200)),
        rows(await db.from('cine_player').select('video,title,position,playing,rate,queue,updated_by,updated').eq('room', scope.code).limit(1)),
        rows(await db.from('cine_peers').select('peer,name,color,last_seen,typing,last_read,call_state').eq('room', scope.code).limit(20)),
      ]);
      const now = Date.now();
      const all = (messages ?? []).filter(row => row.created > since);
      const mine = (signals ?? []).filter(row => row.created > sinceSignal && (row.to_peer === scope.peer || row.to_peer === '*'));
      return {
        messages: messages ?? [],
        signals: (signals ?? []).filter(row => row.to_peer === scope.peer || row.to_peer === '*'),
        player: player?.[0] ?? { video: '', title: '', position: 0, playing: 0, rate: 1000, queue: [], updated_by: '', updated: 0 },
        peers: (peers ?? []).map(row => ({ ...row, online: now - new Date(row.last_seen).getTime() < ONLINE_MS })),
        fresh: all.length + mine.length,
        now,
      };
    };
    const deadline = Date.now() + HOLD_MS;
    let snapshot = await read();
    // Hold the connection until something arrives: the browser then keeps exactly one
    // request in flight instead of polling the Function on a timer.
    while (snapshot.fresh === 0 && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 500));
      snapshot = await read();
    }
    delete snapshot.fresh;
    return json(snapshot);
  }

  // ---------- older history for scroll-back ----------
  async function history(url) {
    const scope = await member(query(url));
    const before = Number(url.searchParams.get('before') ?? 0) || Date.now();
    const found = rows(await db.from('cine_messages').select('id,peer,name,color,kind,body,media,reactions,reply_to,created').eq('room', scope.code).lt('created', before).order('created', { ascending: false }).limit(80));
    return json({ messages: (found ?? []).reverse(), oldest: found?.length ? found[found.length - 1].created : before });
  }

  // ---------- presence heartbeat ----------
  async function ping(request) {
    const payload = await body(request, 4_000);
    const scope = await member(credentials(payload));
    const name = text(payload.name, MAX_NAME) ?? 'friend';
    const color = HEX_COLOR.test(payload.color) ? payload.color : '#e5566f';
    const typing = int(payload.typing, 0, MAX_MS) ?? 0;
    const lastRead = int(payload.lastRead, 0, MAX_MS) ?? 0;
    const callState = CALL_STATES.includes(payload.callState) ? payload.callState : 'idle';
    const stamp = new Date().toISOString();
    const updated = rows(await db.from('cine_peers').update({ name, color, last_seen: stamp, typing, last_read: lastRead, call_state: callState }).eq('room', scope.code).eq('peer', scope.peer).select('peer'));
    if (!updated?.length) rows(await db.from('cine_peers').insert({ room: scope.code, peer: scope.peer, name, color, last_seen: stamp, typing, last_read: lastRead, call_state: callState }));
    return json({ ok: true, now: Date.now() });
  }

  // ---------- chat message; the client-generated id makes a retry idempotent ----------
  async function send(request) {
    const payload = await body(request, 12_000);
    const scope = await member(credentials(payload));
    const id = peerId(payload.id) ?? fail('invalid_input', 400);
    const kind = MESSAGE_KINDS.includes(payload.kind) ? payload.kind : fail('invalid_input', 400);
    const message = typeof payload.body === 'string' ? payload.body : '';
    if (message.length > MAX_BODY) fail('payload_too_large', 413);
    if (kind === 'text' && (!message.trim() || message.length > MAX_TEXT)) fail('invalid_input', 400);
    if (kind === 'sticker' && !/^[a-z0-9_-]{1,40}$/.test(message)) fail('invalid_input', 400);
    if (kind === 'system' && !message) fail('invalid_input', 400);
    if ((kind === 'image' || kind === 'voice') && !peerId(payload.media)) fail('invalid_input', 400);
    const media = peerId(payload.media);
    if (media) {
      const file = rows(await db.from('cine_media').select('id,status').eq('id', media).eq('room', scope.code).limit(1));
      if (!file?.length) fail('not_found', 404);
      if (file[0].status !== 'ready') fail('upload_pending', 409);
    }
    const replyTo = peerId(payload.replyTo);
    const self = rows(await db.from('cine_peers').select('name,color').eq('room', scope.code).eq('peer', scope.peer).limit(1));
    const created = Date.now();
    const row = { id, room: scope.code, peer: scope.peer, name: self?.[0]?.name ?? 'friend', color: self?.[0]?.color ?? '#e5566f', kind, body: message, media, reactions: {}, reply_to: replyTo, created };
    const inserted = rows(await db.from('cine_messages').insertIfAbsent(row, { onConflict: 'id' }).select('id,peer,name,color,kind,body,media,reactions,reply_to,created'));
    if (inserted?.length) return json(inserted[0], 201);
    // Same key with a lost response: recover the committed row instead of posting twice.
    const existing = rows(await db.from('cine_messages').select('id,peer,name,color,kind,body,media,reactions,reply_to,created').eq('room', scope.code).eq('id', id).limit(1));
    if (!existing?.length) fail('write_conflict', 409);
    return json(existing[0]);
  }

  // ---------- reactions: only the author may recall, anyone may react ----------
  async function react(request) {
    const payload = await body(request, 4_000);
    const scope = await member(credentials(payload));
    const target = peerId(payload.id) ?? fail('invalid_input', 400);
    const emoji = typeof payload.emoji === 'string' && EMOJI.test(payload.emoji) ? payload.emoji : fail('invalid_input', 400);
    const found = rows(await db.from('cine_messages').select('id,reactions').eq('room', scope.code).eq('id', target).limit(1));
    if (!found?.length) fail('not_found', 404);
    const reactions = found[0].reactions && typeof found[0].reactions === 'object' ? found[0].reactions : {};
    const liked = Array.isArray(reactions[emoji]) ? reactions[emoji].filter(value => typeof value === 'string') : [];
    const next = liked.includes(scope.peer) ? liked.filter(value => value !== scope.peer) : [...liked, scope.peer];
    if (next.length) reactions[emoji] = next; else delete reactions[emoji];
    if (Object.keys(reactions).length > 8) fail('invalid_input', 400);
    const written = rows(await db.from('cine_messages').update({ reactions }).eq('room', scope.code).eq('id', target).select('id,reactions'));
    if (!written?.length) fail('write_conflict', 409);
    return json({ id: target, reactions });
  }

  async function recall(request) {
    const payload = await body(request, 4_000);
    const scope = await member(credentials(payload));
    const target = peerId(payload.id) ?? fail('invalid_input', 400);
    // Ownership and target are predicates of the write itself.
    const written = rows(await db.from('cine_messages').update({ kind: 'recalled', body: '', media: null, reactions: {} }).eq('room', scope.code).eq('id', target).eq('peer', scope.peer).select('id,kind'));
    if (!written?.length) fail('not_found', 404);
    return json({ id: target, kind: 'recalled' });
  }

  // ---------- shared player state ----------
  async function player(request) {
    const payload = await body(request, 24_000);
    const scope = await member(credentials(payload));
    const video = typeof payload.video === 'string' && VIDEO_ID.test(payload.video) ? payload.video : fail('invalid_input', 400);
    const title = text(payload.title, 160) ?? '';
    const position = int(payload.position, 0, 1_000_000_000) ?? fail('invalid_input', 400);
    const playing = payload.playing ? 1 : 0;
    const rate = int(payload.rate, 250, 2000) ?? 1000;
    const patch = { video, title, position, playing, rate, updated_by: scope.peer, updated: Date.now() };
    if (Array.isArray(payload.queue)) {
      patch.queue = payload.queue.slice(0, MAX_QUEUE)
        .map(item => (item && typeof item === 'object' && VIDEO_ID.test(String(item.video ?? '')) ? { video: String(item.video), title: text(item.title, 160) ?? '' } : null))
        .filter(Boolean);
    }
    const written = rows(await db.from('cine_player').update(patch).eq('room', scope.code).select('room'));
    if (!written?.length) rows(await db.from('cine_player').insert({ room: scope.code, queue: [], ...patch }));
    return json({ ok: true, updated: patch.updated });
  }

  // ---------- call signalling ----------
  async function signal(request) {
    const payload = await body(request, 32_000);
    const scope = await member(credentials(payload));
    const kind = SIGNAL_KINDS.includes(payload.kind) ? payload.kind : fail('invalid_input', 400);
    const data = typeof payload.payload === 'string' && payload.payload.length <= 24_000 ? payload.payload : fail('invalid_input', 400);
    const to = payload.to === '*' ? '*' : (peerId(payload.to) ?? fail('invalid_input', 400));
    const created = Date.now();
    const inserted = rows(await db.from('cine_signals').insert({ id: crypto.randomUUID(), room: scope.code, from_peer: scope.peer, to_peer: to, kind, payload: data, created }).select('id,from_peer,to_peer,kind,payload,created'));
    if (!inserted?.length) fail('write_conflict', 409);
    return json(inserted[0], 201);
  }

  // ---------- uploads: sign, then verify the stored bytes before marking ready ----------
  // The Function's own address, so a relayed upload points back at this same deployment.
  // A host that hands the isolate an internal URL (a loopback origin inside the container)
  // has to supply the public one; otherwise the request it is answering says it best.
  function appBase(request, route) {
    if (publicBase) return String(publicBase).replace(/\/+$/, '');
    const url = new URL(request.url);
    return url.pathname.endsWith(route) ? `${url.origin}${url.pathname.slice(0, -route.length)}` : url.origin;
  }

  async function uploadBegin(request) {
    const payload = await body(request, 4_000);
    const scope = await member(credentials(payload));
    const kind = payload.kind === 'image' || payload.kind === 'voice' ? payload.kind : fail('invalid_input', 400);
    const mime = typeof payload.mime === 'string' ? payload.mime.toLowerCase().split(';')[0].trim() : '';
    const allowed = kind === 'image' ? IMAGE_TYPES[mime] : VOICE_TYPES.some(value => mime.startsWith(value));
    if (!allowed) fail('unsupported_file', 415);
    // An object store that cannot hand out browser URLs without a key of its own sets a
    // ceiling here; nothing bigger than that ever leaves the phone.
    const ceiling = Math.min(kind === 'image' ? IMAGE_BYTES : VOICE_BYTES, storage.maxUploadBytes ?? Infinity);
    const size = int(payload.bytes, 1, ceiling);
    if (!size) fail('file_too_large', 413);
    const id = crypto.randomUUID();
    // The client cannot choose a path, so it can never overwrite another member's file.
    const objectPath = `cinema/${scope.code}/${id}`;
    rows(await db.from('cine_media').insert({ id, room: scope.code, peer: scope.peer, object_path: objectPath, mime, bytes: size, kind, status: 'pending', created_at: new Date().toISOString() }));
    if (storage.relayUploads) {
      const back = new URLSearchParams({ id, ...credentials(payload) });
      return json({ id, signedUrl: `${appBase(request, '/api/upload/begin')}/api/upload/put?${back}` }, 201);
    }
    const signed = await storage.createSignedUploadUrl(objectPath, { upsert: false });
    return json({ id, ...signed }, 201);
  }

  // Relayed upload: the browser PUTs the bytes to this Function, which writes them with its
  // own server-side credential. Used when object storage would otherwise need a key in the
  // page — the client still never holds one, and it still cannot name the object path.
  async function uploadPut(url, request) {
    const scope = await member(query(url));
    const id = url.searchParams.get('id') ?? '';
    if (!UUID.test(id)) fail('invalid_input', 400);
    const found = rows(await db.from('cine_media').select('id,object_path,status,mime,bytes,kind').eq('id', id).eq('room', scope.code).limit(1));
    if (!found?.length) fail('not_found', 404);
    const file = found[0];
    // One object, one attempt: a finished upload is never silently overwritten.
    if (file.status !== 'pending') fail('write_conflict', 409);
    const declared = request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() ?? '';
    const allowed = file.kind === 'image' ? IMAGE_TYPES[declared] : VOICE_TYPES.some(value => declared.startsWith(value));
    if (!allowed) fail('unsupported_file', 415);
    const ceiling = Math.min(file.kind === 'image' ? IMAGE_BYTES : VOICE_BYTES, storage.maxUploadBytes ?? Infinity);
    const bytes = await readBytes(request, ceiling, 'invalid_upload', 422);
    if (!bytes.byteLength || bytes.byteLength > ceiling) fail('invalid_upload', 422);
    try {
      await storage.upload(file.object_path, bytes, { contentType: declared });
    } catch (error) {
      if (error instanceof BackendError) throw error;
      fail('storage_unavailable', 503);
    }
    // These bytes were read and written here, so they need no second download to trust;
    // /api/media's `complete` short-circuits on the ready row the client already knows about.
    rows(await db.from('cine_media').update({ status: 'ready', mime: declared, bytes: bytes.byteLength }).eq('id', file.id).eq('room', scope.code).eq('status', 'pending'));
    return json({ id: file.id, status: 'ready', mime: declared, bytes: bytes.byteLength }, 201);
  }

  async function uploadFinish(url, request) {
    const scope = await member(query(url));
    const id = url.searchParams.get('id') ?? '';
    const action = url.searchParams.get('op') ?? 'complete';
    if (!UUID.test(id)) fail('invalid_input', 400);
    const found = rows(await db.from('cine_media').select('id,object_path,status,mime,bytes,kind').eq('id', id).eq('room', scope.code).limit(1));
    if (!found?.length) fail('not_found', 404);
    const file = found[0];
    if (action === 'download') {
      if (file.status !== 'ready') fail('upload_pending', 409);
      return json(await storage.createSignedUrl(file.object_path, 900));
    }
    if (file.status === 'ready') return json({ id: file.id, status: 'ready', mime: file.mime, bytes: file.bytes });
    // Do not trust the browser's completion claim; read the actual stored object.
    let stored;
    try { stored = await storage.download(file.object_path); }
    catch (error) { if (error?.code === 'storage_object_not_found') fail('upload_pending', 409); throw error; }
    const actual = await verify(stored, file.kind === 'image' ? IMAGE_BYTES : VOICE_BYTES);
    const family = file.kind === 'image' ? 'image/' : 'audio/';
    if (!actual.type.startsWith(family)) fail('invalid_upload', 422);
    if (actual.bytes !== file.bytes) fail('invalid_upload', 422);
    rows(await db.from('cine_media').update({ status: 'ready', mime: actual.type, bytes: actual.bytes }).eq('id', file.id).eq('room', scope.code).eq('status', 'pending'));
    return json({ id: file.id, status: 'ready', mime: actual.type, bytes: actual.bytes });
  }

  async function verify(response, maxBytes) {
    const type = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() ?? '';
    if (!response.ok || !response.body) fail('storage_unavailable', 503);
    const reader = response.body.getReader();
    let bytes = 0;
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; void reader.cancel().catch(() => {}); }, 15_000);
    try {
      while (true) {
        if (timedOut) fail('storage_unavailable', 503);
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value?.byteLength ?? 0;
        if (bytes > maxBytes) fail('invalid_upload', 422);
      }
      if (bytes === 0) fail('invalid_upload', 422);
    } catch (error) {
      if (error instanceof BackendError) throw error;
      fail('storage_unavailable', 503);
    } finally {
      clearTimeout(timer);
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    return { bytes, type: type || 'application/octet-stream' };
  }

  return async ctx => {
    const request = ctx.request;
    const match = new URL(request.url).pathname.match(ROUTE);
    if (!match) fail('not_found', 404);
    const path = match[1] || '/';
    const url = new URL(request.url);
    if (path === '/api/health' && request.method === 'GET') {
      // A free hosting plan sleeps a database nobody visited this week, so the health probe
      // also touches one table. It still answers when the read fails: the page only needs to
      // know whether a service is listening, and a scheduled ping keeps Postgres warm either way.
      try { rows(await db.from('cine_rooms').select('code').limit(1)); } catch { /* still reporting */ }
      return json({ ok: true, now: Date.now() });
    }
    if (path === '/api/upload/put' && request.method === 'PUT') return uploadPut(url, request);
    if (path === '/api/enter' && request.method === 'POST') return enter(await body(request, 4_000));
    if (request.method !== 'GET' && request.method !== 'POST') fail('method_not_allowed', 405);
    if (path === '/api/pull' && request.method === 'GET') return pull(url);
    if (path === '/api/history' && request.method === 'GET') return history(url);
    if (path === '/api/ping' && request.method === 'POST') return ping(request);
    if (path === '/api/send' && request.method === 'POST') return send(request);
    if (path === '/api/react' && request.method === 'POST') return react(request);
    if (path === '/api/recall' && request.method === 'POST') return recall(request);
    if (path === '/api/player' && request.method === 'POST') return player(request);
    if (path === '/api/signal' && request.method === 'POST') return signal(request);
    if (path === '/api/upload/begin' && request.method === 'POST') return uploadBegin(request);
    if (path === '/api/media' && request.method === 'POST') return uploadFinish(url, request);
    fail('not_found', 404);
  };
}
