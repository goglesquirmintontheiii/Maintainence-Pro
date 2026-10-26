// Notifications (0.6.0, MP-050–MP-052): API types and hooks shared by the bell, the inbox and the settings pages.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./api";
import { useLive } from "./live";
import { useSession } from "./session";

export type Notice = {
  id: string; kind: string; category: string; title: string; body: string; link: string; entity_type: string; entity_id: string;
  actor_id: string | null; actor: string; created_at: string; read_at: string | null;
};
export type NoticePage = { items: Notice[]; next: string | null; unread: number };
export type Channel = "in_app" | "email" | "push";
export type Prefs = {
  channels: Record<string, Record<Channel, boolean>>;
  groups: { created_by_me: boolean; assigned_to_me: boolean; my_teams: boolean };
  comments: "all" | "mentions";
  messages: "all" | "direct" | "none";
  email_frequency: "instant" | "hourly" | "daily";
  digest_hour: number;
  quiet: { enabled: boolean; start: string; end: string; weekends: boolean };
};
export type NotifSettings = {
  prefs: Prefs; paused_until: string | null;
  catalogue: { key: string; label: string; category: string; category_label: string }[];
  push: { available: boolean; public_key: string; devices: { id: string; label: string; created_at: string; last_used_at: string | null }[] };
};
export type OrgNotifSettings = {
  due_soon_hours: number; overdue_team_ids: string[]; weekly_report: boolean; weekly_report_user_ids: string[];
  brand_color: string; brand_logo_file_id: string; brand_info: string;
};
export type EscalationRule = {
  id: string; name: string; active: boolean; trigger: "overdue" | "not_started"; after_hours: number; priorities: string[]; category_ids: string[];
  notify_user_ids: string[]; notify_team_ids: string[]; notify_admins: boolean; notify_assignees: boolean; raise_priority: boolean; created_at: string | null;
};

export const UNREAD_KEY = ["notifications", "unread"];

// The unread count for the bell: refetched on focus, every minute, and live when the realtime service pushes "user:<id>".
export function useUnread() {
  const { session } = useSession();
  const qc = useQueryClient();
  const uid = session.user?.id ?? null;
  useLive(uid ? `user:${uid}` : null, (e) => {
    if (e.type.startsWith("notification")) { qc.invalidateQueries({ queryKey: ["notifications"] }); }
  });
  return useQuery({
    queryKey: UNREAD_KEY, enabled: !!session.org,
    queryFn: () => api<{ unread: number }>("/notifications/unread-count"),
    refetchInterval: 60_000, refetchOnWindowFocus: true, staleTime: 15_000,
  });
}

export function markRead(ids: string[] | "all", unread = false) {
  return api<{ updated: number; unread: number }>("/notifications/read", { method: "POST", body: ids === "all" ? { all: true } : { ids, unread } });
}

export const CATEGORY_ORDER = ["work_orders", "requests", "purchasing", "messages"];
