// Notifications (MP-050, MP-051): the inbox and each person's notification settings (channels per event, which work
// orders, comments and message levels, email digests, quiet hours, pause, and push on this device).
import { useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlarmClock, AtSign, Bell, BellOff, CheckCheck, ClipboardList, Inbox, MessageSquare, ShoppingCart, Smartphone, TriangleAlert, UserPlus } from "lucide-react";
import { api, ApiError } from "../../lib/api";
import { timeAgo } from "../../lib/format";
import { markRead, CATEGORY_ORDER, type Channel, type Notice, type NoticePage, type NotifSettings, type Prefs } from "../../lib/notifications";
import { currentSubscription, disablePush, enablePush, pushSupported } from "../../lib/push";
import { useToast } from "../../components/Toast";
import { Button, Checkbox, EmptyState, Field, Input, ListSkeleton, Select, Toggle } from "../../components/ui";
import "./notifications.css";

const KIND_ICON: Record<string, typeof Bell> = {
  "wo.assigned": UserPlus, "wo.mentioned": AtSign, "wo.commented": MessageSquare, "wo.overdue": AlarmClock, "wo.due_soon": AlarmClock,
  "wo.escalated": TriangleAlert, "po.needs_approval": ShoppingCart, "po.decided": ShoppingCart, "request.new": Inbox, "request.update": Inbox,
  "message.direct": MessageSquare, "message.other": MessageSquare,
};

export function NoticeRow({ n, onOpen, compact = false }: { n: Notice; onOpen: () => void; compact?: boolean }) {
  const Icon = KIND_ICON[n.kind] ?? (n.category === "work_orders" ? ClipboardList : Bell);
  const tone = n.kind === "wo.escalated" || n.kind === "wo.overdue" ? " danger" : n.kind === "wo.due_soon" ? " warning" : "";
  return (
    <button type="button" role="listitem" className={"notif-row" + (n.read_at ? "" : " unread") + (compact ? " compact" : "")} onClick={onOpen}>
      <span className={"notif-ic" + tone} aria-hidden><Icon size={16} /></span>
      <span className="notif-main">
        <span className="notif-title">{n.title}</span>
        {n.body && <span className="notif-body">{n.body}</span>}
        <span className="notif-when">{timeAgo(n.created_at)}</span>
      </span>
      {!n.read_at && <span className="notif-dot" aria-label="Unread" />}
    </button>
  );
}

export function NotificationsPage() {
  const [params, setParams] = useSearchParams();
  const tab = params.get("tab") === "settings" ? "settings" : "inbox";
  return (
    <div className="page notif-page">
      <div className="page-head"><div><h1>Notifications</h1><p className="sub">What happened on your work, and how you want to hear about it.</p></div></div>
      <div className="tabs" role="tablist">
        <button type="button" role="tab" className="tab" aria-selected={tab === "inbox"} onClick={() => setParams({})}><Inbox size={15} />Inbox</button>
        <button type="button" role="tab" className="tab" aria-selected={tab === "settings"} onClick={() => setParams({ tab: "settings" })}><Bell size={15} />Settings</button>
      </div>
      {tab === "inbox" ? <InboxTab /> : <SettingsTab />}
    </div>
  );
}

function InboxTab() {
  const nav = useNavigate();
  const qc = useQueryClient();
  const { toast } = useToast();
  const [unreadOnly, setUnreadOnly] = useState(false);
  const q = useInfiniteQuery({
    queryKey: ["notifications", "inbox", unreadOnly],
    initialPageParam: "",
    queryFn: ({ pageParam }) => api<NoticePage>(`/notifications?limit=30${unreadOnly ? "&unread=1" : ""}${pageParam ? `&before=${encodeURIComponent(pageParam)}` : ""}`),
    getNextPageParam: (last) => last.next ?? undefined,
  });
  const done = () => qc.invalidateQueries({ queryKey: ["notifications"] });
  const all = useMutation({ mutationFn: () => markRead("all"), onSuccess: (r) => { done(); toast(r.updated ? `Marked ${r.updated} as read` : "Nothing unread"); } });
  const items = useMemo(() => q.data?.pages.flatMap((p) => p.items) ?? [], [q.data]);
  const unread = q.data?.pages[0]?.unread ?? 0;
  const groups = useMemo(() => {
    const out: { label: string; items: Notice[] }[] = [];
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const yesterday = new Date(today); yesterday.setDate(today.getDate() - 1);
    for (const n of items) {
      const d = new Date(n.created_at);
      const label = d >= today ? "Today" : d >= yesterday ? "Yesterday" : d.toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" });
      const g = out[out.length - 1];
      if (g && g.label === label) g.items.push(n); else out.push({ label, items: [n] });
    }
    return out;
  }, [items]);
  return (
    <div className="stack" style={{ gap: 12 }}>
      <div className="row wrap" style={{ gap: 8 }}>
        <div className="seg" role="radiogroup" aria-label="Show">
          <button type="button" role="radio" aria-checked={!unreadOnly} className={"seg-btn" + (!unreadOnly ? " on" : "")} onClick={() => setUnreadOnly(false)}>All</button>
          <button type="button" role="radio" aria-checked={unreadOnly} className={"seg-btn" + (unreadOnly ? " on" : "")} onClick={() => setUnreadOnly(true)}>Unread{unread ? ` (${unread})` : ""}</button>
        </div>
        <span className="grow" />
        <Button onClick={() => all.mutate()} disabled={!unread}><CheckCheck size={15} />Mark all read</Button>
      </div>
      <div className="card notif-list">
        {q.isLoading ? <ListSkeleton rows={6} />
          : items.length === 0 ? <EmptyState icon={<Bell size={28} />} title={unreadOnly ? "No unread notifications" : "No notifications yet"}>
            Assignments, mentions, status changes and due dates on your work show up here.</EmptyState>
            : groups.map((g) => (
              <div key={g.label} role="list" aria-label={g.label}>
                <div className="notif-day">{g.label}</div>
                {g.items.map((n) => <NoticeRow key={n.id} n={n} onOpen={() => { if (!n.read_at) void markRead([n.id]).then(done); nav(n.link || "/notifications"); }} />)}
              </div>))}
        {q.hasNextPage && <div className="notif-more"><Button onClick={() => void q.fetchNextPage()} disabled={q.isFetchingNextPage}>Show older</Button></div>}
      </div>
    </div>
  );
}

// ---- settings --------------------------------------------------------------------------------------
const CHANNELS: [Channel, string][] = [["in_app", "In app"], ["email", "Email"], ["push", "Push"]];
const PAUSES: [number, string][] = [[60, "1 hour"], [240, "4 hours"], [60 * 24, "Until tomorrow"], [60 * 24 * 7, "1 week"]];

function SettingsTab() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const s = useQuery({ queryKey: ["notifications", "settings"], queryFn: () => api<NotifSettings>("/notifications/settings") });
  const err = (e: unknown) => toast((e as ApiError).message, { kind: "error" });
  const save = useMutation({
    mutationFn: (patch: Record<string, unknown>) => api<NotifSettings>("/notifications/settings", { method: "PATCH", body: patch }),
    onSuccess: (v) => qc.setQueryData(["notifications", "settings"], v), onError: err,
  });
  const pause = useMutation({
    mutationFn: (minutes: number) => api<NotifSettings>("/notifications/pause", { method: "POST", body: { minutes } }),
    onSuccess: (v) => { qc.setQueryData(["notifications", "settings"], v); toast(v.paused_until ? "Notifications paused" : "Notifications back on"); }, onError: err,
  });
  if (!s.data) return <ListSkeleton rows={8} />;
  const { prefs, catalogue } = s.data;
  const paused = s.data.paused_until && new Date(s.data.paused_until) > new Date() ? s.data.paused_until : null;
  const setChannel = (key: string, c: Channel, v: boolean) => save.mutate({ channels: { [key]: { [c]: v } } });
  const cats = CATEGORY_ORDER.filter((c) => catalogue.some((e) => e.category === c));
  return (
    <div className="stack" style={{ gap: 20 }}>
      <section className="card">
        <div className="card-head"><h2>Pause notifications</h2></div>
        <div className="card-body stack">
          {paused ? <div className="row wrap" style={{ gap: 8 }}>
            <span className="row" style={{ gap: 6 }}><BellOff size={16} />Paused until {new Date(paused).toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" })}. You'll still see them here.</span>
            <Button onClick={() => pause.mutate(0)}>Resume now</Button></div>
            : <div className="row wrap" style={{ gap: 8 }}><span className="muted small">Stop push and email for a while:</span>
              {PAUSES.map(([m, l]) => <Button key={m} size="sm" onClick={() => pause.mutate(m)}>{l}</Button>)}</div>}
        </div>
      </section>

      <section className="card">
        <div className="card-head"><h2>What you hear about</h2></div>
        <div className="card-body notif-matrix-wrap">
          <table className="table notif-matrix">
            <thead><tr><th>Event</th>{CHANNELS.map(([c, l]) => <th key={c} className="c">{l}</th>)}</tr></thead>
            {cats.map((cat) => (
              <tbody key={cat}>
                <tr className="notif-cat"><th colSpan={4}>{catalogue.find((e) => e.category === cat)?.category_label}</th></tr>
                {catalogue.filter((e) => e.category === cat).map((e) => (
                  <tr key={e.key}><td>{e.label}</td>
                    {CHANNELS.map(([c, l]) => <td key={c} className="c">
                      <Checkbox checked={!!prefs.channels[e.key]?.[c]} onChange={(v) => setChannel(e.key, c, v)} label={<span className="sr-only">{`${l}: ${e.label}`}</span>} /></td>)}
                  </tr>))}
              </tbody>))}
          </table>
        </div>
      </section>

      <section className="card">
        <div className="card-head"><h2>Work orders</h2></div>
        <div className="card-body stack">
          <div className="small muted">Send me events for work orders that are:</div>
          <Toggle label="Created by me" checked={prefs.groups.created_by_me} onChange={(v) => save.mutate({ groups: { created_by_me: v } })} />
          <Toggle label="Assigned to me" checked={prefs.groups.assigned_to_me} onChange={(v) => save.mutate({ groups: { assigned_to_me: v } })} />
          <Toggle label="Assigned to my teams" checked={prefs.groups.my_teams} onChange={(v) => save.mutate({ groups: { my_teams: v } })} />
          <Field label="Comments">{(id) => (
            <Select id={id} value={prefs.comments} onChange={(e) => save.mutate({ comments: e.target.value })} style={{ maxWidth: 360 }}>
              <option value="all">Every new comment</option><option value="mentions">Only when I'm @mentioned</option></Select>)}</Field>
          <Field label="Messages">{(id) => (
            <Select id={id} value={prefs.messages} onChange={(e) => save.mutate({ messages: e.target.value })} style={{ maxWidth: 360 }}>
              <option value="all">All messages</option><option value="direct">Direct messages and mentions only</option><option value="none">Nothing</option></Select>)}</Field>
        </div>
      </section>

      <section className="card">
        <div className="card-head"><h2>Email</h2></div>
        <div className="card-body stack">
          <Field label="Send emails" hint="Digests collect everything into one email.">{(id) => (
            <Select id={id} value={prefs.email_frequency} onChange={(e) => save.mutate({ email_frequency: e.target.value })} style={{ maxWidth: 360 }}>
              <option value="instant">Right away</option><option value="hourly">Hourly digest</option><option value="daily">Daily digest</option></Select>)}</Field>
          {prefs.email_frequency === "daily" && <Field label="Daily digest at">{(id) => (
            <Select id={id} value={prefs.digest_hour} onChange={(e) => save.mutate({ digest_hour: Number(e.target.value) })} style={{ maxWidth: 200 }}>
              {Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{new Date(2000, 0, 1, h).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}</option>)}
            </Select>)}</Field>}
        </div>
      </section>

      <QuietHours prefs={prefs} onSave={(q) => save.mutate({ quiet: q })} />
      <PushSection data={s.data} />
    </div>
  );
}

function QuietHours({ prefs, onSave }: { prefs: Prefs; onSave: (q: Partial<Prefs["quiet"]>) => void }) {
  const [start, setStart] = useState(prefs.quiet.start);
  const [end, setEnd] = useState(prefs.quiet.end);
  useEffect(() => { setStart(prefs.quiet.start); setEnd(prefs.quiet.end); }, [prefs.quiet.start, prefs.quiet.end]);
  return (
    <section className="card">
      <div className="card-head"><h2>Quiet hours</h2></div>
      <div className="card-body stack">
        <div className="small muted">No push or email during these hours. Emails wait and arrive together afterwards; everything is still in your inbox.</div>
        <Toggle label="Do not disturb every day" checked={prefs.quiet.enabled} onChange={(v) => onSave({ enabled: v })} />
        <div className="row wrap" style={{ gap: 12 }}>
          <Field label="From">{(id) => <Input id={id} type="time" value={start} disabled={!prefs.quiet.enabled} onChange={(e) => setStart(e.target.value)} onBlur={() => start !== prefs.quiet.start && onSave({ start })} />}</Field>
          <Field label="To">{(id) => <Input id={id} type="time" value={end} disabled={!prefs.quiet.enabled} onChange={(e) => setEnd(e.target.value)} onBlur={() => end !== prefs.quiet.end && onSave({ end })} />}</Field>
        </div>
        <Toggle label="Also quiet all weekend" checked={prefs.quiet.weekends} onChange={(v) => onSave({ weekends: v })} />
      </div>
    </section>
  );
}

function PushSection({ data }: { data: NotifSettings }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [here, setHere] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const supported = pushSupported();
  useEffect(() => { void currentSubscription().then((s) => setHere(!!s)).catch(() => setHere(false)); }, []);
  const refresh = () => qc.invalidateQueries({ queryKey: ["notifications", "settings"] });
  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true);
    try { await fn(); toast(ok); } catch (e) { toast((e as Error).message, { kind: "error" }); } finally { setBusy(false); refresh(); void currentSubscription().then((s) => setHere(!!s)); }
  };
  const removeDevice = (id: string) => run(() => api("/notifications/push/subscriptions", { method: "DELETE", body: { id } }), "Device removed");
  return (
    <section className="card">
      <div className="card-head"><h2>Push notifications</h2></div>
      <div className="card-body stack">
        {!supported ? <div className="banner info">This browser can't receive push notifications. On iPhone and iPad, add MPro to the home screen first.</div>
          : <div className="row wrap" style={{ gap: 8 }}>
            <Smartphone size={16} />
            <span>{here ? "This device gets push notifications." : "Push is off on this device."}</span>
            <span className="grow" />
            {here ? <>
              <Button disabled={busy} onClick={() => run(() => api("/notifications/push/test", { method: "POST", body: {} }), "Test sent")}>Send a test</Button>
              <Button disabled={busy} onClick={() => run(disablePush, "Push turned off on this device")}>Turn off</Button>
            </> : <Button variant="primary" disabled={busy || !data.push.public_key} onClick={() => run(() => enablePush(data.push.public_key), "Push turned on")}>Turn on for this device</Button>}
          </div>}
        {data.push.devices.length > 0 && <div className="stack" style={{ gap: 4 }}>
          <div className="small muted">Your devices</div>
          {data.push.devices.map((d) => (
            <div key={d.id} className="row notif-device"><span className="grow">{d.label || "Device"}</span>
              <span className="small faint">{d.last_used_at ? `last used ${timeAgo(d.last_used_at)}` : `added ${timeAgo(d.created_at)}`}</span>
              <Button size="sm" variant="ghost" onClick={() => void removeDevice(d.id)}>Remove</Button></div>))}
        </div>}
      </div>
    </section>
  );
}
