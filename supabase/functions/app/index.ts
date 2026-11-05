// Supabase Edge Function entry point for Our Little Cinema.
//
// Deployed as the function named `app`, reached from the page at
//   https://<project-ref>.supabase.co/functions/v1/app
// with JWT verification switched off: this function authenticates its own members — an
// HMAC token the room secret signs, which only the function can mint or check — and it is
// the only thing that ever holds the database key.
//
// `routes.mjs` is the application itself: the identical file the browser-facing routes were
// written against, copied here by `npm run function:sync` so the deploy folder is
// self-contained while /functions/routes.mjs stays the single source of truth.
import { application } from './routes.mjs';
import {
  BackendError,
  allowedOrigins,
  createDatabaseClient,
  createStorageClient,
  ensureBucket,
  errorResponse,
  preflight,
  readService,
  withCors,
} from '../_shared/backend.ts';

let handle: ((context: { request: Request }) => Promise<Response>) | null = null;
let origins: string[] = [];

try {
  const service = readService();
  const { client, db } = createDatabaseClient(service);
  const storage = createStorageClient(client, service);
  // Awaited before the first request: on a fresh project the photo bucket has to exist
  // by the time somebody attaches one.
  await ensureBucket(client, service.bucket);
  handle = application({ db, storage, BackendError, publicBase: service.publicBase });
  origins = allowedOrigins();
} catch (problem) {
  // A missing key is the owner's to fix, so say so in the function logs and answer 500 with
  // a code the page can explain. Never let half a configuration serve real traffic quietly.
  console.error('Our Little Cinema is not configured:', problem);
}

Deno.serve(async (request: Request) => {
  if (!handle) return errorResponse(new BackendError('service_misconfigured', 500));
  const early = preflight(request, origins);
  if (early) return early;
  try {
    return withCors(await handle({ request }), request, origins);
  } catch (error) {
    return withCors(errorResponse(error), request, origins);
  }
});
