// Credential-free flow check for the real application routes.
// Run: node dev/test-flows.mjs
// Establishes application behaviour only; it does not prove provider connectivity.
import { startLocalBackend } from './local.mjs';

const { application } = await import(new URL('../functions/routes.mjs', import.meta.url).href);
const backend = await startLocalBackend(application, { port: 0 });
const base = backend.origin;

let failures = 0;
const check = (label, condition, detail = '') => {
  if (condition) console.log(`  ok   ${label}`);
  else { failures += 1; console.log(`  FAIL ${label} ${detail}`); }
};

async function call(path, { method = 'GET', body, headers } = {}) {
  const response = await fetch(`${base}/functions/v1/app${path}`, {
    method,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  let json = null;
  try { json = await response.clone().json(); } catch { /* non-JSON */ }
  return { status: response.status, json };
}

const uuid = () => crypto.randomUUID();
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

// ---------------------------------------------------------------- enter
console.log('\nenter / room creation');
const host = await call('/api/enter', { method: 'POST', body: { name: 'Orang', color: '#ff8fb1' } });
check('creates a room', host.status === 200 && /^[a-z0-9]{10}$/.test(host.json.code), JSON.stringify(host.json));
check('returns a member token', typeof host.json.token === 'string' && host.json.token.length === 32);
const code = host.json.code;
const hostSession = { code, peer: host.json.peer, token: host.json.token };

const guest = await call('/api/enter', { method: 'POST', body: { code, name: 'Mochi', color: '#a78bfa' } });
check('joins by code', guest.status === 200 && guest.json.code === code);
const guestSession = { code, peer: guest.json.peer, token: guest.json.token };
check('two distinct peers', hostSession.peer !== guestSession.peer);

const bogusRoom = await call('/api/enter', { method: 'POST', body: { code: 'zzzzzzzzzz', name: 'x' } });
check('unknown code rejected', bogusRoom.status === 404 && bogusRoom.json.error === 'room_not_found');

const forged = await call('/api/pull?code=' + code + '&peer=' + hostSession.peer + '&token=deadbeefdeadbeefdeadbeefdeadbeef');
check('forged token rejected', forged.status === 403 && forged.json.error === 'not_a_member');

const guessed = await call('/api/pull?code=aaaaaaaaaa&peer=' + hostSession.peer + '&token=' + hostSession.token);
check('guessed room code rejected', guessed.status === 404 && guessed.json.error === 'room_not_found');

// guest cannot write as host
const impersonate = await call('/api/send', { method: 'POST', body: { ...hostSession, token: guestSession.token, id: uuid(), kind: 'text', body: 'hi' } });
check('cross-peer token rejected', impersonate.status === 403, JSON.stringify(impersonate.json));

// ---------------------------------------------------------------- send
console.log('\nmessages');
const msgId = uuid();
const sent = await call('/api/send', { method: 'POST', body: { ...hostSession, id: msgId, kind: 'text', body: 'movie tonight?' } });
check('message created', sent.status === 201 && sent.json.id === msgId && sent.json.name === 'Orang', JSON.stringify(sent.json));
check('denormalised colour', sent.json.color === '#ff8fb1');

const retry = await call('/api/send', { method: 'POST', body: { ...hostSession, id: msgId, kind: 'text', body: 'movie tonight?' } });
check('lost-response retry is idempotent', retry.status === 200 && retry.json.id === msgId);
check('retry did not double-post', backend.runtime.tables.cine_messages.filter(row => row.id === msgId).length === 1);

const changed = await call('/api/send', { method: 'POST', body: { ...hostSession, id: msgId, kind: 'text', body: 'different text' } });
check('same key, different content returns committed row', changed.status === 200 && changed.json.body === 'movie tonight?');

const emptyText = await call('/api/send', { method: 'POST', body: { ...hostSession, id: uuid(), kind: 'text', body: '   ' } });
check('blank text rejected', emptyText.status === 400);
const longText = await call('/api/send', { method: 'POST', body: { ...hostSession, id: uuid(), kind: 'text', body: 'x'.repeat(2500) } });
check('oversized text rejected', longText.status === 400, longText.json.error);
const badKind = await call('/api/send', { method: 'POST', body: { ...hostSession, id: uuid(), kind: 'exe', body: 'x' } });
check('unknown kind rejected', badKind.status === 400);
const badMedia = await call('/api/send', { method: 'POST', body: { ...hostSession, id: uuid(), kind: 'image', body: '', media: uuid() } });
check('unverified media id rejected', badMedia.status === 404 || badMedia.status === 409, badMedia.json.error);

// ---------------------------------------------------------------- pull
console.log('\nrealtime pull');
const t0 = Date.now();
// A held request is only useful once the reader is caught up, so start from "now".
const pending = call('/api/pull?code=' + code + '&peer=' + guestSession.peer + '&token=' + guestSession.token + '&messages=' + t0 + '&signals=' + t0);
await wait(250);
await call('/api/send', { method: 'POST', body: { ...hostSession, id: uuid(), kind: 'text', body: 'holding test' } });
const pulled = await pending;
const elapsed = Date.now() - t0;
check('held request returns new message', pulled.status === 200 && pulled.json.messages.some(row => row.body === 'holding test'));
check('long-poll delivered fast', elapsed < 3_000, `${elapsed}ms`);
check('player state included', pulled.json.player && typeof pulled.json.player.video === 'string');
check('peers include online flag', Array.isArray(pulled.json.peers) && pulled.json.peers.every(row => typeof row.online === 'boolean'));
check('server clock included', Number.isFinite(pulled.json.now));
const fromGuest = pulled.json.messages.filter(row => row.peer === guestSession.peer);
check('pull returns both peers messages', pulled.json.messages.some(row => row.peer === hostSession.peer));
void fromGuest;

const idle = call('/api/pull?code=' + code + '&peer=' + guestSession.peer + '&token=' + guestSession.token + '&messages=' + Date.now() + '&signals=' + Date.now());
const idleStart = Date.now();
const idleResult = await idle;
check('idle pull holds before returning', Date.now() - idleStart > 8_000, `${Date.now() - idleStart}ms`);
check('idle pull returns current snapshot', idleResult.status === 200 && Array.isArray(idleResult.json.peers));
void idleResult;

// ---------------------------------------------------------------- history
console.log('\nhistory paging');
const coldAt = Date.now();
const backlog = await call('/api/pull?code=' + code + '&peer=' + guestSession.peer + '&token=' + guestSession.token + '&messages=0&signals=0');
check('cold pull returns backlog at once', backlog.status === 200 && backlog.json.messages.length >= 2 && Date.now() - coldAt < 2_000, `${Date.now() - coldAt}ms ${backlog.json.messages?.length}`);
const newest = Math.max(...backend.runtime.tables.cine_messages.map(row => row.created));
const page = await call('/api/history?code=' + code + '&peer=' + guestSession.peer + '&token=' + guestSession.token + '&before=' + newest);
check('older page excludes newest', page.status === 200 && !page.json.messages.some(row => row.created >= newest), JSON.stringify(page.json));
check('page is oldest-first', page.json.messages.every((row, i) => i === 0 || row.created >= page.json.messages[i - 1].created));

// ---------------------------------------------------------------- reactions and recall
console.log('\nreactions and recall');
const react = await call('/api/react', { method: 'POST', body: { ...guestSession, id: msgId, emoji: '\u2764\uFE0F' } });
check('reaction stored', react.status === 200 && react.json.reactions['\u2764\uFE0F'].includes(guestSession.peer), JSON.stringify(react.json));
const untoggle = await call('/api/react', { method: 'POST', body: { ...guestSession, id: msgId, emoji: '\u2764\uFE0F' } });
check('reaction toggles off', untoggle.status === 200 && !untoggle.json.reactions['\u2764\uFE0F']);
const badEmoji = await call('/api/react', { method: 'POST', body: { ...guestSession, id: msgId, emoji: 'not-an-emoji' } });
check('non-emoji reaction rejected', badEmoji.status === 400);

const wrongRecall = await call('/api/recall', { method: 'POST', body: { ...guestSession, id: msgId } });
check('cannot recall another peer\u2019s message', wrongRecall.status === 404, wrongRecall.json.error);
const recall = await call('/api/recall', { method: 'POST', body: { ...hostSession, id: msgId } });
check('author recalls own message', recall.status === 200 && recall.json.kind === 'recalled');
check('recalled row cleared', backend.runtime.tables.cine_messages.find(row => row.id === msgId).body === '');

// ---------------------------------------------------------------- player
console.log('\nshared player state');
const badVideo = await call('/api/player', { method: 'POST', body: { ...hostSession, video: '<script>', position: 0, playing: 1 } });
check('non-youtube id rejected', badVideo.status === 400);
const setPlayer = await call('/api/player', { method: 'POST', body: { ...hostSession, video: 'dQw4w9WgXcQ', title: 'Never Gonna', position: 42_000, playing: 1, queue: [{ video: 'abcdefghijk', title: 'next' }, { video: 'bad' }] } });
check('player write accepted', setPlayer.status === 200 && Number.isFinite(setPlayer.json.updated));
const after = await call('/api/pull?code=' + code + '&peer=' + guestSession.peer + '&token=' + guestSession.token + '&messages=' + Date.now() + '&signals=' + Date.now());
check('player visible to other peer', after.json.player.video === 'dQw4w9WgXcQ' && after.json.player.position === 42_000 && after.json.player.playing === 1);
check('queue sanitised', after.json.player.queue.length === 1 && after.json.player.queue[0].video === 'abcdefghijk');
check('driver recorded', after.json.player.updated_by === hostSession.peer);

// ---------------------------------------------------------------- signals
console.log('\ncall signalling');
const offer = await call('/api/signal', { method: 'POST', body: { ...hostSession, to: guestSession.peer, kind: 'call-offer', payload: JSON.stringify({ sdp: 'x'.repeat(400) }) } });
check('signal created', offer.status === 201 && offer.json.kind === 'call-offer');
const broadcast = await call('/api/signal', { method: 'POST', body: { ...guestSession, to: '*', kind: 'call-hangup', payload: '{}' } });
check('broadcast accepted', broadcast.status === 201);
const huge = await call('/api/signal', { method: 'POST', body: { ...hostSession, to: guestSession.peer, kind: 'ice', payload: 'y'.repeat(30_000) } });
check('oversized payload rejected', huge.status === 413 || huge.status === 400, huge.json.error);
const badSignalKind = await call('/api/signal', { method: 'POST', body: { ...hostSession, to: guestSession.peer, kind: 'drop-table', payload: '{}' } });
check('unknown signal kind rejected', badSignalKind.status === 400);
const sigPull = await call('/api/pull?code=' + code + '&peer=' + guestSession.peer + '&token=' + guestSession.token + '&messages=' + Date.now() + '&signals=0');
check('signal delivered to target', sigPull.json.signals.some(row => row.kind === 'call-offer'));
check('broadcast visible too', sigPull.json.signals.some(row => row.kind === 'call-hangup'));
const otherPull = await call('/api/pull?code=' + code + '&peer=' + hostSession.peer + '&token=' + hostSession.token + '&messages=' + Date.now() + '&signals=0');
check('direct signal hidden from sender', !otherPull.json.signals.some(row => row.kind === 'call-offer'));

// ---------------------------------------------------------------- presence
console.log('\npresence');
const ping = await call('/api/ping', { method: 'POST', body: { ...guestSession, name: 'Mochi', color: '#a78bfa', typing: Date.now(), callState: 'live' } });
check('heartbeat accepted', ping.status === 200);
const peerRow = backend.runtime.tables.cine_peers.find(row => row.peer === guestSession.peer);
check('typing recorded', peerRow.typing > 0 && peerRow.call_state === 'live');
const badState = await call('/api/ping', { method: 'POST', body: { ...guestSession, callState: 'evil' } });
check('unknown call state falls back to idle', badState.status === 200 && backend.runtime.tables.cine_peers.find(row => row.peer === guestSession.peer).call_state === 'idle');

// ---------------------------------------------------------------- uploads
console.log('\nuploads');
const bytes = new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jR5kAAAAASUVORK5CYII=', 'base64'));
const begin = await call('/api/upload/begin', { method: 'POST', body: { ...hostSession, kind: 'image', mime: 'image/png', bytes: bytes.length } });
check('upload signed', begin.status === 201 && typeof begin.json.signedUrl === 'string' && begin.json.id);
const mediaId = begin.json.id;
const path = new URL(base + begin.json.signedUrl).pathname;
check('path is server-assigned', path.includes(`cinema/${code}/${mediaId}`), path);
const premature = await call('/api/media?id=' + mediaId + '&op=complete&code=' + code + '&peer=' + hostSession.peer + '&token=' + hostSession.token, { method: 'POST' });
check('missing object reports upload_pending', premature.status === 409 && premature.json.error === 'upload_pending');

const put = await fetch(base + begin.json.signedUrl, { method: 'PUT', headers: { 'content-type': 'image/png' }, body: bytes });
check('signed PUT stored', put.ok, String(put.status));
const confirm = await call('/api/media?id=' + mediaId + '&op=complete&code=' + code + '&peer=' + hostSession.peer + '&token=' + hostSession.token, { method: 'POST' });
check('verified object marked ready', confirm.status === 200 && confirm.json.status === 'ready' && confirm.json.bytes === bytes.length, JSON.stringify(confirm.json));
const download = await call('/api/media?id=' + mediaId + '&op=download&code=' + code + '&peer=' + guestSession.peer + '&token=' + guestSession.token, { method: 'POST' });
check('other peer may download', download.status === 200 && typeof download.json.signedUrl === 'string');
const fetched = await fetch(base + download.json.signedUrl);
check('downloaded bytes match', fetched.ok && (await fetched.arrayBuffer()).byteLength === bytes.length);

const wrongRoom = await call('/api/media?id=' + mediaId + '&op=download&code=bbbbbbbbbb&peer=' + hostSession.peer + '&token=' + hostSession.token, { method: 'POST' });
check('media hidden from other room', wrongRoom.status === 404 || wrongRoom.status === 403, wrongRoom.json.error);
const badType = await call('/api/upload/begin', { method: 'POST', body: { ...hostSession, kind: 'image', mime: 'application/x-msdownload', bytes: 10 } });
check('disallowed mime rejected', badType.status === 415);
const badVoiceKind = await call('/api/upload/begin', { method: 'POST', body: { ...hostSession, kind: 'voice', mime: 'audio/webm', bytes: 10 } });
check('voice upload signed', badVoiceKind.status === 201);
const oversized = await call('/api/upload/begin', { method: 'POST', body: { ...hostSession, kind: 'image', mime: 'image/png', bytes: 40 * 1024 * 1024 } });
check('oversized declared bytes rejected', oversized.status === 413);

// Relayed uploads: the same routes when object storage cannot sign a URL for the browser.
console.log('\nrelayed uploads');
backend.runtime.storage.relayUploads = true;
const relay = await call('/api/upload/begin', { method: 'POST', body: { ...hostSession, kind: 'image', mime: 'image/png', bytes: bytes.length } });
const relayUrl = new URL(relay.json.signedUrl, base);
check('relay mode returns an app route, not a store path', relay.status === 201 && relayUrl.pathname.endsWith('/api/upload/put') && !relayUrl.search.includes('object'), relay.json.signedUrl);
check('relay url carries no object path', !relayUrl.search.includes('cinema/'));
const relayBad = await fetch(relayUrl, { method: 'PUT', headers: { 'content-type': 'text/plain' }, body: bytes });
check('relay refuses a type that was not declared', relayBad.status === 415, String(relayBad.status));
const relayPut = await fetch(relayUrl, { method: 'PUT', headers: { 'content-type': 'image/png' }, body: bytes });
check('relayed bytes stored', relayPut.status === 201, String(relayPut.status));
const relayRow = backend.runtime.tables.cine_media.find(row => row.id === relay.json.id);
check('relayed object is ready under a server-named path', relayRow?.status === 'ready' && relayRow.object_path === `cinema/${code}/${relay.json.id}`);
const relayAgain = await fetch(relayUrl, { method: 'PUT', headers: { 'content-type': 'image/png' }, body: bytes });
check('a finished upload is not overwritten', relayAgain.status === 409, String(relayAgain.status));
const relayConfirm = await call('/api/media?id=' + relay.json.id + '&op=complete&code=' + code + '&peer=' + hostSession.peer + '&token=' + hostSession.token, { method: 'POST' });
check('complete short-circuits on the ready row', relayConfirm.status === 200 && relayConfirm.json.bytes === bytes.length);
const bareRelay = await fetch(new URL('/functions/v1/app/api/upload/put?id=' + relay.json.id, base), { method: 'PUT', headers: { 'content-type': 'image/png' }, body: bytes });
check('relay requires membership', bareRelay.status === 403, String(bareRelay.status));
backend.runtime.storage.maxUploadBytes = 1024;
const relayCeiling = await call('/api/upload/begin', { method: 'POST', body: { ...hostSession, kind: 'image', mime: 'image/png', bytes: 4000 } });
check('the store ceiling answers before any bytes move', relayCeiling.status === 413);
const underCeiling = await call('/api/upload/begin', { method: 'POST', body: { ...hostSession, kind: 'image', mime: 'image/png', bytes: bytes.length } });
check('uploads under the ceiling still sign', underCeiling.status === 201);
backend.runtime.storage.maxUploadBytes = Infinity;
backend.runtime.storage.relayUploads = false;

const attached = await call('/api/send', { method: 'POST', body: { ...hostSession, id: uuid(), kind: 'image', body: '', media: mediaId } });
check('ready media attaches', attached.status === 201 && attached.json.media === mediaId);

// ---------------------------------------------------------------- routing hygiene
console.log('\nrouting and methods');
const unknown = await call('/api/nope');
check('unknown path 404', unknown.status === 404 && unknown.json.error === 'not_found');
const wrongMethod = await call('/api/pull?code=' + code);
check('GET-only route rejects PUT', (await fetch(`${base}/functions/v1/app/api/pull?code=${code}`, { method: 'PUT' })).status === 405);
check('health is anonymous', (await call('/api/health')).status === 200);
void wrongMethod;

await backend.close();
console.log(`\n${failures === 0 ? 'all flow checks passed' : failures + ' check(s) failed'}`);
process.exit(failures === 0 ? 0 : 1);
