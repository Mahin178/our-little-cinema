// Cute animated stickers are pure CSS + emoji, so they need no API key, no download
// and nothing that can break the day the site goes live.
export type Sticker = { id: string; glyph: string; anim: string; label: string };

export const STICKERS: Sticker[] = [
  { id: 'hug', glyph: '\u{1FAC1}', anim: 'sway', label: 'hug me' },
  { id: 'kiss', glyph: '\u{1F618}', anim: 'pop', label: 'smooch' },
  { id: 'heart', glyph: '\u{2764}\uFE0F', anim: 'beat', label: 'love' },
  { id: 'sparkle', glyph: '\u{2728}', anim: 'spin', label: 'sparkle' },
  { id: 'miss', glyph: '\u{1F97A}', anim: 'bob', label: 'miss you' },
  { id: 'dance', glyph: '\u{1F57A}', anim: 'dance', label: 'dance' },
  { id: 'sleepy', glyph: '\u{1F634}', anim: 'float', label: 'sleepy' },
  { id: 'movie', glyph: '\u{1F3AC}', anim: 'swing', label: 'movie time' },
  { id: 'popcorn', glyph: '\u{1F37F}', anim: 'bob', label: 'popcorn' },
  { id: 'blush', glyph: '\u{1F633}', anim: 'pop', label: 'blush' },
  { id: 'wave', glyph: '\u{1F44B}', anim: 'wave', label: 'hi' },
  { id: 'cry', glyph: '\u{1F62D}', anim: 'drip', label: 'aww' },
  { id: 'star', glyph: '\u{1F91F}', anim: 'twinkle', label: 'you!' },
  { id: 'moon', glyph: '\u{1F319}', anim: 'float', label: 'goodnight' },
  { id: 'fire', glyph: '\u{1F525}', anim: 'flicker', label: 'fire' },
  { id: 'cat', glyph: '\u{1F43E}', anim: 'beat', label: 'paws' },
];

export const stickerById = (id: string): Sticker | undefined => STICKERS.find(item => item.id === id);

export const REACTIONS = ['\u2764\uFE0F', '\u{1F602}', '\u{1F62D}', '\u{1F60D}', '\u{1F389}', '\u{1F63B}', '\u{1F44F}', '\u{1F62E}'];

export const EMOJI_GROUPS: { id: string; label: string; items: string[] }[] = [
  {
    id: 'hearts',
    label: 'hearts',
    items: ['\u2764\uFE0F', '\u{1F9E1}', '\u{1F49C}', '\u{1F499}', '\u{1F49A}', '\u{1F49B}', '\u{1F48E}', '\u{1F495}', '\u{1F49E}', '\u{1F493}', '\u{1F497}', '\u{1F496}', '\u{1F498}', '\u{1F49D}', '\u{1F4AF}', '\u{1F48B}'],
  },
  {
    id: 'faces',
    label: 'faces',
    items: ['\u{1F60D}', '\u{1F970}', '\u{1F618}', '\u{1F607}', '\u{1F60A}', '\u{1F602}', '\u{1F97A}', '\u{1F633}', '\u{1F63B}', '\u{1F60B}', '\u{1F60E}', '\u{1F929}', '\u{1F914}', '\u{1F62D}', '\u{1F622}', '\u{1F634}', '\u{1F62B}', '\u{1F60F}', '\u{1F480}', '\u{1F92A}', '\u{1F631}', '\u{1F624}'],
  },
  {
    id: 'hands',
    label: 'hands',
    items: ['\u{1F64F}', '\u{1F44D}', '\u{1F44E}', '\u{1F44A}', '\u{1F91E}', '\u{1F91F}', '\u{1F450}', '\u{1F64C}', '\u{1F4AA}', '\u{1F91D}', '\u{1F463}', '\u{1F44B}', '\u{1F918}', '\u{270C}\uFE0F', '\u{1F91B}', '\u{1F91C}'],
  },
  {
    id: 'movie',
    label: 'movie night',
    items: ['\u{1F3AC}', '\u{1F37F}', '\u{1F3A5}', '\u{1F39E}\uFE0F', '\u{1F37D}\uFE0F', '\u{1F943}', '\u{1F355}', '\u{1F36B}', '\u{1F36A}', '\u{2615}', '\u{1F37A}', '\u{1F35F}', '\u{1F36D}', '\u{1FA79}', '\u{1F6CB}\uFE0F', '\u{1F4FA}'],
  },
  {
    id: 'animals',
    label: 'animals',
    items: ['\u{1F43E}', '\u{1F415}', '\u{1F427}', '\u{1F984}', '\u{1F42C}', '\u{1F98A}', '\u{1F430}', '\u{1F438}', '\u{1F999}', '\u{1F422}', '\u{1F437}', '\u{1F426}', '\u{1FAB6}', '\u{1F338}', '\u{1F31E}', '\u{1F319}'],
  },
  {
    id: 'sparkle',
    label: 'sparkle',
    items: ['\u2728', '\u{1F31F}', '\u{1F4AB}', '\u{1F387}', '\u{1F389}', '\u{1F381}', '\u{1F48C}', '\u{1F4DD}', '\u{1F525}', '\u{1F308}', '\u2604\uFE0F', '\u{1F311}', '\u{1F49B}', '\u{1F90D}', '\u{1F9E2}', '\u{1F4A1}'],
  },
];

export const ALL_EMOJI = EMOJI_GROUPS.flatMap(group => group.items);
