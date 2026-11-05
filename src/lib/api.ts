// Same-origin Function client. Every call is a business route owned by the Function;
// the browser never sees a database endpoint or a credential.
const BASE = '/functions/v1/app';

export class BackendError extends Error {
  constructor(public code: string, public status = 0, public uncertain = false) {
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
  catch { throw new BackendError('invalid_response', response.status, response.ok); }
  const record = (body ?? {}) as Record<string, unknown>;
  if (!response.ok) {
    const code = typeof record.error === 'string' ? record.error : 'request_failed';
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
  const code = error instanceof BackendError ? error.code : '';
  return COPY[code] ?? 'Something went wrong. Give it another try.';
}

export function isLocalPreview() {
  if (typeof window === 'undefined') return false;
  return ['127.0.0.1', 'localhost'].includes(window.location.hostname);
}
