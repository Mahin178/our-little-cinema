import { useEffect, useMemo, useRef, useState } from 'react';
import { Clock3, Search, X } from 'lucide-react';

const RECENT_KEY = 'little-cinema:emoji-recent';
const MAX_RECENT = 32;
const MAX_RESULTS = 160;

type EmojiItem = readonly [emoji: string, name: string];
type EmojiCategory = { id: string; label: string; icon: string; items: readonly EmojiItem[] };
type EmojiData = { EMOJI_CATEGORIES: readonly EmojiCategory[]; POPULAR: readonly string[] };

/** The full Unicode set is ~180 kB, so it is fetched the first time the picker opens
 *  instead of riding along with the initial page load. */
let cache: Promise<EmojiData> | null = null;
const loadEmojiData = (): Promise<EmojiData> => (cache ??= import('@/src/lib/emoji-data'));

/** Skin-tone and hair variants stay searchable but are hidden from the grid, the way
 *  Instagram keeps them behind a long-press instead of flooding every row. */
const isVariant = (name: string) => /skin tone|curly hair|wavy hair|red hair|white hair|gray hair|bald/.test(name);

const readRecent = (): string[] => {
  try {
    const raw = JSON.parse(window.localStorage.getItem(RECENT_KEY) ?? '[]');
    return Array.isArray(raw) ? raw.filter(value => typeof value === 'string').slice(0, MAX_RECENT) : [];
  } catch {
    return [];
  }
};

export default function EmojiKeyboard({ onPick, onClose }: { onPick: (emoji: string) => void; onClose: () => void }) {
  const [data, setData] = useState<EmojiData | null>(null);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState('popular');
  const [recent, setRecent] = useState<string[]>(readRecent);
  const search = useRef<HTMLInputElement | null>(null);
  const scroller = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    search.current?.focus();
    let alive = true;
    void loadEmojiData().then(value => { if (alive) setData(value); });
    return () => { alive = false; };
  }, []);

  const index = useMemo<EmojiItem[]>(
    () => (data ? data.EMOJI_CATEGORIES.flatMap(category => [...category.items]) : []),
    [data],
  );
  const lookup = useMemo(() => new Map(index.map(item => [item[0], item] as const)), [index]);

  const results = useMemo<EmojiItem[] | null>(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return null;
    // Ranked, because “heart” should open on ❤️ and not on the forty compound names that
    // merely begin with the word. Unicode puts the head noun last, so a suffix match wins.
    const stem = needle.length >= 4 ? needle.replace(/(s|ing|ed)$/, '') : needle;
    const scored: { item: EmojiItem; score: number }[] = [];
    for (const item of index) {
      const [emoji, name] = item;
      const words = name.split(' ').length;
      if (emoji === needle || name === needle) scored.push({ item, score: 0 });
      else if (name.endsWith(` ${needle}`)) scored.push({ item, score: 1 + words });
      else if (name.startsWith(needle)) scored.push({ item, score: 2 + words });
      else if (name.split(' ').includes(needle)) scored.push({ item, score: 3 + words });
      else if (name.includes(needle)) scored.push({ item, score: 5 + words });
      else if (stem.length >= 3 && name.includes(stem)) scored.push({ item, score: 8 + words });
    }
    return scored
      .sort((a, b) => a.score - b.score || a.item[1].length - b.item[1].length)
      .slice(0, MAX_RESULTS)
      .map(entry => entry.item);
  }, [query, index]);

  const sections = useMemo(() => {
    if (results) return [{ id: 'results', label: `Results for “${query.trim()}”`, items: results }];
    if (!data) return [];
    const list: { id: string; label: string; items: EmojiItem[] }[] = [];
    const recents = recent.map(emoji => lookup.get(emoji)).filter((item): item is EmojiItem => !!item);
    if (recents.length) list.push({ id: 'recent', label: 'Frequently used', items: recents });
    const favourites = data.POPULAR.map(emoji => lookup.get(emoji)).filter((item): item is EmojiItem => !!item);
    if (favourites.length) list.push({ id: 'popular', label: 'Our favourites', items: favourites });
    for (const category of data.EMOJI_CATEGORIES) {
      list.push({ id: category.id, label: category.label, items: category.items.filter(item => !isVariant(item[1])) });
    }
    return list;
  }, [data, results, lookup, recent, query]);

  const choose = (emoji: string) => {
    onPick(emoji);
    const next = [emoji, ...recent.filter(value => value !== emoji)].slice(0, MAX_RECENT);
    setRecent(next);
    try { window.localStorage.setItem(RECENT_KEY, JSON.stringify(next)); } catch { /* private mode: recents simply stop persisting */ }
  };

  /** Keeps the rail lit on whatever row is under the header, like Instagram's picker. */
  const track = () => {
    const box = scroller.current;
    if (!box) return;
    const lines = [...box.querySelectorAll<HTMLElement>('.emoji-section')];
    const edge = box.getBoundingClientRect().top + 30;
    let current = lines[0]?.dataset.id ?? '';
    for (const line of lines) {
      if (line.getBoundingClientRect().top <= edge) current = line.dataset.id ?? current;
      else break;
    }
    if (current) setActive(current);
  };

  const go = (id: string) => {
    setActive(id);
    const box = scroller.current;
    const target = box?.querySelector<HTMLElement>(`.emoji-section[data-id="${id}"]`);
    if (!box || !target) return;
    // Measured from the box, not offsetTop: the sheet is nested, and offsetTop would land on
    // whichever ancestor happens to be positioned. scrollIntoView would nudge the page too.
    const top = target.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop;
    box.scrollTo({ top, behavior: 'smooth' });
  };

  return (
    <div className="emoji-sheet" role="region" aria-label="Emoji keyboard">
      <div className="emoji-top">
        <div className="emoji-search">
          <Search aria-hidden="true" />
          <input
            ref={search}
            value={query}
            placeholder="Search emoji"
            aria-label="Search emoji by name"
            autoComplete="off"
            onChange={event => setQuery(event.target.value)}
            onKeyDown={event => { if (event.key === 'Escape') onClose(); }}
          />
          {query && <button type="button" onClick={() => setQuery('')} aria-label="Clear search"><X aria-hidden="true" /></button>}
        </div>
        <button type="button" className="tray-x" onClick={onClose} aria-label="Close emoji keyboard"><X aria-hidden="true" /></button>
      </div>

      <div className="emoji-body">
        {!results && data && (
          <div className="emoji-rail" role="tablist" aria-label="Emoji categories">
            {recent.length > 0 && (
              <button type="button" role="tab" aria-selected={active === 'recent'} className={`rail-dot${active === 'recent' ? ' on' : ''}`} onClick={() => go('recent')} aria-label="Frequently used">
                <Clock3 aria-hidden="true" />
              </button>
            )}
            <button type="button" role="tab" aria-selected={active === 'popular'} className={`rail-dot${active === 'popular' ? ' on' : ''}`} onClick={() => go('popular')} aria-label="Our favourites" title="Our favourites">
              <span aria-hidden="true">✨</span>
            </button>
            {data.EMOJI_CATEGORIES.map(category => (
              <button
                key={category.id}
                type="button"
                role="tab"
                aria-selected={active === category.id}
                className={`rail-dot${active === category.id ? ' on' : ''}`}
                onClick={() => go(category.id)}
                aria-label={category.label}
                title={category.label}
              >
                <span aria-hidden="true">{category.icon}</span>
              </button>
            ))}
          </div>
        )}

        <div className="emoji-scroll" ref={scroller} onScroll={track}>
          {!data ? (
            <p className="emoji-empty">Filling the emoji keyboard…</p>
          ) : (
            sections.map(section => (
              <section key={section.id} data-id={section.id} className="emoji-section">
                <span className="tray-label">{section.label}</span>
                {section.items.length ? (
                  <div className="tray-grid">
                    {section.items.map(([emoji, name]) => (
                      <button key={emoji} type="button" title={name} aria-label={`Insert ${name}`} onClick={() => choose(emoji)}>{emoji}</button>
                    ))}
                  </div>
                ) : (
                  <p className="emoji-empty">Nothing matches that. Try “heart”, “pizza” or “cat”.</p>
                )}
              </section>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
