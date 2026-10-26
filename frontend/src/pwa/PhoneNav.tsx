// Bottom tabs on phones (0.6.0, r272/r314): Overview, Work Orders, Requests, Messages and More, like MaintainX.
// A tab the person can't use gives its place to Assets. Tabs are at least 44 px tall (G-18).
import { NavLink } from "react-router-dom";
import { Boxes, ClipboardList, Home, Inbox, MessageSquare, MoreHorizontal, type LucideIcon } from "lucide-react";
import { useSession } from "../lib/session";
import { useOfflineState } from "../lib/offline";
import { NavBadge } from "../shell/NavBadge";

export function PhoneTabs({ onMore }: { onMore: () => void }) {
  const { can } = useSession();
  const { pending } = useOfflineState();
  const tabs: [string, string, LucideIcon, boolean][] = [
    ["/", "Overview", Home, true],
    ["/work-orders", "Work Orders", ClipboardList, can("wo.view")],
    ["/requests", "Requests", Inbox, can("requests.view")],
    ["/messages", "Messages", MessageSquare, can("messages.use")],
    ["/assets", "Assets", Boxes, can("assets.view")],
  ];
  const shown = tabs.filter((t) => t[3]).slice(0, 4);
  return (
    <nav className="bottomnav" aria-label="Quick navigation">
      {shown.map(([p, l, Icon]) => (
        <NavLink key={p} to={p} end={p === "/"} className={({ isActive }) => (isActive ? "active" : "")}>
          <Icon size={20} />{l}{p === "/messages" && <NavBadge id="messages" />}{p === "/work-orders" && pending > 0 && <span className="sr-only"> ({pending} changes waiting to sync)</span>}
        </NavLink>))}
      <button type="button" onClick={onMore}><MoreHorizontal size={20} />More</button>
    </nav>);
}
