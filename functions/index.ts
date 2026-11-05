// Deployment entry point. `_qoder/*` modules are injected by the platform at
// deploy time and are deliberately not packaged in this directory.
import { createDatabaseClient, createSiteContext, errorResponse, BackendError } from './_qoder/backend.mjs';
import { createStorageClient } from './_qoder/storage.mjs';
import { application } from './routes.mjs';

const handle = application({ db: createDatabaseClient(), storage: createStorageClient(), BackendError });

Deno.serve(async request => {
  let context;
  try {
    context = createSiteContext(request);
    return await handle(context);
  } catch (error) {
    return errorResponse(error, context?.requestId);
  }
});
