// Writes the address the shipped page should call for its room service.
// The URL is public information (a browser calls it directly), so it lives in a plain
// repository variable — never a secret, never a key, never in the bundle's source.
//
//   node scripts/point-service.mjs <file>        # reads SUPABASE_FUNCTIONS_URL
//
// With the variable unset the file copied from public/config.json stays as it is, and the
// front door tells the visitor the room service is not connected instead of pretending.
import { readFile, writeFile } from 'node:fs/promises';

const file = process.argv[2];
if (!file) {
  console.error('usage: node scripts/point-service.mjs <path-to-config.json>');
  process.exit(1);
}

const raw = (process.env.SUPABASE_FUNCTIONS_URL ?? '').trim().replace(/\/+$/, '');
if (!raw) {
  console.log(`SUPABASE_FUNCTIONS_URL is not set — leaving ${file} as shipped.`);
  console.log('Set it in repository variables (Settings → Secrets and variables → Actions → Variables)');
  console.log('to the URL of your deployed edge function, e.g. https://<project>.supabase.co/functions/v1/app');
  process.exit(0);
}
if (!/^https:\/\/[^\s]+$/i.test(raw)) {
  console.error(`SUPABASE_FUNCTIONS_URL must be an absolute https URL, got: ${raw}`);
  process.exit(1);
}

let current = {};
try { current = JSON.parse(await readFile(file, 'utf8')); } catch { /* first deploy: no file yet */ }
await writeFile(file, `${JSON.stringify({ ...current, apiBase: raw }, null, 2)}\n`, 'utf8');
console.log(`${file} now points at ${raw}`);
