// Realtime updates in the browser (0.6.0, r269). Owned by the messaging workstream (F2).
//
// useLive(topic, onEvent) subscribes while the component is mounted; useLiveInvalidate(topic, keys) invalidates
// TanStack Query keys whenever something arrives on the topic. A topic ending in "*" matches by prefix
// ("conv:*", "wo:*"). Every subscription in the tab shares ONE connection: a Server-Sent Events stream from
// /api/v1/realtime/stream, which the server authorizes row by row. When the server has no stream to spare (429) or
// the stream keeps failing, the tab polls /api/v1/realtime/poll every few seconds instead and tries streaming again
// later. Events carry ids and types only; components refetch through the normal API.
import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";

export type LiveEvent = { id?: string; topic: string; type: string; data: Record<string, unknown>; at?: string };
type Listener = { topic: string; fn: (e: LiveEvent) => void };

const listeners = new Set<Listener>();
const seen = new Set<string>();
let cursor = "";
let es: EventSource | null = null;
let pollTimer: number | null = null;
let retryTimer: number | null = null;
let failures = 0;
let stopped = true;

function matches(want: string, topic: string): boolean {
  return want === "*" || want === topic || (want.endsWith("*") && topic.startsWith(want.slice(0, -1)));
}

function dispatch(e: LiveEvent) {
  if (e.id) {
    if (seen.has(e.id)) return;
    seen.add(e.id);
    if (seen.size > 3000) { const first = seen.values().next().value; if (first) seen.delete(first); }
  }
  if (e.at && e.at > cursor) cursor = e.at;
  for (const l of Array.from(listeners)) if (matches(l.topic, e.topic)) { try { l.fn(e); } catch { /* a broken listener must not stop the rest */ } }
}

function resync() {
  // the server dropped events for us (overload, long disconnect): tell everyone to refetch
  for (const l of Array.from(listeners)) { try { l.fn({ topic: l.topic, type: "resync", data: {} }); } catch { /* ignore */ } }
}

function openStream() {
  if (stopped || es || typeof EventSource === "undefined") { if (typeof EventSource === "undefined") startPolling(); return; }
  const url = "/api/v1/realtime/stream" + (cursor ? `?since=${encodeURIComponent(cursor)}` : "");
  const src = new EventSource(url, { withCredentials: true });
  es = src;
  src.addEventListener("hello", (ev) => {
    failures = 0;
    stopPolling();
    try { const d = JSON.parse((ev as MessageEvent).data); if (!cursor && d.cursor) cursor = d.cursor; } catch { /* ignore */ }
  });
  src.addEventListener("rt", (ev) => { try { dispatch(JSON.parse((ev as MessageEvent).data)); } catch { /* ignore */ } });
  src.addEventListener("resync", resync);
  src.onerror = () => {
    // CLOSED means the server refused (429 budget, 401, proxy without streaming): fall back to polling
    if (src.readyState === EventSource.CLOSED || ++failures >= 3) {
      src.close();
      if (es === src) es = null;
      startPolling();
      if (retryTimer === null) retryTimer = window.setTimeout(() => { retryTimer = null; if (!stopped && listeners.size) openStream(); }, 60_000);
    }
  };
}

async function pollOnce() {
  try {
    const res = await fetch("/api/v1/realtime/poll" + (cursor ? `?since=${encodeURIComponent(cursor)}` : ""), { credentials: "same-origin", headers: { Accept: "application/json" } });
    if (res.status === 401 || res.status === 403) { stop(); return; }
    if (!res.ok) return;
    const body = await res.json() as { items: LiveEvent[]; cursor: string };
    for (const e of body.items) dispatch(e);
    if (body.cursor && body.cursor > cursor) cursor = body.cursor;
  } catch { /* offline: try again next tick */ }
}

function startPolling() {
  if (pollTimer !== null || stopped) return;
  void pollOnce();
  pollTimer = window.setInterval(() => { if (!document.hidden) void pollOnce(); }, 4000);
}

function stopPolling() {
  if (pollTimer !== null) { window.clearInterval(pollTimer); pollTimer = null; }
}

function start() {
  if (!stopped) return;
  stopped = false;
  openStream();
}

function stop() {
  stopped = true;
  es?.close(); es = null;
  stopPolling();
  if (retryTimer !== null) { window.clearTimeout(retryTimer); retryTimer = null; }
}

/** Close the connection (sign out, organization switch). The next subscriber opens a fresh one. */
export function resetLive(): void { stop(); cursor = ""; seen.clear(); if (listeners.size) start(); }

export function useLive(topic: string | null, onEvent: (e: LiveEvent) => void): void {
  const cb = useRef(onEvent);
  cb.current = onEvent;
  useEffect(() => {
    if (!topic) return;
    const l: Listener = { topic, fn: (e) => cb.current(e) };
    listeners.add(l);
    start();
    return () => {
      listeners.delete(l);
      if (!listeners.size) window.setTimeout(() => { if (!listeners.size) stop(); }, 5000); // page changes re-subscribe quickly
    };
  }, [topic]);
}

export function useLiveInvalidate(topic: string | null, keys: unknown[][]): void {
  const qc = useQueryClient();
  const keyRef = useRef(keys);
  keyRef.current = keys;
  const timer = useRef<number | null>(null);
  useLive(topic, () => {
    // bursts (bulk edits) refetch once
    if (timer.current !== null) return;
    timer.current = window.setTimeout(() => {
      timer.current = null;
      for (const k of keyRef.current) void qc.invalidateQueries({ queryKey: k });
    }, 300);
  });
}
