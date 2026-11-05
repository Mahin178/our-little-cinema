// Every call is a business route owned by the Function;
// the browser never sees a database endpoint or a credential.
//
// Same-origin is the default (Qoder Sites serves the Function beside the pages). When the
// site is hosted somewhere static-only, a config.json shipped next to index.html points the
// same build at a Function on another origin — no rebuild, no hard-coded address.
let BASE = '/functions/v1/app';
let configured = false;

export async function loadConfig(): Promise<{ apiBase: string; hasConfig: boolean }> {
  if (configured) return { apiBase: BASE, hasConfig: true };
  configured = true;
  try {
    const response = await fetch('./config.json', { cache: 'no-store' });
    if (!response.ok) return { apiBase: BASE, hasConfig: false };
    const raw = (await response.json()) as Record<string, unknown>;
    const value = typeof raw.apiBase === 'string' ? raw.apiBase.trim().replace(/\/+$/, '') : '';
    // Only an absolute http(s) address, so a stray relative path cannot silently 404 everything.
    if (/^https?:\/\/[^\s]+$/i.test(value)) BASE = value;
    return { apiBase: BASE, hasConfig: true };
  } catch {
    return { apiBase: BASE, hasConfig: false };
  }
}

/** Cheap anonymous probe: tells the front door whether a room service is answering at all. */
export async function serviceReachable(): Promise<boolean> {
  try {
    await request<{ ok: boolean }>('/api/health', { method: 'GET' }, 6_000);
    return true;
  } catch {
    return false;
  }
}

export const apiBase = () => BASE;

/** The absolute address this page is calling its room service at — what a setup fix has to change. */
function serviceAddress(): string {
  if (BASE.startsWith('/')) {
    return typeof window === 'undefined' ? BASE : `${window.location.origin}${BASE}`;
  }
  return BASE;
}

export class BackendError extends Error {
  constructor(public code: string, public status = 0, public uncertain = false, public hint = '') {
    super(code);
  }
}

async function request<T>(path: string, init?: RequestInit, timeoutMs = 20_000): Promise<T> {
  // fetch defaults a string body to text/plain, and the Function only accepts JSON.
  const withType: RequestInit = init?.body
    ? { ...init, headers: { 'content-type': 'application/json', ...(init.headers as Record<string, string> ?? {}) } }
    : init ?? {};
  let response: Response;
  try {
    response = await fetch(`${BASE}${path}`, {
      ...withType,
      credentials: 'same-origin',
      signal: withType.signal ?? AbortSignal.timeout(timeoutMs),
    });
  } catch {
    // A timeout or dropped connection after a write leaves the outcome unknown.
    throw new BackendError('network_error', 0, true);
  }
  let body: unknown;
  try { body = await response.json(); }
  catch {
    // The room service always answers in JSON. A static host's 404 page, a login wall or an
    // empty body means this address is not the service at all — which is a setup problem, not
    // a glitch, and the owner is the only person who can fix it. So name the address.
    if (response.ok) throw new BackendError('invalid_response', response.status, response.ok);
    throw new BackendError('no_service', response.status, false, serviceAddress());
  }
  const record = (body ?? {}) as Record<string, unknown>;
  if (!response.ok) {
    // Supabase's own refusals carry a `message`, not the app's `error` code, and a 401 here can
    // only mean the gateway is demanding a login this page deliberately does not have.
    const code = typeof record.error === 'string' ? record.error
      : response.status === 401 ? 'service_locked'
      : typeof record.message === 'string' ? 'service_answered_otherwise'
      : 'request_failed';
    throw new BackendError(code, response.status, response.status >= 500 || response.status === 408);
  }
  return body as T;
}

export const api = {
  enter: (input: { code?: string; name: string; color: string; peer?: string }) =>
    request<{ code: string; peer: string; token: string; now: number }>('/api/enter', { method: 'POST', body: JSON.stringify(input) }),
  pull: (query: string, signal?: AbortSignal) => request<any>(`/api/pull?${query}`, { method: 'GET', signal }, 22_000),
  history: (query: string) => request<any>(`/api/history?${query}`, { method: 'GET' }),
  ping: (input: object) => request<{ ok: boolean; now: number }>('/api/ping', { method: 'POST', body: JSON.stringify(input) }),
  send: (input: object) => request<any>('/api/send', { method: 'POST', body: JSON.stringify(input) }),
  react: (input: object) => request<any>('/api/react', { method: 'POST', body: JSON.stringify(input) }),
  recall: (input: object) => request<any>('/api/recall', { method: 'POST', body: JSON.stringify(input) }),
  player: (input: object) => request<{ ok: boolean; updated: number }>('/api/player', { method: 'POST', body: JSON.stringify(input) }),
  signal: (input: object) => request<any>('/api/signal', { method: 'POST', body: JSON.stringify(input) }),
  beginUpload: (input: { kind: 'image' | 'voice'; mime: string; bytes: number; code: string; peer: string; token: string }) =>
    request<{ id: string; signedUrl: string }>('/api/upload/begin', { method: 'POST', body: JSON.stringify(input) }),
  finishUpload: (scope: string, id: string, op: 'complete' | 'download') =>
    request<{ id?: string; status?: string; signedUrl?: string }>(`/api/media?id=${id}&op=${op}&${scope}`, { method: 'POST', body: '{}' }),
  health: () => request<{ ok: boolean }>('/api/health', { method: 'GET' }),
};

// Browser PUT through the signed URL the Function issued for this upload.
export async function putUpload(signedUrl: string, blob: Blob) {
  const response = await fetch(signedUrl, {
    method: 'PUT',
    credentials: 'same-origin',
    headers: { 'content-type': blob.type || 'application/octet-stream' },
    body: blob,
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) throw new BackendError('upload_failed', response.status, true);
}

const COPY: Record<string, string> = {
  network_error: 'The connection dropped. Your message may or may not have sent — pull to check before trying again.',
  invalid_response: 'The service replied with something unexpected. Try again in a moment.',
  no_service: 'No room service is answering at {address}. The page is live, but its backend has not been connected yet — see SETUP.md, steps 1 to 3. Until that is done no room can be made or joined.',
  service_locked: 'The room service refused the call for want of a login this page does not carry. In Supabase, open the app function and switch off "Enforce authentication" (SETUP.md, step 2.3).',
  service_answered_otherwise: 'The room service answered with its own message instead of the app\'s, which usually means the address points at Supabase but not at the deployed function (it should end in /functions/v1/app).',
  not_a_member: 'This room link no longer matches. Rejoin with the code your partner has.',
  room_not_found: 'That room code does not exist yet.',
  invalid_code: 'That room code is not quite right.',
  room_busy: 'Could not make a room just then. Try once more.',
  invalid_input: 'That did not look right. Check it and try again.',
  payload_too_large: 'That is too big to send.',
  upload_pending: 'That file has not finished uploading yet.',
  unsupported_file: 'Send photos (JPG, PNG, WEBP, GIF) or voice recordings.',
  file_too_large: 'That file is too large. Try a shorter clip or a smaller photo.',
  invalid_upload: 'The stored file did not match, so it was not posted.',
  storage_unavailable: 'File storage is not available right now.',
  database_not_configured: 'The room database is not switched on yet.',
  database_credential_rejected: 'The room database refused the connection. The site owner may need to restore it.',
  write_conflict: 'That changed while you were sending it.',
  not_found: 'That is no longer here.',
  login_required: 'Please sign in to this site first.',
};

export function explain(error: unknown): string {
  if (!(error instanceof BackendError)) return 'Something went wrong. Give it another try.';
  const copy = COPY[error.code] ?? 'Something went wrong. Give it another try.';
  // A setup failure names the address it tried, because that is the only thing the owner can correct.
  return error.hint ? copy.replace('{address}', error.hint) : copy;
}

export function isLocalPreview() {
  if (typeof window === 'undefined') return false;
  return ['127.0.0.1', 'localhost'].includes(window.location.hostname);
}
