// Parts and inventory: API shapes and small helpers (0.5.0, MP-039–041).
import { useQuery } from "@tanstack/react-query";
import { api, type CustomFieldDef, type FileItem } from "../../lib/api";

export type Ref = { id: string; name: string };
export type PartTypeRef = { id: string; name: string; color: string; critical: boolean };
export type PartsSettings = {
  moving_average_cost: boolean; restock_trigger: "in_stock" | "available"; prevent_negative_ordered: boolean; allow_negative_stock: boolean;
  required_fields: string[]; escalation_team_ids: string[]; auto_reserve_days: number; assigned_window_days: number;
};

export type PartRow = {
  id: string; name: string; part_number: string; description: string; unit: string; unit_cost: string | null;
  on_hand: string | null; reserved: string | null; available: string | null; ordered: string | null; min_qty: string | null; max_qty: string | null;
  non_stock: boolean; needs_restock: boolean; out_of_stock: boolean; negative: boolean; critical: boolean; types: PartTypeRef[];
  barcode: string; thumb_url: string | null; deleted: boolean; version: number; updated_at: string; created_at: string;
  locations: number;
};
export type Paged<T> = { items: T[]; total: number; page: number; per_page: number };
export type PerLocationRow = StockRow & { part: { id: string; name: string; part_number: string; unit: string } };
export type PartList = Paged<PartRow> & { per_location?: PerLocationRow[] };

export type StockRow = {
  id: string; location: Ref | null; area: string; on_hand: string; reserved: string; available: string; min_qty: string | null; max_qty: string | null;
  needs_restock: boolean; negative: boolean; restock_quantity: string;
};
export type PartVendorRow = { vendor: { id: string; name: string; color: string }; vendor_part_number: string; unit_cost: string | null; lead_time_days: number | null; preferred: boolean };
export type QrCodeRef = { id: string; kind: string; value: string; symbology: string; url: string | null };
export type PartDetail = PartRow & {
  manufacturer: string; mpn: string; lead_time_days: number | null; custom: Record<string, unknown>; stock: StockRow[]; vendors: PartVendorRow[];
  assets: (Ref & { auto: boolean })[]; teams: { id: string; name: string; color: string }[]; assigned: string | null; order_link: string;
  picture_file_id: string | null; files: FileItem[]; codes: QrCodeRef[]; value: string | null;
  open_work_orders: { id: string; number: number; title: string; status: string; due_at: string | null; quantity: string; part_status: string; part_status_label: string }[];
};

export type Txn = {
  id: string; at: string; kind: string; kind_label: string; direction: "in" | "out" | "none"; quantity: string; before: string | null; after: string | null;
  unit_cost: string | null; note: string; part: { id: string; name: string; part_number: string; unit: string } | null; location: Ref | null;
  user: Ref | null; work_order: { id: string; number: number; title: string } | null; purchase_order_id: string | null;
};

export type Availability = { state: "available" | "partial" | "unavailable" | "issued" | "none"; available: string | null; overcommitted: boolean };
export type WOPartLine = {
  id: string; part: { id: string; name: string; part_number: string; unit: string; non_stock: boolean; deleted: boolean }; location: Ref | null;
  quantity: string; used: string; status: string; status_label: string; unit_cost: string | null; unit_cost_override: string | null;
  line_cost: string | null; note: string; availability: Availability;
};
export type WOParts = { items: WOPartLine[]; total_cost: string | null; costs_visible: boolean };

export type CycleCount = {
  id: string; name: string; location: Ref | null; selection: { all?: boolean; part_ids?: string[]; type_ids?: string[]; area?: string };
  rrule: string; next_at: string | null; active: boolean; assignees: string[];
  last_run?: { id: string; status: string; work_order_id: string | null; created_at: string } | null;
  runs?: { id: string; status: string; work_order_id: string | null; created_at: string; completed_at: string | null }[];
};
export type CountLine = {
  id: string; part: { id: string; name: string; part_number: string; unit: string }; location: Ref | null; area: string;
  expected: string | null; counted: string | null; difference: string | null; note: string; counted_at: string | null;
};
export type CountRun = {
  id: string; cycle_count_id: string; status: string; work_order_id: string | null; due_at: string | null; completed_at: string | null;
  progress: { counted: number; total: number }; lines: CountLine[];
};

export type PartOptions = { types: PartTypeRef[]; units: string[]; settings: PartsSettings; costs_visible: boolean };

export const STATUS_OPTIONS: [string, string][] = [["issued", "Used"], ["assigned", "Planned"], ["reserved", "Reserved"], ["kitted", "Kitted"], ["staged", "Staged"]];
export const KIND_TONE: Record<string, "success" | "danger" | "info" | "neutral" | "warning"> = {
  restock: "success", receive: "success", return: "info", initial: "neutral", use: "danger", adjust: "warning", count: "warning", transfer_in: "info", transfer_out: "info",
};

export function usePartOptions() {
  return useQuery({ queryKey: ["part-options"], queryFn: () => api<PartOptions>("/parts/options"), staleTime: 60_000 });
}
export function usePartFields() {
  return useQuery({ queryKey: ["custom-fields", "part"], queryFn: () => api<{ items: CustomFieldDef[] }>("/custom-fields?entity=part"), staleTime: 60_000 });
}

/** Quantity for display: "12", "2.5", with the unit unless it's "each". */
export function qty(v: string | null | undefined, unit?: string): string {
  if (v === null || v === undefined || v === "") return "—";
  return unit && unit !== "each" ? `${v} ${unit}` : v;
}
export const num = (v: string | null | undefined) => (v === null || v === undefined || v === "" ? 0 : Number(v));
export const qsOf = (o: Record<string, string>) => Object.entries(o).filter(([, v]) => v).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&");
