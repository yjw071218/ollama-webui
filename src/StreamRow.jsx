import { useSyncExternalStore } from 'react';
import { streamSnapshot, subscribeStream } from './streamState.js';

export default function StreamRow({ chat, from, to, messages, render }) {
  const live = useSyncExternalStore(subscribeStream, () => streamSnapshot(chat, from, to), () => null);
  if (!live || !messages[live.index]) return render(messages);
  const copy = messages.slice();
  copy[live.index] = { ...copy[live.index], content: live.content, isMcpFetching: false };
  return render(copy);
}
