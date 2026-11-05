const ID = /^[0-9A-Za-z_-]{11}$/;

/** True for a well-formed 11-character video id — the player refuses anything else. */
export function isVideoId(value: string) { return ID.test(value ?? ''); }

/** Accepts anything a person pastes from YouTube and returns the 11-character video id. */
export function parseYouTube(input: string): string | null {
  const value = (input ?? '').trim();
  if (!value) return null;
  if (ID.test(value)) return value;
  let url: URL;
  try { url = new URL(value.startsWith('http') ? value : `https://${value}`); }
  catch { return null; }
  const host = url.hostname.replace(/^www\./, '');
  if (host === 'youtu.be') {
    const id = url.pathname.slice(1).split('/')[0];
    return ID.test(id) ? id : null;
  }
  if (!/(^|\.)youtube(-nocookie)?\.com$/.test(host)) return null;
  const direct = url.searchParams.get('v');
  if (direct && ID.test(direct)) return direct;
  const parts = url.pathname.split('/').filter(Boolean);
  const marker = parts.findIndex(part => ['embed', 'shorts', 'live', 'v'].includes(part));
  if (marker >= 0 && parts[marker + 1] && ID.test(parts[marker + 1])) return parts[marker + 1];
  return null;
}

const clock = (raw: string) => {
  const parts = raw.match(/(\d+)(h|m|'|s|")?/g) ?? [];
  let seconds = 0;
  let sawUnit = false;
  for (const part of parts) {
    const digits = Number(part.match(/\d+/)?.[0] ?? 0);
    const unit = part.replace(/\d/g, '');
    if (unit === 'h' || unit === '"') seconds += digits * 3600;
    else if (unit === 'm' || unit === "'") seconds += digits * 60;
    else if (unit === 's') { seconds += digits; sawUnit = true; }
    else if (!unit) seconds = seconds ? seconds * 60 + digits : digits;
    if (unit) sawUnit = true;
  }
  if (!sawUnit) {
    const bare = Number(raw.replace(/[^0-9]/g, ''));
    seconds = Number.isFinite(bare) ? bare : 0;
  }
  return Math.max(0, Math.min(seconds, 86_400));
};

/** Seconds from a #t=, &t= or &start= parameter, so "start at 4:10" links work. */
export function startAt(input: string): number {
  const value = (input ?? '').trim();
  let raw = '';
  try {
    const url = new URL(value.startsWith('http') ? value : `https://x/${value}`);
    raw = url.searchParams.get('t') ?? url.searchParams.get('start') ?? url.searchParams.get('seek') ?? url.hash.match(/t=([^&]+)/)?.[1] ?? '';
  } catch {
    raw = value.match(/t=([^&\s]+)/)?.[1] ?? '';
  }
  return raw ? clock(String(raw)) : 0;
}

export function watchUrl(id: string) {
  return `https://www.youtube.com/watch?v=${id}`;
}

export function clockLabel(ms: number) {
  const raw = Number.isFinite(ms) && ms > 0 ? ms : 0;
  const total = Math.floor(raw / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  return hours
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
    : `${minutes}:${String(seconds).padStart(2, '0')}`;
}
