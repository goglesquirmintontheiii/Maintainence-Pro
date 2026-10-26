// Purchase orders (0.5.0, MP-042–044): API shapes and small shared hooks.
import { useQuery } from "@tanstack/react-query";
import { api, type FileItem } from "../../lib/api";

export type POStatus = "requested" | "pending" | "approved" | "rejected" | "partially_fulfilled" | "complete" | "canceled";
export const PO_STATUS: Record<POStatus, string> = {
  requested: "Requested", pending: "Pending approval", approved: "Approved", rejected: "Rejected",
  partially_fulfilled: "Partially fulfilled", complete: "Complete", canceled: "Canceled",
};
export const PO_TONE: Record<POStatus, "neutral" | "info" | "success" | "warning" | "danger"> = {
  requested: "warning", pending: "warning", approved: "info", rejected: "danger", partially_fulfilled: "info", complete: "success", canceled: "neutral",
};

export type Address = {
  id: string; kind: "shipping" | "billing" | "both"; label: string; company: string; attention: string; line1: string; line2: string;
  city: string; region: string; postal_code: string; country: string; phone: string; is_default: boolean; location_id: string | null;
};
export type Budget = {
  id: string; name: string; period: "month" | "quarter" | "year"; starts_on: string; amount: string | null; currency: string; location_id: string | null;
  category: string; approval_limit: string | null; warn_at_pct: number; active: boolean; current_period: { start: string; end: string };
  spent: string | null; used_pct: number;
};
export type Condition = { field: string; op: string; value: unknown };
export type ApprovalRule = { id: string; applies_to: string; name: string; sort: number; conditions: Condition[]; action: "approvers" | "auto_approve";
  approver_user_ids: string[]; approver_team_ids: string[]; active: boolean };

export type PORow = {
  id: string; number: number; display_number: string; custom_number: string; title: string; status: POStatus; status_label: string; overdue: boolean;
  vendor: { id: string; name: string | null } | null; currency: string; due_on: string | null; subtotal: string | null; extra_total: string | null; total: string | null;
  tax_exempt: boolean; source: string; work_order_id: string | null; requested_by_id: string | null; created_at: string; approved_at: string | null;
  completed_at: string | null; sent_at: string | null; version: number;
};
export type POLine = {
  id: string; part: { id: string; name: string; part_number: string } | null; description: string; part_number: string; unit: string; quantity: string;
  unit_cost: string | null; amount: string | null; received: string; location_id: string | null; product_link_id: string | null; taxable: boolean; locked: boolean;
};
export type POCost = { id: string; label: string; kind: "fixed" | "percent"; value: string; is_tax: boolean; taxable: boolean; amount: string | null };
export type Receipt = { id: string; received_at: string; received_by: string | null; note: string; packing_slip: string;
  lines: { line_id: string; quantity: string; unit_cost: string | null; location_id: string | null }[]; total: string | null };
export type BudgetCheck = { budget_id: string; name: string; level: "ok" | "warn" | "over"; spent: string; amount: string; remaining: string; over_limit: boolean };
export type PODetail = PORow & {
  lines: POLine[]; costs: POCost[]; notes: string; custom: Record<string, unknown>; vendor_contact_ids: string[];
  shipping_address: Address | null; billing_address: Address | null; budget: BudgetCheck | null; tax_certificate_id: string | null;
  rejected_reason: string; receipts: Receipt[]; vendor_ack: VendorAck | null; requested_by: string | null; approved_by: string | null;
  approvals: { id: string; status: string; approvers: (string | null)[]; team_ids: string[]; decided_by: string | null; decided_at: string | null; comment: string }[];
  can: { edit: boolean; decide: boolean; receive: boolean; send: boolean; cancel: boolean; delete: boolean; complete: boolean; reopen: boolean; costs: boolean };
  files: FileItem[]; warnings?: string[];
};
export type POList = { items: PORow[]; total: number; page: number; per_page: number; counts?: Record<string, number> };
export type POSettings = { number_prefix: string; default_title: string; default_cc: string[]; single_address: boolean; requests_need_review: boolean; next_number?: number };
export type POOptions = {
  settings: POSettings; statuses: { id: POStatus; label: string }[]; addresses: Address[]; budgets: Budget[];
  can: { request: boolean; manage: boolean; approve: boolean; receive: boolean; delete: boolean; settings: boolean; costs: boolean; export: boolean };
};
export type Suggestion = { vendor_id: string | null; vendor_name: string | null; lines: {
  part_id: string; name: string; part_number: string; vendor_part_number: string; location_id: string | null; location_name: string | null;
  on_hand: string; min_qty: string; max_qty: string | null; ordered: string; quantity: string; unit: string; unit_cost: string | null }[] };
export type { CommentItem as POComment } from "../../lib/api";

export function usePOOptions() {
  return useQuery({ queryKey: ["po-options"], queryFn: () => api<POOptions>("/purchase-orders/options"), staleTime: 60_000 });
}

export function addrLines(a: Partial<Address> | null | undefined): string[] {
  if (!a) return [];
  return [a.company, a.attention && `Attn: ${a.attention}`, a.line1, a.line2, [a.city, a.region, a.postal_code].filter(Boolean).join(" "), a.country].filter(Boolean) as string[];
}

/** "12.5000" → "12.5" for display of quantities. */
export function q(v: string | null | undefined): string {
  if (v === null || v === undefined || v === "") return "—";
  const n = Number(v);
  return Number.isNaN(n) ? v : String(+n.toFixed(4));
}

/** The vendor's answer through the PO email link (r261). */
export type VendorAck = {
  status: "active" | "replaced"; response: "acknowledged" | "proposed_date" | "declined" | null; response_label: string; responder_name: string;
  proposed_date: string | null; note: string; responded_at: string | null; last_viewed_at: string | null; sent_at: string | null; recipients: string[];
};
