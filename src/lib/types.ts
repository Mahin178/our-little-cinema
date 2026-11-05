export type Peer = {
  peer: string;
  name: string;
  color: string;
  typing: number;
  last_read: number;
  call_state: 'idle' | 'ringing' | 'live';
  online: boolean;
};

export type MessageKind = 'text' | 'image' | 'voice' | 'sticker' | 'system' | 'recalled';

export type Message = {
  id: string;
  peer: string;
  name: string;
  color: string;
  kind: MessageKind;
  body: string;
  media: string | null;
  reactions: Record<string, string[]>;
  reply_to: string | null;
  created: number;
};

export type QueueItem = { video: string; title: string };

export type PlayerState = {
  video: string;
  title: string;
  position: number;
  playing: number;
  rate: number;
  queue: QueueItem[];
  updated_by: string;
  updated: number;
};

export type Signal = {
  id: string;
  from_peer: string;
  to_peer: string;
  kind: string;
  payload: string;
  created: number;
};

export type Session = { code: string; peer: string; token: string };

export type VoiceMeta = { secs: number; peaks: number[] };

export const EMPTY_PLAYER: PlayerState = {
  video: '',
  title: '',
  position: 0,
  playing: 0,
  rate: 1000,
  queue: [],
  updated_by: '',
  updated: 0,
};

export function parseVoice(message: Message): VoiceMeta {
  try {
    const parsed = JSON.parse(message.body);
    if (parsed && typeof parsed.secs === 'number') {
      return { secs: Math.max(0, parsed.secs), peaks: Array.isArray(parsed.peaks) ? parsed.peaks.slice(0, 80) : [] };
    }
  } catch { /* a plain-text body keeps older messages playable */ }
  return { secs: 0, peaks: [] };
}
