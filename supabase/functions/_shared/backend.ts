// Supabase adapter for Our Little Cinema — the only place a provider key is ever held.
//
// The page talks to the business routes below /api/*, and to nothing else: no database
// endpoint, no table name, no bucket name and no key ever reach a browser. Everything here
// runs inside the edge function, with the project's service-role key, which Supabase keeps
// server-side and which Row Level Security makes meaningless to a visitor.
//
// deno-lint-ignore-file no-explicit-any

import { createClient } from 'npm:@supabase/supabase-js@2';

export class BackendError extends Error {
  code: string;
  status: number;
  constructor(code: string, status = 500) {
    super(code);
    this.name = 'BackendError';
    this.code = code;
    this.status = status;
  }
}

export interface Service {
  url: string;
  key: string;
  bucket: string;
  /** Public address the browser must use, including the function prefix. */
  publicBase: string;
  /** Largest file the object store will accept through this function. */
  maxUploadBytes: number;
}

const bytes = (value: string | undefined, fallback: number) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
};

/** Reads and checks the deployment configuration. Fails loudly rather than silently half-working. */
export function readService(): Service {
  const url = (Deno.env.get('SUPABASE_URL') ?? '').trim().replace(/\/+$/, '');
  // Supabase issues two spellings of the same server-only key, so accept whichever the
  // project has. Neither one may ever appear in the site's files or in a browser request.
  const key = (Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || Deno.env.get('SUPABASE_SECRET_KEY') || '').trim();
  if (!/^https:\/\/[^\s]+$/.test(url)) throw new BackendError('service_misconfigured', 500);
  if (!key) throw new BackendError('service_misconfigured', 500);
  const slug = (Deno.env.get('FUNCTION_SLUG') ?? '').trim() || 'app';
  return {
    url,
    key,
    bucket: (Deno.env.get('CINE_BUCKET') ?? '').trim() || 'cinema',
    publicBase: (Deno.env.get('APP_PUBLIC_URL') ?? '').trim().replace(/\/+$/, '') || `${url}/functions/v1/${slug}`,
    maxUploadBytes: bytes(Deno.env.get('MAX_UPLOAD_BYTES'), 12 * 1024 * 1024),
  };
}

/**
 * postgrest-js builders are chainable and thenable, which is exactly the shape the
 * application already speaks. Only one verb is spelled differently: the application asks for
 * "insert, and if that id is already there do nothing", and PostgREST calls that an upsert
 * with ignore-duplicates.
 */
const CHAINABLE = new Set([
  'select', 'insert', 'update', 'delete', 'upsert',
  'eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'like', 'ilike', 'is', 'in', 'contains', 'containedBy', 'matches',
  'not', 'or', 'and', 'filter', 'order', 'limit', 'offset', 'range', 'single', 'maybeSingle', 'explain', 'rollback',
]);

function toBuilder(target: any): any {
  return new Proxy(target, {
    get(obj, key) {
      if (key === 'insertIfAbsent') {
        // Supabase spells "insert, and leave it alone if that id already exists" as an upsert
        // with ignoreDuplicates; the answer is then an empty list instead of a clash.
        return (row: unknown, options: { onConflict?: string } = {}) =>
          toBuilder(obj.upsert(row, { onConflict: options.onConflict, ignoreDuplicates: true }));
      }
      const value = obj[key];
      if (typeof value !== 'function') return value;
      // Chainable verbs hand back a builder; everything else — above all `then`, which is what
      // `await` uses — runs on the real builder and resolves to its { data, error } result.
      if (CHAINABLE.has(String(key))) return (...args: unknown[]) => toBuilder(value.apply(obj, args));
      return value.bind(obj);
    },
  });
}

export function createDatabaseClient(service: Service) {
  const client = createClient(service.url, service.key, {
    auth: { persistSession: false, autoRefreshToken: false },
    // Wrapped so the runtime's own fetch is never called detached from its global.
    global: { fetch: (...args: Parameters<typeof fetch>) => fetch(...args) },
  });
  return { client, db: { from: (table: string) => toBuilder(client.from(table)) } };
}

export function createStorageClient(client: any, service: Service) {
  return {
    // Supabase hands out a signed upload URL that works with no further authentication, so
    // the browser can PUT a photo straight to the object store and never sees a key. Set
    // RELAY_UPLOADS=1 only if that PUT is ever blocked in your browser: the bytes then travel
    // through this function instead, and the page still holds no credential.
    relayUploads: /^(1|true|yes)$/i.test(Deno.env.get('RELAY_UPLOADS') ?? ''),
    maxUploadBytes: service.maxUploadBytes,
    /** One-shot capability for exactly this object; valid two hours, and not a key. */
    async createSignedUploadUrl(path: string) {
      const { data, error } = await client.storage.from(service.bucket).createSignedUploadUrl(path);
      if (error || !data?.signedUrl) throw new BackendError('storage_unavailable', 503);
      // Only the URL travels back to the page — never the bucket path or the token on its own.
      return { signedUrl: data.signedUrl };
    },
    async upload(path: string, data: Uint8Array, options: { contentType?: string } = {}) {
      const { error } = await client.storage
        .from(service.bucket)
        .upload(path, data, { contentType: options.contentType ?? 'application/octet-stream', upsert: false });
      if (error) throw new BackendError('storage_unavailable', 503);
    },
    async download(path: string) {
      const { data, error } = await client.storage.from(service.bucket).download(path);
      // The application turns a missing object into "that upload has not landed yet".
      if (error || !data) throw new BackendError('storage_object_not_found', 404);
      const blob = data as Blob;
      return new Response(blob, { headers: { 'content-type': blob.type || 'application/octet-stream' } });
    },
    /** Short-lived read capability for one object; a bearer URL, so it is never logged or cached. */
    async createSignedUrl(path: string, seconds: number) {
      const { data, error } = await client.storage.from(service.bucket).createSignedUrl(path, seconds);
      if (error || !data?.signedUrl) throw new BackendError('storage_unavailable', 503);
      return { signedUrl: data.signedUrl };
    },
  };
}

/** First cold start on a project where the SQL file was not run: make the bucket, and shrug if it exists. */
export async function ensureBucket(client: any, bucket: string) {
  try {
    const { data, error } = await client.storage.getBucket(bucket);
    if (data) return;
    if (error && !/not found/i.test(String(error.message ?? ''))) return;
    const made = await client.storage.createBucket(bucket, { public: false });
    if (made.error) console.warn('bucket:', made.error.message);
  } catch (problem) {
    console.warn('bucket check skipped:', problem);
  }
}

// ---------- cross-origin calls ----------

/** Empty list means any https origin, which is what a page on a host you do not control needs. */
export function allowedOrigins(): string[] {
  return (Deno.env.get('SITE_ORIGINS') ?? '')
    .split(',')
    .map(value => value.trim().replace(/\/+$/, ''))
    .filter(Boolean);
}

function echo(request: Request, allow: string[]): string | null {
  const origin = request.headers.get('origin');
  if (!origin || !/^https?:\/\//.test(origin)) return null;
  if (!allow.length || allow.includes('*')) return origin;
  return allow.includes(origin) ? origin : null;
}

const CORS_HEADERS = { 'vary': 'Origin', 'cache-control': 'no-store' };

/** A browser on another host asks permission first; answer it and stop there. */
export function preflight(request: Request, allow: string[]): Response | null {
  if (request.method !== 'OPTIONS') return null;
  const origin = echo(request, allow);
  if (!origin) return new Response(null, { status: 403, headers: CORS_HEADERS });
  return new Response(null, {
    status: 204,
    headers: {
      ...CORS_HEADERS,
      'access-control-allow-origin': origin,
      'access-control-allow-methods': 'GET, POST, PUT, OPTIONS',
      // The page only ever sends content-type; the rest are here so a Supabase-made client or a
      // future SDK header does not turn into a confusing "blocked by CORS" in the console.
      'access-control-allow-headers': 'content-type, apikey, authorization, x-client-info, x-upsert, cache-control',
      'access-control-max-age': '600',
    },
  });
}

export function withCors(response: Response, request: Request, allow: string[]): Response {
  const origin = echo(request, allow);
  if (!origin) return response;
  const headers = new Headers(response.headers);
  headers.set('access-control-allow-origin', origin);
  for (const [key, value] of Object.entries(CORS_HEADERS)) headers.set(key, value);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

/** Nothing about an internal failure belongs in a browser console: codes only, never details. */
export function errorResponse(error: unknown): Response {
  const known = error instanceof BackendError;
  if (!known) console.error('unhandled:', error);
  return Response.json(
    { error: known ? error.code : 'internal_error' },
    { status: known ? error.status : 500, headers: { 'cache-control': 'no-store' } },
  );
}
