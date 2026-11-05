// Starts the fixture backend and the real frontend dev server together.
// Local only: this file and dev/local.mjs are outside webDirectory and functionDirectory.
import { startLocalBackend } from './local.mjs';

const { application } = await import(new URL('../functions/routes.mjs', import.meta.url).href);
const backend = await startLocalBackend(application, { port: 8000 });
console.log(`Fixture backend on ${backend.origin} (memory data, resets on restart)`);

const vite = await import('vite');
let frontend;
try {
  frontend = await vite.createServer();
  await frontend.listen();
  frontend.printUrls();
} catch (error) {
  await backend.close();
  throw error;
}
console.log('Local fixture mode — open /__local/ for fault controls. Ctrl+C closes only these two processes.');

const stop = async () => { await frontend.close(); await backend.close(); process.exit(0); };
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
