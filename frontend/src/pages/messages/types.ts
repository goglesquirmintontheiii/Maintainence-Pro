// Messaging types and small hooks shared by the Messages page, the nav badge and Message buttons (0.6.0, MP-049).
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type FileItem } from "../../lib/api";
import { useSession } from "../../lib/session";
import { useLive } from "../../lib/live";

export type UserRef = { id: string; name: string; initials: string; avatar_url: string | null };
export type ConvKind = "direct" | "group" | "team" | "all" | "work_order";
export type ConvSummary = {
  id: string; kind: ConvKind; title: string; name: string; description: string; picture_url: string | null;
  other: UserRef | null; team: { id: string; name: string; color: string } | null; work_order_id: string | null;
  hidden_for_all: boolean; last_message_at: string | null; unread: number;
  last_message: { id: string; text: string; author: string | null; author_id: string | null; at: string; kind: string } | null;
  me: { notify: "all" | "mentions" | "none"; muted: boolean; muted_until: string | null; pinned: boolean; hidden: boolean; follow_all_threads: boolean; last_read_at: string | null };
};
export type ConvDetail = ConvSummary & {
  members: (UserRef & { last_read_at: string | null })[]; member_count: number;
  can: { post: boolean; edit_details: boolean; edit_description: boolean; add_people: boolean; leave: boolean; announce: boolean; hide_for_all: boolean; create_work_order: boolean };
};
export type Msg = {
  id: string; conversation_id: string; parent_id: string | null; kind: "text" | "system" | "work_order" | "announcement";
  author: UserRef | null; mine: boolean; body: string; data: Record<string, unknown>; deleted: boolean; edited: boolean;
  created_at: string; reply_count: number; last_reply_at: string | null; thread_level: "all" | "mentions" | "none" | null;
  reactions: Record<string, string[]>; files: FileItem[]; requires_ack: boolean; acknowledged: boolean; ack_count: number;
  conversation_title?: string; unread?: number;
};
export type MsgPage = { items: Msg[]; has_more_before: boolean; has_more_after: boolean };
export type People = { people: (UserRef & { job_title: string })[]; teams: { id: string; name: string; color: string }[] };

export function usePeople() {
  return useQuery({ queryKey: ["messaging-people"], queryFn: () => api<People>("/messaging/people"), staleTime: 120_000 });
}

/** Unread messages for the nav badge; refreshed live. */
export function useUnreadMessages(): number {
  const { can } = useSession();
  const qc = useQueryClient();
  const enabled = can("messages.use");
  const q = useQuery({ queryKey: ["messages-unread"], queryFn: () => api<{ total: number }>("/messages/unread"), enabled, staleTime: 15_000, refetchInterval: 120_000 });
  useLive(enabled ? "conv:*" : null, () => { void qc.invalidateQueries({ queryKey: ["messages-unread"] }); });
  return q.data?.total ?? 0;
}
