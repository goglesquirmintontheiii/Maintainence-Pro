// Counts on navigation items (0.6.0): unread messages today; other modules can add theirs to BADGES.
import { useUnreadMessages } from "../pages/messages/types";
import "../pages/messages/messages.css";

function MessagesBadge() {
  const n = useUnreadMessages();
  return n > 0 ? <span className="nav-badge" aria-label={`${n} unread`}>{n > 99 ? "99+" : n}</span> : null;
}

const BADGES: Record<string, () => JSX.Element | null> = { messages: MessagesBadge };

export function NavBadge({ id }: { id: string }) {
  const B = BADGES[id];
  return B ? <B /> : null;
}
