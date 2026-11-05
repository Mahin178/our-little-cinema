import { useSyncExternalStore } from 'react';
import { runtime } from './runtime';
import type { Message, Peer, PlayerState, Session } from './types';
import type { ChatMessage } from './runtime';

export type RoomSnapshot = {
  session: Session | null;
  identity: { name: string; color: string };
  peers: Peer[];
  player: PlayerState;
  connected: boolean;
  connecting: boolean;
  error: string;
  offset: number;
  oldest: number;
  loadingOlder: boolean;
  atBottom: boolean;
  mediaVersion: number;
};

export function useRoom() {
  return useSyncExternalStore(runtime.subscribeState, runtime.getState as () => RoomSnapshot, runtime.getState as () => RoomSnapshot);
}

export function useMessages() {
  return useSyncExternalStore(runtime.subscribeMessages, runtime.getMessages as () => ChatMessage[], runtime.getMessages as () => ChatMessage[]);
}

export { runtime };
export type { Message, Peer, PlayerState, ChatMessage };
