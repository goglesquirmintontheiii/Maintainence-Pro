// Realtime updates in the browser (0.6.0, r269). Owned by the messaging workstream (F2).
// Contract: useLive(topic, onEvent) subscribes while the component is mounted; useLiveInvalidate(topic, keys)
// invalidates TanStack Query keys whenever something arrives on the topic. Placeholder: does nothing until F2 lands.
export type LiveEvent = { topic: string; type: string; data: Record<string, unknown> };

export function useLive(_topic: string | null, _onEvent: (e: LiveEvent) => void): void { /* F2 */ }

export function useLiveInvalidate(_topic: string | null, _keys: unknown[][]): void { /* F2 */ }
