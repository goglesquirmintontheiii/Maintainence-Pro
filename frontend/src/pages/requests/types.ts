// Work requests (0.6.0, MP-047/MP-048): types and small helpers shared by the request screens.
import { useQuery } from "@tanstack/react-query";
import { api, type CustomFieldDef, type FileItem, type Person } from "../../lib/api";
import { useSession } from "../../lib/session";

export type RequestStatus = "pending" | "approved" | "declined" | "done" | "canceled" | "skipped";
export const REQUEST_STATUS: Record<RequestStatus, string> = {
  pending: "Pending", approved: "Approved", declined: "Declined", done: "Done", canceled: "Canceled", skipped: "Skipped",
};
export const REQUEST_TONE: Record<RequestStatus, "neutral" | "info" | "success" | "warning" | "danger"> = {
  pending: "warning", approved: "info", declined: "danger", done: "success", canceled: "neutral", skipped: "neutral",
};
export type FieldState = "optional" | "required" | "hidden";
export type FieldKey = "description" | "priority" | "location" | "asset" | "attachments";
export const FIELD_LABELS: Record<FieldKey, string> = {
  description: "Description", priority: "Priority", location: "Location", asset: "Asset", attachments: "Pictures and files",
};
export type Ref = { id: string; name: string };

export type WorkRequest = {
  id: string; number: number; title: string; description: string; priority: "none" | "low" | "medium" | "high"; status: RequestStatus;
  status_label: string; location: Ref | null; asset: Ref | null; asset_status: string; team: (Ref & { color: string }) | null; route_other: boolean;
  custom: Record<string, unknown>; source: "app" | "portal" | "qr"; work_order: { id: string | null; number: number; status: string } | null;
  decline_reason: string; created_by: Person | null; submitter: { name: string; email: string; phone: string } | null; portal_id: string | null;
  customer_id: string | null; decided_by: Person | null; decided_at: string | null; new: boolean; created_at: string; updated_at: string;
  can_edit: boolean; can_decide: boolean; files: FileItem[];
  comments?: { id: string; body: string; author: Person | null; external_name: string; created_at: string }[];
  customer?: Ref | null; portal?: Ref | null;
};

export type FormConfig = {
  fields: Record<FieldKey, FieldState>; assign_to: FieldState; allow_other: boolean; teams: (Ref & { color: string })[];
  custom_fields: CustomFieldDef[]; guest: boolean;
};

export type Portal = {
  id: string; name: string; slug: string; path: string; intro: string; active: boolean; fields: Record<FieldKey, FieldState>;
  custom_field_ids: string[]; location: Ref | null; asset: Ref | null; team: Ref | null; customer: Ref | null; require_email: boolean;
  created_at: string; request_count?: number;
};

export function useRequestForm() {
  const { can } = useSession();
  return useQuery({ queryKey: ["request-form"], queryFn: () => api<FormConfig>("/requests/form"), staleTime: 60_000, enabled: can("requests.create") });
}

export function useBadge() {
  const { can } = useSession();
  return useQuery({ queryKey: ["requests", "badge"], queryFn: () => api<{ new: number }>("/requests/badge"), staleTime: 30_000,
    refetchInterval: 60_000, enabled: can("requests.approve") });
}
