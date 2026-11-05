// Local fixtures only. This directory stays outside both upload roots.
// It replaces the database and Storage dependencies with in-memory adapters so the
// real application routes can run in Node. It proves application behaviour, not
// provider connectivity or access-policy enforcement.
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';

export class LocalError extends Error {
  constructor(code, status) { super(code); this.code = code; this.status = status; }
}

const TABLES = ['cine_rooms', 'cine_peers', 'cine_messages', 'cine_player', 'cine_signals', 'cine_media'];
// Each table's real primary key, so a fixture clash means what a database clash means.
const PRIMARY = {
  cine_rooms: row => row.code,
  cine_peers: row => `${row.room}|${row.peer}`,
  cine_player: row => row.room,
  cine_messages: row => row.id,
  cine_signals: row => row.id,
  cine_media: row => row.id,
};

export function createMemoryRuntime() {
  const tables = Object.fromEntries(TABLES.map(name => [name, []]));
  const objects = new Map();
  const signatures = new Map();
  const state = { failSend: false, loseSend: false, empty: false };

  function reset(empty = false) {
    for (const name of TABLES) tables[name].length = 0;
    objects.clear(); signatures.clear();
    Object.assign(state, { failSend: false, loseSend: false, empty });
  }
  reset();

  const columns = (row, selection) => (typeof selection === 'string'
    ? Object.fromEntries(selection.split(',').map(key => [key.trim(), row[key]]))
    : { ...row });

  const db = {
    from(table) {
      if (!(table in tables)) throw new LocalError('invalid_table', 400);
      const filters = [];
      const order = [];
      let mode = 'read';
      let values;
      let conflict;
      let selection;
      let limit = 1000;
      const query = {
        select(value) { selection = value; return query; },
        eq(key, value) { filters.push([key, v => v === value]); return query; },
        neq(key, value) { filters.push([key, v => v !== value]); return query; },
        gte(key, value) { filters.push([key, v => v >= value]); return query; },
        gt(key, value) { filters.push([key, v => v > value]); return query; },
        lt(key, value) { filters.push([key, v => v < value]); return query; },
        lte(key, value) { filters.push([key, v => v <= value]); return query; },
        in(key, list) { filters.push([key, v => list.includes(v)]); return query; },
        order(key, options = {}) { order.push([key, options.ascending !== false]); return query; },
        limit(value) { limit = value; return query; },
        maybeSingle() { limit = 1; return query; },
        single() { limit = 1; return query; },
        insert(value) { mode = 'insert'; values = value; return query; },
        insertIfAbsent(value, options) { mode = 'insert'; values = value; conflict = options.onConflict.split(',').map(part => part.trim()); return query; },
        upsert(value) { mode = 'upsert'; values = value; return query; },
        update(value) { mode = 'update'; values = value; return query; },
        delete() { mode = 'delete'; return query; },
        then(fulfilled, rejected) {
          return Promise.resolve().then(() => {
            const matches = row => filters.every(([key, test]) => test(row[key]));
            if (mode === 'insert' || mode === 'upsert') {
              const row = { ...values };
              if (conflict && tables[table].some(existing => conflict.every(key => existing[key] === row[key]))) return { data: [], error: null };
              const primary = PRIMARY[table];
              const clash = tables[table].find(existing => primary(existing) === primary(row));
              if (clash) {
                if (mode === 'upsert') { Object.assign(clash, row); return { data: [columns(clash, selection)], error: null }; }
                return { data: null, error: { code: '23505', message: 'duplicate key' } };
              }
              if (row.created_at === undefined) row.created_at = new Date().toISOString();
              tables[table].push(row);
              return { data: [columns(row, selection)], error: null };
            }
            let result = tables[table].filter(matches);
            if (mode === 'update') result.forEach(row => Object.assign(row, values));
            if (mode === 'delete') {
              const doomed = new Set(result);
              tables[table] = tables[table].filter(row => !doomed.has(row));
              result = [];
              return { data: [], error: null };
            }
            for (const [key, ascending] of [...order].reverse()) {
              result = [...result].sort((a, b) => (a[key] < b[key] ? -1 : a[key] > b[key] ? 1 : 0) * (ascending ? 1 : -1));
            }
            return { data: result.slice(0, limit).map(row => columns(row, selection)), error: null };
          }).then(fulfilled, rejected);
        },
      };
      return query;
    },
  };

  function sign(path, operation) {
    const token = randomUUID();
    signatures.set(token, { path, operation, expires: Date.now() + 120_000 });
    return { signedUrl: `/storage/v1/object/${operation === 'upload' ? 'upload/sign' : 'sign'}/${path}?token=${token}` };
  }

  const storage = {
    async createSignedUploadUrl(path) { return sign(path, 'upload'); },
    async createSignedUrl(path) { return sign(path, 'download'); },
    async download(path) {
      const object = objects.get(path);
      if (!object) throw new LocalError('storage_object_not_found', 404);
      return new Response(object.bytes, { headers: { 'content-type': object.type, 'content-length': String(object.bytes.length) } });
    },
    async remove(paths) { for (const path of paths) objects.delete(path); return { ok: true }; },
  };

  return {
    db, storage, state, tables, objects, reset, BackendError: LocalError,
    async transfer(request) {
      const url = new URL(request.url);
      const signed = signatures.get(url.searchParams.get('token'));
      if (!signed || signed.expires < Date.now()) throw new LocalError('signature_expired', 403);
      const path = signed.path;
      if (signed.operation === 'download' && request.method === 'GET') return storage.download(path);
      if (signed.operation !== 'upload' || request.method !== 'PUT') throw new LocalError('method_not_allowed', 405);
      if (objects.has(path)) throw new LocalError('object_exists', 409);
      const bytes = new Uint8Array(await request.arrayBuffer());
      if (bytes.length > 12 * 1024 * 1024) throw new LocalError('payload_too_large', 413);
      objects.set(path, { bytes, type: request.headers.get('content-type')?.split(';')[0].trim() ?? 'application/octet-stream' });
      return Response.json({ ok: true });
    },
  };
}

const controls = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Local test console</title><style>body{font:15px/1.7 system-ui;max-width:680px;margin:44px auto;padding:20px;color:#2a2033;background:#fff7f4}button{font:inherit;padding:9px 14px;margin:5px;border:1px solid #f3c6d2;background:#ffeef3;border-radius:999px;cursor:pointer}p{color:#6b5b6e}a{color:#e5566f}</style><h1>Local test console</h1><p>Memory data only. Nothing here reaches a real service. Faults apply to the next matching request.</p><p><a href="/">← back to the cinema</a></p><div id="controls"></div><p id="status" role="status"></p><script>const actions={'fail-send':'next message send fails','lose-send':'next send commits but the response is lost','empty':'clear all messages','reset':'reset fixture data'};for(const[action,label]of Object.entries(actions)){const b=document.createElement('button');b.textContent=label;b.onclick=async()=>{const r=await fetch('/__local/control',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action})});document.querySelector('#status').textContent=r.ok?'set: '+label:'failed'}};document.querySelector('#controls').append(b)}</script></html>`;

export async function startLocalBackend(application, { port = 0 } = {}) {
  const runtime = createMemoryRuntime();
  const handle = application(runtime);
  const server = createServer(async (incoming, outgoing) => {
    try {
      const url = new URL(incoming.url, `http://${incoming.headers.host}`);
      if (!['127.0.0.1', 'localhost'].includes(url.hostname)) throw new LocalError('invalid_host', 403);
      if (incoming.method !== 'GET' && incoming.method !== 'HEAD' && incoming.headers.origin && incoming.headers.origin !== url.origin) throw new LocalError('invalid_origin', 403);
      const chunks = [];
      let size = 0;
      if (incoming.method !== 'GET' && incoming.method !== 'HEAD') {
        for await (const chunk of incoming) { size += chunk.length; if (size > 12 * 1024 * 1024) throw new LocalError('payload_too_large', 413); chunks.push(chunk); }
      }
      const request = new Request(url, {
        method: incoming.method,
        headers: incoming.headers,
        ...(incoming.method === 'GET' || incoming.method === 'HEAD' ? {} : { body: Buffer.concat(chunks) }),
      });
      let response;
      if (url.pathname === '/__local/' && incoming.method === 'GET') response = new Response(controls, { headers: { 'content-type': 'text/html; charset=utf-8' } });
      else if (url.pathname === '/__local/control' && incoming.method === 'POST') {
        const { action } = await request.json();
        if (action === 'reset') runtime.reset(false);
        else if (action === 'empty') runtime.reset(true);
        else if (action === 'fail-send' || action === 'lose-send') runtime.state[action === 'fail-send' ? 'failSend' : 'loseSend'] = true;
        else throw new LocalError('invalid_control', 400);
        response = Response.json({ ok: true });
      } else if (url.pathname.startsWith('/storage/v1/')) response = await runtime.transfer(request);
      else {
        response = await handle({ request });
        // Simulate a committed write whose response never reached the browser.
        if (url.pathname.endsWith('/api/send') && incoming.method === 'POST') {
          if (runtime.state.failSend) { runtime.state.failSend = false; response = Response.json({ error: 'database_unavailable' }, { status: 503 }); }
          else if (runtime.state.loseSend) { runtime.state.loseSend = false; response = Response.json({ error: 'response_lost' }, { status: 503 }); }
        }
      }
      outgoing.writeHead(response.status, { ...Object.fromEntries(response.headers), 'cache-control': 'no-store' });
      outgoing.end(Buffer.from(await response.arrayBuffer()));
    } catch (error) {
      outgoing.writeHead(error instanceof LocalError ? error.status : 500, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      outgoing.end(JSON.stringify({ error: error instanceof LocalError ? error.code : 'local_failure' }));
    }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  return { runtime, server, origin: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((resolve, reject) => server.close(error => (error ? reject(error) : resolve()))) };
}
