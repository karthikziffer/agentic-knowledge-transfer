import Redis from "ioredis";
import { redisConnectionOptions } from "./redisConnection";

// One shared connection for every publish() call in this process — a plain
// command connection, safe to reuse across calls. Never used for
// subscribe(), which puts a connection into a mode that can't run any other
// command (see subscribeOnce below, which always opens its own).
let publisher: Redis | undefined;

function getPublisher(): Redis {
  return (publisher ??= new Redis(redisConnectionOptions()));
}

export async function publish(channel: string, payload: unknown): Promise<void> {
  await getPublisher().publish(channel, JSON.stringify(payload));
}

// Opens a dedicated connection subscribed to exactly one channel and calls
// onMessage for each payload published to it, JSON-parsed. Returns an
// unsubscribe function the caller must call once it's done listening (e.g.
// when its own HTTP request ends) — otherwise this connection, and the
// channel subscription, leaks for the life of the process.
export function subscribeOnce(channel: string, onMessage: (payload: unknown) => void): () => void {
  const sub = new Redis(redisConnectionOptions());
  let closed = false;

  sub.subscribe(channel).catch((err) => {
    if (!closed) console.error(`[redisPubSub] failed to subscribe to ${channel}`, err);
  });
  sub.on("message", (ch, message) => {
    if (ch !== channel) return;
    try {
      onMessage(JSON.parse(message));
    } catch (err) {
      console.error(`[redisPubSub] malformed message on ${channel}`, err);
    }
  });

  return () => {
    closed = true;
    sub.disconnect();
  };
}
