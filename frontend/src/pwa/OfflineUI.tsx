// The phone app's offline pieces in the app shell (0.6.0, MP-053, r272): the service worker and its "new version"
// prompt, the offline banner, the pending-sync badge and its panel.
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, CloudOff, RefreshCw, Trash2, UploadCloud } from "lucide-react";
import { useSession } from "../lib/session";
import { discardQueued, onSynced, retryQueued, syncNow, useOfflineState, useOfflineSync, type Queued } from "../lib/offline";
import { Button, Drawer, EmptyState, Pill } from "../components/ui";
import "./pwa.css";

// ---------------------------------------------------------------- service worker
let waiting: ServiceWorker | null = null;
const updateListeners = new Set<() => void>();

export function registerServiceWorker(): void {
  if (!import.meta.env.PROD || typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
  if (!window.isSecureContext) return; // phones need https (or localhost) for an installable app
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js", { scope: "/" }).then((reg) => {
      const found = (w: ServiceWorker | null) => {
        if (!w) return;
        const ready = () => { if (w.state === "installed" && navigator.serviceWorker.controller) { waiting = w; updateListeners.forEach((l) => l()); } };
        w.addEventListener("statechange", ready);
        ready();
      };
      found(reg.waiting);
      reg.addEventListener("updatefound", () => found(reg.installing));
      setInterval(() => { void reg.update().catch(() => undefined); }, 30 * 60_000);
    }).catch(() => undefined);
    let reloading = false;
    navigator.serviceWorker.addEventListener("controllerchange", () => { if (!reloading) { reloading = true; window.location.reload(); } });
  });
}

/** Shown when a new MPro version is downloaded: it waits until the person chooses to reload. */
export function UpdatePrompt() {
  const [ready, setReady] = useState(!!waiting);
  useEffect(() => { const l = () => setReady(true); updateListeners.add(l); return () => { updateListeners.delete(l); }; }, []);
  if (!ready) return null;
  return (
    <div className="pwa-update" role="status">
      <RefreshCw size={16} /><span className="grow">A new version of MPro is ready.</span>
      <Button size="sm" variant="primary" onClick={() => waiting?.postMessage({ type: "SKIP_WAITING" })}>Reload</Button>
      <Button size="sm" variant="ghost" onClick={() => setReady(false)}>Later</Button>
    </div>);
}

// ---------------------------------------------------------------- keeping my work on the device
/** Mount once in the signed-in app. */
export function OfflineSync() {
  const { session, can } = useSession();
  const qc = useQueryClient();
  useOfflineSync(session.user?.id, session.org?.id, can("wo.view"));
  useEffect(() => onSynced((ids) => {
    for (const id of ids) {
      void qc.invalidateQueries({ queryKey: ["work-order", id] });
      void qc.invalidateQueries({ queryKey: ["wo-activity", id] });
      void qc.invalidateQueries({ queryKey: ["wo-parts", id] });
    }
    void qc.invalidateQueries({ queryKey: ["work-orders"] });
    void qc.invalidateQueries({ queryKey: ["my-timers"] });
  }), [qc]);
  return null;
}

export function OfflineBanner() {
  const s = useOfflineState();
  if (s.online && s.reachable) return null;
  return (
    <div className="pwa-offline" role="status" aria-live="polite">
      <CloudOff size={16} />
      <span className="grow">{!s.online ? "You're offline." : "Can't reach the MPro server."}{" "}
        {s.cached ? `Your ${s.cached} work order${s.cached === 1 ? " is" : "s are"} saved on this device. ` : ""}
        Changes are kept here and sync when you're back.</span>
      {s.pending > 0 && <Pill tone="warning">{s.pending} waiting</Pill>}
    </div>);
}

const label = (iso: string | null) => {
  if (!iso) return "Not synced yet";
  const m = Math.round((Date.now() - Date.parse(iso)) / 60000);
  return m < 1 ? "Synced just now" : m < 60 ? `Synced ${m} min ago` : `Synced ${new Date(iso).toLocaleString()}`;
};

/** Topbar button: how many changes wait to sync (and any that need a look). Opens the sync panel. */
export function SyncBadge() {
  const s = useOfflineState();
  const [open, setOpen] = useState(false);
  const count = s.pending + s.problems;
  const offline = !(s.online && s.reachable);
  if (!count && !offline && !open) return null;
  return <>
    <Button variant="ghost" icon className={"pwa-badge" + (s.problems ? " bad" : "")} aria-label={count ? `${count} change${count === 1 ? "" : "s"} waiting to sync` : "Offline"}
      title={label(s.lastSync)} onClick={() => setOpen(true)}>
      {offline ? <CloudOff size={18} /> : <UploadCloud size={18} />}{count > 0 && <span className="pwa-count">{count}</span>}
    </Button>
    {open && <SyncPanel onClose={() => setOpen(false)} />}
  </>;
}

export function SyncPanel({ onClose }: { onClose: () => void }) {
  const s = useOfflineState();
  const online = s.online && s.reachable;
  return (
    <Drawer title="Sync" onClose={onClose} width={440}
      footer={<><span className="small muted grow">{s.syncing ? "Syncing…" : label(s.lastSync)}</span>
        <Button variant="primary" disabled={!online || s.syncing} onClick={() => void syncNow()}><RefreshCw size={15} />Sync now</Button></>}>
      <div className="stack" style={{ gap: 12 }}>
        <p className="small muted" style={{ margin: 0 }}>
          {online ? "Connected." : "Offline."} {s.cached} work order{s.cached === 1 ? "" : "s"} assigned to you or your teams {s.cached === 1 ? "is" : "are"} saved on this device.
          {s.error && <> Last try: {s.error}</>}
        </p>
        {s.mine.length === 0 ? <EmptyState title="Everything is synced">Changes you make offline wait here until they're sent.</EmptyState>
          : <ul className="pwa-queue">{s.mine.map((q) => <QueuedRow key={q.seq ?? q.key} q={q} online={online} onOpen={onClose} />)}</ul>}
      </div>
    </Drawer>);
}

function QueuedRow({ q, online, onOpen }: { q: Queued; online: boolean; onOpen: () => void }) {
  const when = new Date(q.createdAt).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  return (
    <li className={"pwa-q " + q.status}>
      <div className="row" style={{ gap: 8, alignItems: "flex-start" }}>
        {q.status === "pending" ? <UploadCloud size={16} className="faint" /> : <AlertTriangle size={16} className="pwa-warn" />}
        <div className="grow">
          <div style={{ fontWeight: 600 }}>{q.label}</div>
          <div className="small muted">{when} · {q.status === "pending" ? "Waiting to send" : q.error}</div>
          {q.woId && <Link to={`/work-orders/${q.woId}`} className="small" onClick={onOpen}>Open the work order</Link>}
        </div>
      </div>
      {q.status !== "pending" && <div className="row" style={{ gap: 6, marginTop: 8, flexWrap: "wrap" }}>
        {q.status === "conflict" && <Button size="sm" disabled={!online} onClick={() => void retryQueued(q, true)} title="Send my change on top of theirs">Keep mine</Button>}
        {q.status !== "conflict" && <Button size="sm" disabled={!online} onClick={() => void retryQueued(q)}><RefreshCw size={14} />Try again</Button>}
        <Button size="sm" variant="ghost" onClick={() => void discardQueued(q)}><Trash2 size={14} />{q.status === "conflict" ? "Keep theirs" : "Discard"}</Button>
      </div>}
    </li>);
}
