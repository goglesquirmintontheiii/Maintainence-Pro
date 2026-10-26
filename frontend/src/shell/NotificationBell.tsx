// The bell in the top bar (MP-050): unread count, the latest notifications, mark all read, and a link to the full inbox.
import { useEffect } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bell, CheckCheck, Settings2 } from "lucide-react";
import { api } from "../lib/api";
import { markRead, useUnread, type Notice, type NoticePage } from "../lib/notifications";
import { Button, Dropdown } from "../components/ui";
import { NoticeRow } from "../pages/notifications/Notifications";
import "../pages/notifications/notifications.css";

// Opening a record clears its notifications (the work order, request, purchase order or conversation itself).
const ENTITY_PATHS: [RegExp, string][] = [
  [/^\/work-orders\/([0-9a-f-]{36})/, "work_order"], [/^\/requests\/([0-9a-f-]{36})/, "work_request"],
  [/^\/purchase-orders\/([0-9a-f-]{36})/, "purchase_order"], [/^\/messages\/([0-9a-f-]{36})/, "conversation"],
];

export function NotificationBell() {
  const unread = useUnread().data?.unread ?? 0;
  const loc = useLocation();
  const qc = useQueryClient();
  useEffect(() => {
    if (!unread) return;
    for (const [re, entity_type] of ENTITY_PATHS) {
      const m = re.exec(loc.pathname);
      if (m) {
        void api("/notifications/read-entity", { method: "POST", body: { entity_type, entity_id: m[1] } })
          .then(() => qc.invalidateQueries({ queryKey: ["notifications"] })).catch(() => undefined);
        return;
      }
    }
  }, [loc.pathname, unread > 0]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <Dropdown width={380} className="notif-drop" trigger={(open, toggle) => (
      <Button variant="ghost" icon aria-label={unread ? `Notifications, ${unread} unread` : "Notifications"} aria-expanded={open} onClick={toggle} className="notif-bell">
        <Bell size={18} />{unread > 0 && <span className="badge-count notif-badge" aria-hidden>{unread > 99 ? "99+" : unread}</span>}
      </Button>)}>
      {(close) => <BellPanel close={close} />}
    </Dropdown>
  );
}

function BellPanel({ close }: { close: () => void }) {
  const nav = useNavigate();
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ["notifications", "bell"], queryFn: () => api<NoticePage>("/notifications?limit=8") });
  const all = useMutation({ mutationFn: () => markRead("all"), onSuccess: () => qc.invalidateQueries({ queryKey: ["notifications"] }) });
  const open = (n: Notice) => {
    close();
    if (!n.read_at) void markRead([n.id]).then(() => qc.invalidateQueries({ queryKey: ["notifications"] }));
    nav(n.link || "/notifications");
  };
  const items = list.data?.items ?? [];
  return (
    <div className="notif-panel">
      <div className="notif-panel-head">
        <strong>Notifications</strong>
        <span className="grow" />
        <Button size="sm" variant="ghost" onClick={() => all.mutate()} disabled={!list.data?.unread}><CheckCheck size={15} />Mark all read</Button>
        <Button size="sm" variant="ghost" icon aria-label="Notification settings" title="Notification settings" onClick={() => { close(); nav("/notifications?tab=settings"); }}><Settings2 size={15} /></Button>
      </div>
      <div className="notif-panel-list" role="list">
        {list.isLoading ? <div className="notif-empty small faint">Loading…</div>
          : items.length === 0 ? <div className="notif-empty"><Bell size={22} className="faint" /><div className="small muted">You're all caught up. Assignments, comments and due dates show up here.</div></div>
            : items.map((n) => <NoticeRow key={n.id} n={n} onOpen={() => open(n)} compact />)}
      </div>
      <button type="button" className="notif-panel-foot" onClick={() => { close(); nav("/notifications"); }}>See all notifications</button>
    </div>
  );
}
