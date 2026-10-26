// Messages (0.6.0, MP-049): MaintainX layout. Conversations and Threads on the left, the conversation on the right
// (full screen on phones, G-18). Direct, group, team, All Team and work order chats; threads, reactions, files,
// @mentions, edits, permalinks, announcements with read confirmations, search, and live updates (r269).
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient, type InfiniteData } from "@tanstack/react-query";
import {
  ArrowLeft, Bell, BellOff, Check, ClipboardList, Copy, EyeOff, FileText, Hash, Info, Link2, LogOut, Megaphone, MessageSquare, MessagesSquare,
  MoreHorizontal, Paperclip, Pencil, Pin, PinOff, Plus, Search, Send, Smile, Trash2, UserPlus, Users, X,
} from "lucide-react";
import { api, ApiError, upload, type FileItem, type WOOptions } from "../../lib/api";
import { useSession } from "../../lib/session";
import { timeAgo, dateTime } from "../../lib/format";
import { absoluteUrl, copyText } from "../../lib/wo";
import { useLive } from "../../lib/live";
import { useToast } from "../../components/Toast";
import { Avatar, Button, Dropdown, EmptyState, Field, Input, ListSkeleton, Modal, Pill, Toggle } from "../../components/ui";
import { MentionBox, MultiPicker, RichText } from "../../components/pickers";
import { DropZone } from "../../components/DropZone";
import { FileViewer } from "../../components/FileViewer";
import { usePeople, type ConvDetail, type ConvSummary, type Msg, type MsgPage, type People } from "./types";
import "../../styles/workorders.css";
import "./messages.css";

const EMOJI = ["👍", "✅", "👀", "🙏", "🎉", "❤️", "😂", "⚠️"];
const NOTIFY_LABEL = { all: "All messages", mentions: "Mentions only", none: "Nothing" } as const;

function useErr() {
  const { toast } = useToast();
  return (e: unknown) => toast((e as ApiError).message ?? "Something went wrong", { kind: "error" });
}

/** People and teams in the shape MentionBox expects. */
function mentionOptions(p: People | undefined): WOOptions | undefined {
  if (!p) return undefined;
  return { people: p.people.map((x) => ({ ...x, role: "", assignable: true })), teams: p.teams, settings: { mention_assigns: false } } as unknown as WOOptions;
}

export function MessagesPage() {
  const { id } = useParams();
  const [params] = useSearchParams();
  const [tab, setTab] = useState<"conversations" | "threads">(params.get("tab") === "threads" ? "threads" : "conversations");
  const [q, setQ] = useState("");
  const [creating, setCreating] = useState(false);
  const qc = useQueryClient();
  const { can } = useSession();
  const list = useQuery({ queryKey: ["conversations"], queryFn: () => api<{ items: ConvSummary[]; unread_total: number }>("/conversations"), enabled: can("messages.use") });
  useLive("conv:*", () => { void qc.invalidateQueries({ queryKey: ["conversations"] }); void qc.invalidateQueries({ queryKey: ["threads"] }); });
  useLive("org:team", () => { void qc.invalidateQueries({ queryKey: ["conversations"] }); });
  if (!can("messages.use")) return <div className="page"><EmptyState icon={<MessageSquare size={28} />} title="Messages aren't available">Your role can't send messages. Ask an administrator if you need to.</EmptyState></div>;
  return (
    <div className={"split msg-split" + (id ? " has-detail" : "")}>
      <div className="split-list msg-list-pane">
        <div className="list-tools">
          <div className="row" style={{ justifyContent: "space-between" }}>
            <h1>Messages</h1>
            <Button variant="primary" onClick={() => setCreating(true)} aria-label="New message"><Plus size={16} /><span className="desktop-only">New</span></Button>
          </div>
          <div className="search-in"><Search size={15} className="faint" />
            <Input placeholder="Search messages" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search messages" />
            {q && <button type="button" className="linkbtn" aria-label="Clear search" onClick={() => setQ("")}><X size={14} /></button>}</div>
          {!q && <div className="tabs" role="tablist">
            <button type="button" role="tab" className="tab" aria-selected={tab === "conversations"} onClick={() => setTab("conversations")}>Conversations</button>
            <button type="button" role="tab" className="tab" aria-selected={tab === "threads"} onClick={() => setTab("threads")}>Threads</button>
          </div>}
        </div>
        <div className="list" aria-label={q ? "Search results" : tab === "threads" ? "Threads" : "Conversations"}>
          {q.trim().length >= 2 ? <SearchResults q={q.trim()} />
            : tab === "threads" ? <ThreadsList />
              : list.isLoading ? <ListSkeleton />
                : !list.data?.items.length ? <EmptyState icon={<MessagesSquare size={28} />} title="No conversations yet">Message a person or a team to get started.</EmptyState>
                  : list.data.items.map((c) => <ConvRow key={c.id} c={c} active={c.id === id} />)}
        </div>
      </div>
      <div className="split-detail msg-detail-pane">
        {id ? <Conversation key={id} id={id} /> : <EmptyState icon={<MessageSquare size={28} />} title="Pick a conversation">Or start a new one with a person, a group or your team.</EmptyState>}
      </div>
      {creating && <NewConversation onClose={() => setCreating(false)} />}
    </div>
  );
}

function ConvIcon({ c, size = "md" }: { c: Pick<ConvSummary, "kind" | "other" | "team" | "title" | "picture_url">; size?: "sm" | "md" | "lg" }) {
  if (c.picture_url) return <span className={"avatar " + size}><img src={c.picture_url} alt="" /></span>;
  if (c.kind === "direct" && c.other) return <Avatar name={c.other.name} initials={c.other.initials} src={c.other.avatar_url} size={size} />;
  const icon = c.kind === "team" ? <Users size={16} /> : c.kind === "all" ? <Megaphone size={16} /> : c.kind === "work_order" ? <ClipboardList size={16} /> : <Hash size={16} />;
  return <span className={"avatar msg-conv-ic " + size} style={c.team ? { background: c.team.color } : undefined} aria-hidden>{icon}</span>;
}

function ConvRow({ c, active }: { c: ConvSummary; active: boolean }) {
  const last = c.last_message;
  return (
    <Link to={`/messages/${c.id}`} className={"list-row msg-row" + (active ? " active" : "") + (c.unread ? " unread" : "")}>
      <ConvIcon c={c} />
      <span className="grow">
        <span className="row msg-row-top"><span className="t">{c.title}</span>
          {c.me.pinned && <Pin size={12} className="faint" aria-label="Pinned" />}{c.me.muted && <BellOff size={12} className="faint" aria-label="Muted" />}
          <span className="grow" /><span className="small faint tnum">{last ? timeAgo(last.at) : ""}</span></span>
        <span className="row"><span className="s grow">{last ? (last.author && last.kind === "text" ? `${last.author.split(" ")[0]}: ` : "") + last.text : c.description || "No messages yet"}</span>
          {c.unread > 0 && <span className="msg-badge" aria-label={`${c.unread} unread`}>{c.unread > 99 ? "99+" : c.unread}</span>}</span>
      </span>
    </Link>
  );
}

function ThreadsList() {
  const t = useQuery({ queryKey: ["threads"], queryFn: () => api<{ items: Msg[] }>("/threads") });
  if (t.isLoading) return <ListSkeleton />;
  if (!t.data?.items.length) return <EmptyState icon={<MessagesSquare size={28} />} title="No threads yet">Reply in a thread to keep a side conversation together. Threads you start or reply to show up here.</EmptyState>;
  return <>{t.data.items.map((m) => (
    <Link key={m.id} to={`/messages/${m.conversation_id}?thread=${m.id}`} className={"list-row msg-row" + (m.unread ? " unread" : "")}>
      {m.author ? <Avatar name={m.author.name} initials={m.author.initials} src={m.author.avatar_url} /> : <span className="avatar msg-conv-ic"><Hash size={16} /></span>}
      <span className="grow"><span className="row msg-row-top"><span className="t">{m.conversation_title}</span><span className="grow" /><span className="small faint">{timeAgo(m.last_reply_at)}</span></span>
        <span className="row"><span className="s grow">{plain(m.body)}</span><span className="small faint">{m.reply_count} {m.reply_count === 1 ? "reply" : "replies"}</span>
          {!!m.unread && <span className="msg-badge">{m.unread}</span>}</span></span>
    </Link>))}</>;
}

function plain(body: string): string { return body.replace(/@\[([^\]]{1,200})\]\((?:user|team):[0-9a-fA-F-]{36}\)/g, "@$1"); }

function SearchResults({ q }: { q: string }) {
  const [debounced, setDebounced] = useState(q);
  useEffect(() => { const t = window.setTimeout(() => setDebounced(q), 250); return () => window.clearTimeout(t); }, [q]);
  const r = useQuery({ queryKey: ["msg-search", debounced], queryFn: () => api<{ conversations: ConvSummary[]; messages: Msg[] }>(`/messages/search?q=${encodeURIComponent(debounced)}`) });
  if (r.isLoading) return <ListSkeleton />;
  if (!r.data || (!r.data.conversations.length && !r.data.messages.length)) return <EmptyState icon={<Search size={28} />} title="Nothing found">Try fewer or different words.</EmptyState>;
  return <>
    {r.data.conversations.length > 0 && <div className="msg-sec">Conversations</div>}
    {r.data.conversations.map((c) => <ConvRow key={c.id} c={c} active={false} />)}
    {r.data.messages.length > 0 && <div className="msg-sec">Messages</div>}
    {r.data.messages.map((m) => (
      <Link key={m.id} to={`/messages/${m.conversation_id}?m=${m.id}`} className="list-row msg-row">
        {m.author ? <Avatar name={m.author.name} initials={m.author.initials} src={m.author.avatar_url} /> : <span className="avatar msg-conv-ic"><Hash size={16} /></span>}
        <span className="grow"><span className="row msg-row-top"><span className="t">{m.conversation_title}</span><span className="grow" /><span className="small faint">{timeAgo(m.created_at)}</span></span>
          <span className="s msg-snippet"><Highlight text={plain(m.body)} q={q} /></span></span>
      </Link>))}
  </>;
}

function Highlight({ text, q }: { text: string; q: string }) {
  const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return <>{text}</>;
  const re = new RegExp("(" + terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|") + ")", "gi");
  return <>{text.split(re).map((part, i) => terms.includes(part.toLowerCase()) ? <mark key={i}>{part}</mark> : part)}</>;
}

// ---------------------------------------------------------------- one conversation
function Conversation({ id }: { id: string }) {
  const qc = useQueryClient();
  const nav = useNavigate();
  const { session } = useSession();
  const [params, setParams] = useSearchParams();
  const focusId = params.get("m");
  const threadId = params.get("thread");
  const [info, setInfo] = useState(false);
  const err = useErr();
  const detail = useQuery({ queryKey: ["conversation", id], queryFn: () => api<ConvDetail>(`/conversations/${id}`), retry: false });
  const people = usePeople();
  const msgs = useInfiniteQuery({
    queryKey: ["messages", id, focusId],
    initialPageParam: focusId ? `around=${focusId}` : "",
    queryFn: ({ pageParam }) => api<MsgPage>(`/conversations/${id}/messages?limit=50${pageParam ? "&" + pageParam : ""}`),
    getNextPageParam: (last) => last.has_more_before && last.items.length ? `before=${encodeURIComponent(last.items[0].created_at)}` : undefined,
    enabled: detail.isSuccess,
  });
  const items = useMemo(() => {
    const pages = [...(msgs.data?.pages ?? [])].reverse();
    const seen = new Set<string>();
    return pages.flatMap((p) => p.items).filter((m) => (seen.has(m.id) ? false : (seen.add(m.id), true)));
  }, [msgs.data]);
  const markRead = useRef<number | null>(null);
  const read = () => {
    if (markRead.current !== null || document.hidden) return;
    markRead.current = window.setTimeout(() => {
      markRead.current = null;
      void api(`/conversations/${id}/read`, { method: "POST" }).then(() => { qc.invalidateQueries({ queryKey: ["conversations"] }); qc.invalidateQueries({ queryKey: ["messages-unread"] }); }).catch(() => undefined);
    }, 600);
  };
  useEffect(() => { if (detail.isSuccess) read(); }, [detail.isSuccess, id]); // eslint-disable-line react-hooks/exhaustive-deps
  useLive(`conv:${id}`, (e) => {
    if (e.type === "message.created" || e.type === "message.updated") {
      if (focusId) setParams((p) => { p.delete("m"); return p; }, { replace: true }); // back to the newest messages
      void qc.invalidateQueries({ queryKey: ["messages", id] });
      if (e.data.parent_id) void qc.invalidateQueries({ queryKey: ["thread", id, e.data.parent_id] });
      read();
    }
    if (e.type === "conversation.updated" || e.type === "conversation.read") void qc.invalidateQueries({ queryKey: ["conversation", id] });
    if (e.type === "resync") { void qc.invalidateQueries({ queryKey: ["messages", id] }); void qc.invalidateQueries({ queryKey: ["conversation", id] }); }
  });
  useEffect(() => {
    const onVis = () => { if (!document.hidden) read(); };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }); // eslint-disable-line react-hooks/exhaustive-deps

  if (detail.isError) return <EmptyState title="Conversation not found">It may have been deleted, or you're no longer in it.</EmptyState>;
  if (!detail.data) return <div className="detail"><ListSkeleton rows={4} /></div>;
  const c = detail.data;
  const options = mentionOptions(people.data);
  const memberCount = c.kind === "direct" ? null : c.member_count;
  return (
    <div className={"msg-conv" + (threadId ? " with-thread" : "")}>
      <div className="msg-main">
        <header className="msg-head">
          <Button variant="ghost" icon className="mobile-only" aria-label="All conversations" onClick={() => nav("/messages")}><ArrowLeft size={18} /></Button>
          <ConvIcon c={c} />
          <div className="grow msg-head-t">
            <h2>{c.title}</h2>
            <div className="small faint">{c.kind === "work_order" && c.work_order_id ? <Link to={`/work-orders/${c.work_order_id}`}>Open the work order</Link>
              : memberCount !== null ? `${memberCount} ${memberCount === 1 ? "member" : "members"}${c.description ? " · " + c.description : ""}` : c.other ? "Direct message" : ""}</div>
          </div>
          {c.me.muted && <span className="small faint row" title={c.me.muted_until ? `Until ${dateTime(c.me.muted_until)}` : undefined}><BellOff size={14} />Muted</span>}
          <ConversationMenu c={c} onInfo={() => setInfo(true)} />
        </header>
        <MessageList c={c} items={items} loading={msgs.isLoading} hasOlder={!!msgs.hasNextPage} loadingOlder={msgs.isFetchingNextPage}
          onOlder={() => void msgs.fetchNextPage()} focusId={focusId} me={session.user?.id ?? ""} options={options} onError={err}
          onThread={(mid) => setParams((p) => { p.set("thread", mid); return p; })} />
        {c.can.post ? <Composer c={c} options={options} onSent={() => { if (focusId) setParams((p) => { p.delete("m"); return p; }, { replace: true }); void qc.invalidateQueries({ queryKey: ["messages", id] }); qc.invalidateQueries({ queryKey: ["conversations"] }); }} />
          : <div className="msg-readonly small faint">You can read this conversation but not post in it.</div>}
      </div>
      {threadId && <ThreadPanel c={c} rootId={threadId} options={options} onClose={() => setParams((p) => { p.delete("thread"); return p; })} />}
      {info && <ConversationInfo c={c} onClose={() => setInfo(false)} />}
    </div>
  );
}

function ConversationMenu({ c, onInfo }: { c: ConvDetail; onInfo: () => void }) {
  const qc = useQueryClient();
  const nav = useNavigate();
  const { session } = useSession();
  const { toast } = useToast();
  const err = useErr();
  const me = useMutation({
    mutationFn: (b: Record<string, unknown>) => api(`/conversations/${c.id}/me`, { method: "PATCH", body: b }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["conversation", c.id] }); qc.invalidateQueries({ queryKey: ["conversations"] }); qc.invalidateQueries({ queryKey: ["messages-unread"] }); },
    onError: err,
  });
  const leave = useMutation({
    mutationFn: () => api(`/conversations/${c.id}/members/${session.user!.id}`, { method: "DELETE" }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["conversations"] }); toast("You left the conversation"); nav("/messages"); },
    onError: err,
  });
  return (
    <Dropdown trigger={(_, toggle) => <Button variant="ghost" icon aria-label="Conversation options" onClick={toggle}><MoreHorizontal size={18} /></Button>}>
      {(close) => <>
        <button className="menu-item" onClick={() => { close(); onInfo(); }}><Info size={15} />Details and members</button>
        <button className="menu-item" onClick={() => { close(); me.mutate({ pinned: !c.me.pinned }); }}>{c.me.pinned ? <><PinOff size={15} />Unpin</> : <><Pin size={15} />Pin to the top</>}</button>
        {c.me.muted ? <button className="menu-item" onClick={() => { close(); me.mutate({ mute_hours: 0 }); }}><Bell size={15} />Unmute</button>
          : <>
            <div className="menu-label">Mute</div>
            {[[1, "For 1 hour"], [8, "For 8 hours"], [24, "For 24 hours"], [24 * 365 * 10, "Until I turn it back on"]].map(([h, l]) => (
              <button key={h} className="menu-item" onClick={() => { close(); me.mutate({ mute_hours: h }); }}><BellOff size={15} />{l}</button>))}
          </>}
        <div className="menu-label">Notify me about</div>
        {(["all", "mentions", "none"] as const).map((n) => (
          <button key={n} className="menu-item" onClick={() => { close(); me.mutate({ notify: n }); }}>{c.me.notify === n ? <Check size={15} /> : <span style={{ width: 15 }} />}{NOTIFY_LABEL[n]}</button>))}
        <button className="menu-item" onClick={() => { close(); me.mutate({ follow_all_threads: !c.me.follow_all_threads }); }}>{c.me.follow_all_threads ? <Check size={15} /> : <span style={{ width: 15 }} />}Follow all new threads</button>
        <div className="menu-sep" />
        <button className="menu-item" onClick={() => { close(); me.mutate({ hidden: true }); nav("/messages"); }}><EyeOff size={15} />Hide (comes back with new messages)</button>
        {c.can.leave && <button className="menu-item danger" onClick={() => { close(); leave.mutate(); }}><LogOut size={15} />Leave the group</button>}
      </>}
    </Dropdown>
  );
}

function ConversationInfo({ c, onClose }: { c: ConvDetail; onClose: () => void }) {
  const qc = useQueryClient();
  const err = useErr();
  const { toast } = useToast();
  const { session } = useSession();
  const people = usePeople();
  const [name, setName] = useState(c.name);
  const [desc, setDesc] = useState(c.description);
  const [add, setAdd] = useState<string[]>([]);
  const save = useMutation({
    mutationFn: (b: Record<string, unknown>) => api(`/conversations/${c.id}`, { method: "PATCH", body: b }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["conversation", c.id] }); qc.invalidateQueries({ queryKey: ["conversations"] }); toast("Saved"); },
    onError: err,
  });
  const addM = useMutation({
    mutationFn: () => api(`/conversations/${c.id}/members`, { method: "POST", body: { user_ids: add } }),
    onSuccess: () => { setAdd([]); qc.invalidateQueries({ queryKey: ["conversation", c.id] }); },
    onError: err,
  });
  const rm = useMutation({
    mutationFn: (uid: string) => api(`/conversations/${c.id}/members/${uid}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["conversation", c.id] }),
    onError: err,
  });
  const pic = async (files: File[]) => {
    try { const up = await upload(files[0]); save.mutate({ picture_file_id: up.id }); } catch (e) { err(e); }
  };
  const candidates = (people.data?.people ?? []).filter((p) => !c.members.some((m) => m.id === p.id)).map((p) => ({ key: p.id, label: p.name, sub: p.job_title }));
  return (
    <Modal title="Conversation details" onClose={onClose} width={520}>
      <div className="stack">
        {c.can.edit_details && <Field label="Name">{(fid) => <div className="row"><Input id={fid} value={name} onChange={(e) => setName(e.target.value)} placeholder={c.title} className="grow" />
          <Button disabled={name === c.name || save.isPending} onClick={() => save.mutate({ name })}>Save</Button></div>}</Field>}
        {c.can.edit_description && <Field label="Description">{(fid) => <div className="row"><Input id={fid} value={desc} onChange={(e) => setDesc(e.target.value)} className="grow" />
          <Button disabled={desc === c.description || save.isPending} onClick={() => save.mutate({ description: desc })}>Save</Button></div>}</Field>}
        {c.can.edit_description && <div className="row"><ConvIcon c={c} size="lg" />
          <label className="btn">Change picture<input type="file" accept="image/*" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void pic([f]); e.target.value = ""; }} /></label>
          {c.picture_url && <Button variant="ghost" onClick={() => save.mutate({ picture_file_id: null })}>Remove</Button>}</div>}
        {c.can.hide_for_all && <Toggle checked={c.hidden_for_all} onChange={(v) => save.mutate({ hidden_for_all: v })} label="Hide All Team for everyone"
          hint="Only administrators will see it. Turn it back on any time." />}
        <div>
          <div className="label">Members ({c.member_count})</div>
          {c.can.add_people && <div className="row" style={{ margin: "6px 0" }}>
            <div className="grow"><MultiPicker options={candidates} value={add} onChange={setAdd} placeholder="Add people" label="Add people" /></div>
            <Button variant="primary" disabled={!add.length || addM.isPending} onClick={() => addM.mutate()}><UserPlus size={15} />Add</Button></div>}
          <div className="msg-members">
            {c.members.map((m) => (
              <div key={m.id} className="row msg-member">
                <Avatar name={m.name} initials={m.initials} src={m.avatar_url} size="sm" /><span className="grow">{m.name}</span>
                {c.kind === "group" && m.id !== session.user?.id && <Button size="sm" variant="ghost" onClick={() => rm.mutate(m.id)} aria-label={`Remove ${m.name}`}>Remove</Button>}
              </div>))}
            {c.member_count > c.members.length && <div className="small faint">and {c.member_count - c.members.length} more</div>}
          </div>
        </div>
      </div>
    </Modal>
  );
}

function dayLabel(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  const y = new Date(); y.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return "Today";
  if (d.toDateString() === y.toDateString()) return "Yesterday";
  return d.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric", year: d.getFullYear() === today.getFullYear() ? undefined : "numeric" });
}

function MessageList({ c, items, loading, hasOlder, loadingOlder, onOlder, focusId, me, options, onError, onThread }: {
  c: ConvDetail; items: Msg[]; loading: boolean; hasOlder: boolean; loadingOlder: boolean; onOlder: () => void; focusId: string | null; me: string;
  options: WOOptions | undefined; onError: (e: unknown) => void; onThread: (id: string) => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const lastId = items.length ? items[items.length - 1].id : "";
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    if (focusId) { el.querySelector(`[data-mid="${focusId}"]`)?.scrollIntoView({ block: "center" }); return; }
    if (stick.current) el.scrollTop = el.scrollHeight;
  }, [lastId, focusId]);
  // read receipts: who has read up to the last message (small conversations only)
  const lastMine = [...items].reverse().find((m) => m.mine && !m.deleted);
  const seenBy = lastMine && c.kind !== "all" && c.member_count <= 30
    ? c.members.filter((p) => p.id !== me && p.last_read_at && p.last_read_at >= lastMine.created_at) : [];
  if (loading) return <div className="msg-scroll"><ListSkeleton rows={5} /></div>;
  let prevDay = "";
  let prev: Msg | null = null;
  return (
    <div className="msg-scroll" ref={box} onScroll={(e) => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80; }}
      role="log" aria-live="polite" aria-label={`Messages in ${c.title}`}>
      {hasOlder && <div className="msg-older"><Button size="sm" onClick={onOlder} disabled={loadingOlder}>{loadingOlder ? "Loading…" : "Load earlier messages"}</Button></div>}
      {!items.length && <EmptyState icon={<MessageSquare size={28} />} title="No messages yet">Say hello, share a photo, or @mention someone.</EmptyState>}
      {items.map((m) => {
        const day = new Date(m.created_at).toDateString();
        const sep = day !== prevDay ? <div className="msg-day" key={"d" + m.id}><span>{dayLabel(m.created_at)}</span></div> : null;
        const grouped = !sep && prev && prev.author?.id === m.author?.id && m.kind === "text" && prev.kind === "text"
          && new Date(m.created_at).getTime() - new Date(prev.created_at).getTime() < 5 * 60_000;
        prevDay = day; prev = m;
        return <div key={m.id}>{sep}<MessageItem m={m} c={c} grouped={!!grouped} focused={m.id === focusId} options={options} onError={onError} onThread={onThread} /></div>;
      })}
      {seenBy.length > 0 && <div className="msg-seen small faint" aria-label="Read by">
        <Check size={12} />Seen by {c.kind === "direct" ? "" : seenBy.slice(0, 3).map((p) => p.name.split(" ")[0]).join(", ") + (seenBy.length > 3 ? ` and ${seenBy.length - 3} more` : "")}</div>}
    </div>
  );
}

function MessageItem({ m, c, grouped, focused, options, onError, onThread, inThread }: {
  m: Msg; c: ConvDetail; grouped: boolean; focused: boolean; options: WOOptions | undefined; onError: (e: unknown) => void; onThread?: (id: string) => void; inThread?: boolean;
}) {
  const qc = useQueryClient();
  const nav = useNavigate();
  const { toast } = useToast();
  const { session, can } = useSession();
  const [editing, setEditing] = useState(false);
  const [body, setBody] = useState(m.body);
  const [viewing, setViewing] = useState<string | null>(null);
  const [acks, setAcks] = useState(false);
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["messages", c.id] });
    if (m.parent_id) void qc.invalidateQueries({ queryKey: ["thread", c.id, m.parent_id] });
  };
  const patchCache = (next: Msg) => {
    qc.setQueriesData<InfiniteData<MsgPage>>({ queryKey: ["messages", c.id] }, (d) => d && { ...d, pages: d.pages.map((p) => ({ ...p, items: p.items.map((x) => (x.id === next.id ? next : x)) })) });
  };
  const react = useMutation({ mutationFn: (emoji: string) => api<Msg>(`/messages/${m.id}/reactions`, { method: "POST", body: { emoji } }), onSuccess: (x) => { patchCache(x); refresh(); }, onError });
  const edit = useMutation({ mutationFn: () => api<Msg>(`/messages/${m.id}`, { method: "PATCH", body: { body } }), onSuccess: (x) => { setEditing(false); patchCache(x); refresh(); }, onError });
  const del = useMutation({ mutationFn: () => api(`/messages/${m.id}`, { method: "DELETE" }), onSuccess: refresh, onError });
  const ack = useMutation({ mutationFn: () => api<Msg>(`/messages/${m.id}/ack`, { method: "POST" }), onSuccess: (x) => { patchCache(x); toast("Thanks for confirming"); }, onError });
  const toWo = useMutation({
    mutationFn: () => api<{ id: string; number: number }>(`/messages/${m.id}/work-order`, { method: "POST" }),
    onSuccess: (wo) => { refresh(); toast(`Work order #${wo.number} created`, { action: { label: "Open", run: () => nav(`/work-orders/${wo.id}`) } }); },
    onError,
  });
  const people: Record<string, string> = Object.fromEntries((options?.people ?? []).map((p) => [p.id, p.name]));
  if (m.kind === "system" || m.kind === "work_order") {
    const wo = m.kind === "work_order" ? m.data as { work_order_id?: string; number?: number; title?: string } : null;
    return (
      <div className={"msg-system" + (focused ? " focus" : "")} data-mid={m.id}>
        <span className="small faint">{m.body}</span>
        {wo?.work_order_id && <Link className="msg-wo-card" to={`/work-orders/${wo.work_order_id}`}><ClipboardList size={16} /><span className="grow"><span className="t">#{wo.number} {wo.title}</span><span className="s">Open the work order</span></span></Link>}
      </div>
    );
  }
  const canManage = can("messages.manage");
  return (
    <div className={"msg" + (grouped ? " grouped" : "") + (focused ? " focus" : "") + (m.kind === "announcement" ? " announcement" : "")} data-mid={m.id} tabIndex={-1}>
      <div className="msg-av">{!grouped && m.author && <Avatar name={m.author.name} initials={m.author.initials} src={m.author.avatar_url} size="sm" />}</div>
      <div className="msg-body">
        {!grouped && <div className="msg-meta"><span className="msg-name">{m.author?.name ?? "Someone"}</span>
          <time className="small faint" dateTime={m.created_at} title={dateTime(m.created_at)}>{new Date(m.created_at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}</time>
          {m.kind === "announcement" && <Pill tone="warning"><Megaphone size={12} />Announcement</Pill>}</div>}
        {m.deleted ? <p className="faint small msg-text">Message deleted</p> : editing ? (
          <div className="stack" style={{ gap: 6 }}>
            <MentionBox value={body} onChange={setBody} options={options} autoFocus onSubmit={() => edit.mutate()} />
            <div className="row"><Button size="sm" onClick={() => { setEditing(false); setBody(m.body); }}>Cancel</Button><Button size="sm" variant="primary" disabled={!body.trim() || edit.isPending} onClick={() => edit.mutate()}>Save</Button></div>
          </div>
        ) : <p className="prewrap msg-text"><RichText text={m.body} />{m.edited && <span className="small faint"> (edited)</span>}</p>}
        {m.files.length > 0 && <div className="thumbs sm">{m.files.map((f) => f.is_image
          ? <button type="button" key={f.id} className="thumb" aria-label={`View ${f.name}`} onClick={() => setViewing(f.id)}><img src={f.thumb_url ?? f.url} alt={f.name} /></button>
          : <button type="button" key={f.id} className="chip" onClick={() => setViewing(f.id)}><FileText size={13} />{f.name}</button>)}</div>}
        {m.requires_ack && !m.deleted && <div className="msg-ack row wrap">
          {m.acknowledged ? <span className="small row"><Check size={14} />You confirmed you read this</span>
            : <Button size="sm" variant="primary" onClick={() => ack.mutate()} disabled={ack.isPending}><Check size={14} />I've read this</Button>}
          <span className="small faint">{m.ack_count} confirmed</span>
          {(m.mine || canManage) && <button type="button" className="linkbtn small" onClick={() => setAcks(true)}>See who</button>}
        </div>}
        {Object.keys(m.reactions).length > 0 && <div className="row wrap" style={{ gap: 4, marginTop: 4 }}>{Object.entries(m.reactions).map(([e, who]) => (
          <button key={e} type="button" className={"reaction" + (who.includes(session.user!.id) ? " mine" : "")} title={who.map((u) => people[u] ?? "Someone").join(", ")}
            onClick={() => react.mutate(e)} aria-label={`${e} ${who.length}`}>{e} {who.length}</button>))}</div>}
        {!inThread && m.reply_count > 0 && onThread && <button type="button" className="msg-replies linkbtn small" onClick={() => onThread(m.id)}>
          <MessagesSquare size={13} />{m.reply_count} {m.reply_count === 1 ? "reply" : "replies"}<span className="faint"> · last {timeAgo(m.last_reply_at)}</span></button>}
      </div>
      {!m.deleted && !editing && <div className="msg-actions" role="toolbar" aria-label="Message actions">
        <Dropdown align="right" trigger={(_, toggle) => <button type="button" className="msg-act" aria-label="Add a reaction" onClick={toggle}><Smile size={15} /></button>}>
          {(close) => <div className="msg-emoji">{EMOJI.map((e) => <button key={e} type="button" onClick={() => { close(); react.mutate(e); }} aria-label={`React ${e}`}>{e}</button>)}</div>}
        </Dropdown>
        {!inThread && onThread && <button type="button" className="msg-act" aria-label="Reply in thread" title="Reply in thread" onClick={() => onThread(m.id)}><MessagesSquare size={15} /></button>}
        <Dropdown align="right" trigger={(_, toggle) => <button type="button" className="msg-act" aria-label="More actions" onClick={toggle}><MoreHorizontal size={15} /></button>}>
          {(close) => <>
            <button className="menu-item" onClick={() => { close(); void copyText(absoluteUrl(`/messages/${c.id}?m=${m.id}`)).then(() => toast("Link copied")); }}><Link2 size={15} />Copy link</button>
            {m.body && <button className="menu-item" onClick={() => { close(); void copyText(plain(m.body)).then(() => toast("Text copied")); }}><Copy size={15} />Copy text</button>}
            {c.can.create_work_order && <button className="menu-item" onClick={() => { close(); toWo.mutate(); }}><ClipboardList size={15} />Create a work order</button>}
            {m.mine && <button className="menu-item" onClick={() => { close(); setBody(m.body); setEditing(true); }}><Pencil size={15} />Edit</button>}
            {(m.mine || canManage) && <button className="menu-item danger" onClick={() => { close(); del.mutate(); }}><Trash2 size={15} />Delete</button>}
          </>}
        </Dropdown>
      </div>}
      {viewing && <FileViewer files={m.files} index={Math.max(0, m.files.findIndex((f) => f.id === viewing))} onClose={() => setViewing(null)} />}
      {acks && <AckReport id={m.id} onClose={() => setAcks(false)} />}
    </div>
  );
}

function AckReport({ id, onClose }: { id: string; onClose: () => void }) {
  const r = useQuery({ queryKey: ["acks", id], queryFn: () => api<{ acknowledged: number; total: number; people: { id: string; name: string; initials: string; avatar_url: string | null; acknowledged_at: string | null }[] }>(`/messages/${id}/acks`) });
  const [show, setShow] = useState<"waiting" | "confirmed">("waiting");
  const list = (r.data?.people ?? []).filter((p) => (show === "confirmed") === !!p.acknowledged_at);
  return (
    <Modal title="Who confirmed" onClose={onClose} width={440}>
      {!r.data ? <ListSkeleton rows={3} /> : <>
        <p className="small">{r.data.acknowledged} of {r.data.total} people confirmed they read it.</p>
        <div className="tabs" role="tablist">
          <button type="button" role="tab" className="tab" aria-selected={show === "waiting"} onClick={() => setShow("waiting")}>Not yet ({r.data.total - r.data.acknowledged})</button>
          <button type="button" role="tab" className="tab" aria-selected={show === "confirmed"} onClick={() => setShow("confirmed")}>Confirmed ({r.data.acknowledged})</button>
        </div>
        <div className="msg-members">{list.map((p) => <div key={p.id} className="row msg-member"><Avatar name={p.name} initials={p.initials} src={p.avatar_url} size="sm" /><span className="grow">{p.name}</span>
          {p.acknowledged_at && <span className="small faint">{timeAgo(p.acknowledged_at)}</span>}</div>)}</div>
      </>}
    </Modal>
  );
}

function Composer({ c, options, parentId, onSent }: { c: ConvDetail; options: WOOptions | undefined; parentId?: string; onSent: () => void }) {
  const err = useErr();
  const draftKey = `mpro.msg-draft.${c.id}.${parentId ?? ""}`;
  const [body, setBody] = useState(() => { try { return sessionStorage.getItem(draftKey) ?? ""; } catch { return ""; } });
  const [files, setFiles] = useState<FileItem[]>([]);
  const [busy, setBusy] = useState(0);
  const [announce, setAnnounce] = useState(false);
  useEffect(() => { try { if (body) sessionStorage.setItem(draftKey, body); else sessionStorage.removeItem(draftKey); } catch { /* ignore */ } }, [body, draftKey]);
  const send = useMutation({
    mutationFn: () => api<Msg>(`/conversations/${c.id}/messages`, { method: "POST", body: { body, file_ids: files.map((f) => f.id), parent_id: parentId ?? null, announcement: announce } }),
    onSuccess: () => { setBody(""); setFiles([]); setAnnounce(false); onSent(); },
    onError: err,
  });
  const add = async (fs: File[]) => {
    setBusy((b) => b + fs.length);
    for (const f of fs) { try { const up = await upload(f); setFiles((x) => [...x, up]); } catch (e) { err(e); } finally { setBusy((b) => b - 1); } }
  };
  const ready = (body.trim() || files.length) && !busy && !send.isPending;
  return (
    <DropZone className="msg-composer" label="Drop files to send them" onFiles={(fs) => void add(fs)}>
      {files.length > 0 && <div className="row wrap">{files.map((f) => <span key={f.id} className="chip">{f.is_image && f.thumb_url ? <img src={f.thumb_url} alt="" className="msg-chip-img" /> : <FileText size={13} />}{f.name}
        <button type="button" className="linkbtn" aria-label={`Remove ${f.name}`} onClick={() => setFiles((x) => x.filter((y) => y.id !== f.id))}><X size={12} /></button></span>)}</div>}
      <MentionBox value={body} onChange={setBody} options={options} rows={parentId ? 2 : 1}
        placeholder={parentId ? "Reply in thread…" : `Message ${c.title}…`} onSubmit={() => { if (ready) send.mutate(); }} />
      <div className="row">
        <label className="btn ghost sm icon" aria-label="Attach files" title="Attach files"><Paperclip size={15} />
          <input type="file" multiple hidden onChange={(e) => { void add(Array.from(e.target.files ?? [])); e.target.value = ""; }} /></label>
        {!parentId && c.can.announce && <label className="row small msg-announce" title="Everyone is asked to confirm they read it">
          <input type="checkbox" checked={announce} onChange={(e) => setAnnounce(e.target.checked)} /><Megaphone size={14} />Announcement</label>}
        <span className="small faint grow desktop-only">{busy ? "Uploading…" : "Ctrl + Enter to send · @ to mention"}</span>
        <Button size="sm" variant="primary" disabled={!ready} onClick={() => send.mutate()} aria-label="Send"><Send size={14} /><span className="desktop-only">Send</span></Button>
      </div>
    </DropZone>
  );
}

function ThreadPanel({ c, rootId, options, onClose }: { c: ConvDetail; rootId: string; options: WOOptions | undefined; onClose: () => void }) {
  const qc = useQueryClient();
  const err = useErr();
  const root = useQuery({ queryKey: ["message", rootId], queryFn: () => api<Msg>(`/messages/${rootId}`), retry: false });
  const rid = root.data?.parent_id ?? rootId; // opened from a reply's link: show its thread
  const replies = useQuery({ queryKey: ["thread", c.id, rid], queryFn: () => api<MsgPage>(`/conversations/${c.id}/messages?thread=${rid}&limit=200`), enabled: root.isSuccess });
  const level = useMutation({
    mutationFn: (l: string) => api(`/messages/${rid}/thread`, { method: "PATCH", body: { level: l } }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["message", rootId] }); qc.invalidateQueries({ queryKey: ["threads"] }); },
    onError: err,
  });
  const box = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => { if (box.current) box.current.scrollTop = box.current.scrollHeight; }, [replies.data]);
  useEffect(() => { if (root.isSuccess) void api(`/conversations/${c.id}/read`, { method: "POST", body: { thread_id: rid } }).then(() => qc.invalidateQueries({ queryKey: ["threads"] })).catch(() => undefined); }, [replies.data, root.isSuccess]); // eslint-disable-line react-hooks/exhaustive-deps
  const cur = root.data?.thread_level ?? "all";
  return (
    <aside className="msg-thread" aria-label="Thread">
      <header className="msg-head">
        <Button variant="ghost" icon className="mobile-only" aria-label="Back to the conversation" onClick={onClose}><ArrowLeft size={18} /></Button>
        <div className="grow"><h2>Thread</h2><div className="small faint">{c.title}</div></div>
        <Dropdown trigger={(_, toggle) => <Button variant="ghost" icon aria-label="Thread notifications" onClick={toggle}>{cur === "none" ? <BellOff size={16} /> : <Bell size={16} />}</Button>}>
          {(close) => <>
            <div className="menu-label">Notify me about</div>
            {(["all", "mentions", "none"] as const).map((n) => <button key={n} className="menu-item" onClick={() => { close(); level.mutate(n); }}>{cur === n ? <Check size={15} /> : <span style={{ width: 15 }} />}{n === "all" ? "All replies" : NOTIFY_LABEL[n]}</button>)}
          </>}
        </Dropdown>
        <Button variant="ghost" icon className="desktop-only" aria-label="Close the thread" onClick={onClose}><X size={18} /></Button>
      </header>
      <div className="msg-scroll" ref={box}>
        {root.isError ? <EmptyState title="Thread not found">The message may have been deleted.</EmptyState> : !root.data ? <ListSkeleton rows={3} /> : <>
          <MessageItem m={root.data} c={c} grouped={false} focused={false} options={options} onError={err} inThread />
          <div className="msg-day"><span>{root.data.reply_count} {root.data.reply_count === 1 ? "reply" : "replies"}</span></div>
          {(replies.data?.items ?? []).map((m) => <MessageItem key={m.id} m={m} c={c} grouped={false} focused={false} options={options} onError={err} inThread />)}
        </>}
      </div>
      {c.can.post && root.data && !root.data.deleted && <Composer c={c} options={options} parentId={rid} onSent={() => { qc.invalidateQueries({ queryKey: ["thread", c.id, rid] }); qc.invalidateQueries({ queryKey: ["message", rootId] }); qc.invalidateQueries({ queryKey: ["messages", c.id] }); }} />}
    </aside>
  );
}

function NewConversation({ onClose }: { onClose: () => void }) {
  const nav = useNavigate();
  const qc = useQueryClient();
  const err = useErr();
  const { session } = useSession();
  const people = usePeople();
  const [who, setWho] = useState<string[]>([]);
  const [name, setName] = useState("");
  const [team, setTeam] = useState("");
  const create = useMutation({
    mutationFn: () => team ? api<ConvDetail>(`/teams/${team}/conversation`, { method: "POST" })
      : api<ConvDetail>("/conversations", { method: "POST", body: who.length === 1 && !name.trim() ? { kind: "direct", user_id: who[0] } : { kind: "group", name, user_ids: who } }),
    onSuccess: (c) => { qc.invalidateQueries({ queryKey: ["conversations"] }); onClose(); nav(`/messages/${c.id}`); },
    onError: err,
  });
  const opts = (people.data?.people ?? []).filter((p) => p.id !== session.user?.id).map((p) => ({ key: p.id, label: p.name, sub: p.job_title }));
  return (
    <Modal title="New message" onClose={onClose} width={480}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={(!who.length && !team) || create.isPending} onClick={() => create.mutate()}>Start</Button></>}>
      <div className="stack">
        <Field label="To">{(id) => <MultiPicker id={id} options={opts} value={who} onChange={(v) => { setWho(v); setTeam(""); }} placeholder="Pick one person, or several for a group" label="People" />}</Field>
        {who.length > 1 && <Field label="Group name (optional)">{(id) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Line 2 shutdown crew" />}</Field>}
        {(people.data?.teams.length ?? 0) > 0 && <div><div className="label">Or open a team chat</div>
          <div className="row wrap" style={{ gap: 6, marginTop: 6 }}>{people.data!.teams.map((t) => (
            <button key={t.id} type="button" className={"chip" + (team === t.id ? " on" : "")} aria-pressed={team === t.id} onClick={() => { setTeam(team === t.id ? "" : t.id); setWho([]); }}>
              <span className="sw" style={{ background: t.color }} />{t.name}</button>))}</div></div>}
      </div>
    </Modal>
  );
}

/** "Discuss" on a work order (MP-049): opens the work order's thread in Messages. */
export function WorkOrderThreadButton({ woId, children }: { woId: string; children?: ReactNode }) {
  const nav = useNavigate();
  const { can } = useSession();
  const err = useErr();
  const open = useMutation({ mutationFn: () => api<{ id: string }>(`/work-orders/${woId}/conversation`, { method: "POST" }), onSuccess: (c) => nav(`/messages/${c.id}`), onError: err });
  if (!can("messages.use")) return null;
  return <button type="button" className="menu-item" onClick={() => open.mutate()} disabled={open.isPending}><MessageSquare size={15} />{children ?? "Discuss in Messages"}</button>;
}
