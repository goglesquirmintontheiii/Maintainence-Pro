// Finance (0.5.0, MP-090–MP-094): shared types, formatting and the multipart helper.
import { useQuery } from "@tanstack/react-query";
import { api, ApiError, getCsrf, getMaxUpload } from "../../lib/api";
import { currency } from "../../lib/format";

export type Label = { id: string; name: string } | null;
export type Paged<T> = { items: T[]; total: number; page: number; per_page: number };
export type FileLite = { id: string; name: string; content_type: string; url?: string; thumb_url?: string | null; size?: number };

export type FinanceMe = {
  can: Record<"finance.view" | "finance.receipts" | "finance.invoices" | "finance.invoices.approve" | "finance.customer_invoices"
    | "finance.tax_certificates" | "finance.export", boolean>;
  receipts_address: string; invoices_address: string; expense_categories: string[]; currency: string; has_certificates: boolean;
};

export type Receipt = {
  id: string; title: string; source: "camera" | "upload" | "email"; status: "new" | "confirmed" | "matched" | "duplicate";
  file: FileLite | null; vendor: Label; vendor_name: string; purchased_on: string | null; currency: string;
  subtotal: string | null; tax: string | null; total: string | null; card_last4: string; card_id: string | null; region: string;
  work_order_id: string | null; purchase_order_id: string | null; part_id: string | null; expense_category: string;
  tax_flagged: boolean; tax_reclaim_status: "" | "to_reclaim" | "reclaimed" | "waived"; tax_certificate_id: string | null;
  paid_personally: boolean; reimbursement_status: "" | "requested" | "approved" | "rejected" | "exported" | "paid";
  duplicate_of_id: string | null; sender_verified?: boolean; email_from?: string; submitted_by: { id: string; name: string } | null; created_at: string; locked: boolean;
  lines?: { description: string; quantity: string; unit_price: string; amount: string }[];
  extracted?: Record<string, unknown>; reader?: string; pages?: FileLite[];
};

export type InvException = { kind: "price" | "quantity" | "unmatched" | "no_po" | "tax_exempt" | "duplicate"; message: string; line_id?: string };
export type VendorInvoice = {
  id: string; title: string; number: string; vendor: Label; status: "received" | "matched" | "pending" | "approved" | "paid" | "disputed" | "void";
  source: string; sender_verified?: boolean; email_from?: string; invoice_date: string | null; due_date: string | null; terms: string; discount_pct: string | null; discount_until: string | null;
  currency: string; subtotal: string; tax: string; shipping: string; total: string; paid: string; balance: string;
  purchase_orders: { id: string; number: string; status: string; total: string; tax_exempt: boolean }[];
  exceptions: (InvException & { label: string })[]; file: FileLite | null; dispute_note: string; overdue: boolean;
  approved_by: { name: string } | null; locked: boolean; created_at: string;
  lines?: { id: string; description: string; part_number: string; quantity: string; unit_price: string; amount: string;
    match_status: string; po_line: { id: string; description: string; quantity: string; unit_cost: string; received: string } | null }[];
  payments?: Payment[]; approvals?: { id: string; status: string; approver_user_ids: string[]; approver_team_ids: string[];
    decided_by: { name: string } | null; decided_at: string | null; comment: string }[];
};

export type Payment = { id: string; paid_on: string; amount: string; method: string; reference: string; recorded_by: { name: string } | null };

export type CustomerInvoice = {
  id: string; number: number; label: string; kind: "invoice" | "credit_note"; credit_for_id: string | null; customer: Label;
  status: "draft" | "sent" | "partially_paid" | "paid" | "overdue" | "void"; issue_date: string | null; due_date: string | null;
  currency: string; subtotal: string; tax: string; tax_rate_pct: string | null; tax_exempt: boolean; total: string; paid: string;
  balance: string; work_order_ids: string[]; payment_link_url: string; sent_at: string | null; created_at: string;
  notes?: string; lines?: CILine[]; payments?: Payment[]; files?: FileLite[];
  credit_notes?: { id: string; label: string; total: string; status: string }[];
};
export type CILine = { id?: string; kind: "labor" | "part" | "cost" | "other"; description: string; quantity: string; unit_price: string;
  amount?: string; taxable: boolean; work_order_id?: string | null };

export type Certificate = {
  id: string; label: string; type: string; type_label: string; type_name: string; country: string; region: string; multistate_form: string;
  covered_regions: string[]; jurisdiction: string; number: string; legal_entity: string; location_ids: string[];
  issued_on: string | null; expires_on: string | null; days_left: number | null; scope_notes: string; status: "active" | "retired";
  valid: boolean; renewed_from_id: string | null; renewed_by_id?: string | null; customer_id: string | null;
  reminder_user_ids: string[]; card_user_ids: string[]; has_card: boolean; created_at: string;
  files?: (FileLite & { link_id?: string })[]; vendors?: RegistryRow[];
  access_log?: { action: string; user: { name: string } | null; at: string; ip: string }[];
};
export type RegistryRow = { id: string; vendor: Label; status: "not_sent" | "sent" | "on_file" | "rejected"; sent_at: string | null;
  vendor_account_id: string; auto_resend: boolean; sent_to: string };
export type ExemptionCard = { id: string; org_name: string; watermark: string; type: string; jurisdiction: string; number: string;
  legal_entity: string; expires_on: string | null; image: string | null; fetched_at: string };

export type Card = { id: string; name: string; last4: string; holder: { id: string; name: string } | null; active: boolean; unmatched: number };
export type CardTxn = { id: string; card_id: string; posted_on: string; merchant: string; amount: string; currency: string;
  status: "unmatched" | "matched" | "chased" | "ignored"; receipt_id: string | null; chased_at: string | null };

export type FinDoc = { id: string; kind: string; title: string; record_type: string; record_id: string | null; file: FileLite | null;
  vendor: Label; customer: Label; work_order_id: string | null; doc_date: string | null; amount: string | null; currency: string;
  retain_until: string | null; legal_hold: boolean; locked: boolean; created_at: string };

export type FinanceSettings = {
  price_tolerance_pct: string; quantity_tolerance: string; retention_years: number; invoice_prefix: string; invoice_due_days: number;
  invoice_footer: string; labor_rate: string; parts_markup_pct: string; default_tax_rate_pct: string; tax_rates: Record<string, string>;
  reminder_days_after_due: number[]; expense_categories: string[]; duplicate_window_days: number; certificate_reminder_days: number[];
  inbox_enabled: boolean; inbox_host: string; inbox_port: number; inbox_user: string; inbox_password: string; inbox_password_set: boolean; inbox_help?: string;
  inbox_folder: string; inbox_address: string; receipts_address?: string; invoices_address?: string;
  payment_links: { available: boolean; provider: string; reason: string };
};

export const useFinanceMe = () => useQuery({ queryKey: ["finance", "me"], queryFn: () => api<FinanceMe>("/finance/me"), staleTime: 60_000 });

export const money = (v: string | null | undefined, code = "USD") => currency(v ?? null, code || "USD");
export const day = (d: string | null | undefined) => {
  if (!d) return "—";
  const [y, m, dd] = d.slice(0, 10).split("-").map(Number);
  return new Date(y, m - 1, dd).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
};
export const todayISO = () => { const d = new Date(); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); };

export const RECEIPT_STATUS: Record<Receipt["status"], [string, "neutral" | "info" | "success" | "warning" | "danger"]> = {
  new: ["To review", "info"], confirmed: ["Confirmed", "neutral"], matched: ["Matched", "success"], duplicate: ["Possible duplicate", "warning"],
};
export const VI_STATUS: Record<VendorInvoice["status"], [string, "neutral" | "info" | "success" | "warning" | "danger"]> = {
  received: ["Received", "info"], matched: ["Matched", "neutral"], pending: ["Waiting for approval", "warning"], approved: ["Approved", "success"], paid: ["Paid", "success"],
  disputed: ["Disputed", "danger"], void: ["Void", "neutral"],
};
export const CI_STATUS: Record<CustomerInvoice["status"], [string, "neutral" | "info" | "success" | "warning" | "danger"]> = {
  draft: ["Draft", "neutral"], sent: ["Sent", "info"], partially_paid: ["Partially paid", "warning"], paid: ["Paid", "success"],
  overdue: ["Overdue", "danger"], void: ["Void", "neutral"],
};
export const CERT_TYPES: [string, string][] = [["resale", "Resale"], ["exempt_organization", "Exempt organization (e.g. 501(c)(3))"],
  ["government", "Government"], ["manufacturing", "Manufacturing / industrial processing"], ["agricultural", "Agricultural"],
  ["direct_pay", "Direct pay permit"], ["custom", "Other"]];

/** POST multipart/form-data (receipts, invoices, certificate scans, statements). Same CSRF rules as api(). */
export async function postForm<T>(path: string, fields: Record<string, string | Blob | (Blob | File)[] | undefined>): Promise<T> {
  const fd = new FormData();
  const max = getMaxUpload() * 1024 * 1024;
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined) continue;
    for (const one of Array.isArray(v) ? v : [v]) {
      if (one instanceof Blob && one.size > max) throw new ApiError(413, `Files can be up to ${getMaxUpload()} MB.`);
      if (one instanceof File) fd.append(k, one, one.name);
      else if (one instanceof Blob) fd.append(k, one, k === "files" ? "page.jpg" : "file");
      else fd.append(k, one);
    }
  }
  let res: Response;
  try {
    res = await fetch("/api/v1" + path, { method: "POST", body: fd, credentials: "same-origin",
      headers: { "X-CSRF-Token": getCsrf(), Accept: "application/json" } });
  } catch {
    throw new ApiError(0, "Can't reach the MPro server. Check that it's running and your connection is up.");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, (data && data.message) || "Something went wrong. Try again.", data?.detail);
  return data as T;
}
