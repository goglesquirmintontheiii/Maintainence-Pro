// Offline support for the phone app (0.6.0, MP-053). Owned by the PWA workstream (F4).
// Contract: queueMutation() sends now when online, or stores the change and replays it (with its idempotency key)
// when the connection is back. useOnline() tracks the connection. Placeholder: always sends straight away.
import { api } from "./api";

export type Mutation = { method: "POST" | "PATCH" | "PUT" | "DELETE"; path: string; body?: unknown; label: string; idempotencyKey?: string };
export type MutationResult<T> = { queued: boolean; result?: T };

export async function queueMutation<T = unknown>(m: Mutation): Promise<MutationResult<T>> {
  const result = await api<T>(m.path, { method: m.method, body: m.body });
  return { queued: false, result };
}

export function useOnline(): boolean { return true; }
