// Types and hooks for locations, assets, meters and QR codes (0.3.0). Mirrors mpro/assets, mpro/meters and mpro/qr.
import { useQuery } from "@tanstack/react-query";
import { api, getCsrf, type AssetStatus, type CustomFieldDef, type FileItem } from "./api";
import { useSession } from "./session";

export type Crumb = { id: string; name: string };
export type TeamRef = { id: string; name: string; color: string };
export type AssetTypeRef = { id: string; name: string; color: string };

export type Location = {
  id: string; name: string; description: string; parent_id: string | null; address_line1: string; address_line2: string; city: string;
  region: string; postal_code: string; country: string; address: string; latitude: number | null; longitude: number | null;
  custom: Record<string, unknown>; created_at: string; updated_at: string; deleted: boolean;
  path: Crumb[]; child_count: number; asset_count: number; teams: TeamRef[]; open_work_orders: number;
};
export type FloorPlanPin = { id: string; x: number; y: number; label: string; asset_id: string | null; asset_status: AssetStatus | null };
export type FloorPlan = { id: string; name: string; file_id: string; url: string; pins: FloorPlanPin[] };
export type LocationDetail = Location & { files: FileItem[]; floor_plans: FloorPlan[]; maps_url: string | null };

export type Asset = {
  id: string; name: string; status: AssetStatus; status_label: string; status_reason: string; downtime_type: "" | "planned" | "unplanned";
  status_changed_at: string; criticality: "" | "critical" | "important" | "normal"; criticality_label: string; parent_id: string | null;
  location: { id: string; name: string } | null; manufacturer: string; model: string; serial_number: string; year: number | null; barcode: string;
  types: AssetTypeRef[]; warranty_end: string | null; warranty_active: boolean; replacement_year: number | null; disposed: boolean;
  custom: Record<string, unknown>; created_at: string; updated_at: string; deleted: boolean; version: number;
  path: Crumb[]; child_count: number; open_work_orders: number; thumb_url: string | null;
};
export type Downtime = { offline_seconds: number; planned_seconds: number; unplanned_seconds: number; tracked_seconds: number;
  availability: number | null; periods: { from: string; to: string; reason: string; type: string; seconds: number }[] };
export type QrCodeItem = { id: string; kind: "mpro" | "external"; value: string; symbology: string; url: string | null; entity_type: string | null;
  entity_id: string | null; note: string; batch: string; retired: boolean; retired_at: string | null; assigned_at: string | null; created_at: string;
  target?: { label: string; url: string } | null };
export type AssetDetail = Asset & {
  description: string; teams: TeamRef[]; status_changed_by: { id: string; name: string } | null; files: FileItem[];
  lifecycle: { commissioned_on: string | null; expected_life_years: number | null; replacement_year: number | null; disposed_on: string | null;
    disposal_method: string; disposal_notes: string; age_years: number };
  warranty: { start: string | null; end: string | null; provider: string; terms: string; days_left: number | null };
  downtime_30d: Downtime; custom_fields: CustomFieldDef[]; codes: QrCodeItem[];
  financials?: { purchase_price_cents: number | null; purchase_date: string | null; useful_life_years: number | null; salvage_value_cents: number | null;
    depreciation_start: string | null; replacement_cost_cents: number | null; disposal_value_cents: number | null;
    depreciation: { annual_cents: number; accumulated_cents: number; book_value_cents: number; fully_depreciated: boolean;
      schedule: { year: number; starts: string; depreciation_cents: number; book_value_cents: number }[] } | null };
};
export type StatusChange = { id: string; from: string; to: AssetStatus; reason: string; downtime_type: string; note: string; actor: string | null;
  work_order_id: string | null; at: string };
export type Insights = { days: number; weeks: { week: string; created: number; completed: number }[]; created: number; completed: number; open: number;
  downtime: Downtime; costs: { other_cents: number; minutes: number; labor_cents?: number; total_cents?: number } };
export type HistoryItem = { id: string; type: string; summary: string; actor: string; changes: Record<string, [unknown, unknown]>; at: string };
export type PhotoItem = FileItem & { taken_at: string; source: { type: string; work_order?: { id: string; number: number; title: string } } };
export type AssetSettings = { status_reasons: Record<AssetStatus, string[]>; max_depth: number; ask_status_on_work_orders: boolean };
export type AssetOptions = {
  statuses: { id: AssetStatus; label: string; reasons: string[] }[]; criticality: { id: string; label: string }[]; disposal_methods: string[];
  types: AssetTypeRef[]; custom_fields: (CustomFieldDef & { scope_id?: string | null })[]; location_custom_fields: CustomFieldDef[];
  units: Record<string, string[]>; settings: AssetSettings; can: Record<"manage" | "status" | "delete" | "financials" | "settings", boolean>;
};
export type Paged<T> = { items: T[]; total: number; page: number; per_page: number };

export type Meter = {
  id: string; name: string; description: string; meter_type: "manual" | "automated"; unit: string; asset_id: string | null; location_id: string | null;
  monitoring_point_id: string | null; reading_frequency: "none" | "hour" | "day" | "week" | "month" | "year"; frequency_interval: number;
  warning_low: number | null; warning_high: number | null; alarm_low: number | null; alarm_high: number | null; last_value: number | null;
  last_reading_at: string | null; level: "" | "warning" | "alarm"; overdue: boolean; next_reading_due: string | null; created_at: string; updated_at: string;
  deleted: boolean; asset?: { id: string; name: string; status?: AssetStatus } | null; location?: { id: string; name: string } | null;
};
export type MeterTrigger = { id: string; meter_id: string; name: string; kind: "threshold" | "every"; comparator: "gt" | "lt"; threshold: number | null;
  every_units: number | null; next_at: number | null; work_order: Record<string, unknown>; active: boolean; fired_count: number; last_fired_at: string | null;
  last_note: string };
export type MeterDetail = Meter & { monitoring_point: { id: string; name: string } | null; triggers: MeterTrigger[] };
export type Reading = { id: string; value: number; recorded_at: string; source: string; recorded_by: string | null; recorded_by_id: string | null;
  work_order_id: string | null; file_id: string | null; file_url: string | null; note: string; level: "" | "warning" | "alarm"; anomaly: boolean };
export type ChartData = { bucketed: boolean; unit: string; points: { at: string; value: number; min?: number; max?: number; count?: number }[];
  limits: Record<"warning_low" | "warning_high" | "alarm_low" | "alarm_high", number | null> };
export type ScanResult =
  | { status: "found"; entity_type: string; entity_id: string; label: string; url: string; code?: QrCodeItem; matched?: string }
  | { status: "unassigned" | "retired"; code: QrCodeItem }
  | { status: "several"; results: { entity_type: string; entity_id: string; label: string; url: string }[] }
  | { status: "unknown"; value: string };
export type LabelTemplates = { sheets: { id: string; name: string; per_sheet: number; w: number; h: number }[];
  thermal: { id: string; name: string; w: number; h: number; zpl: boolean }[] };

export const ASSET_STATUS_LABEL: Record<AssetStatus, string> = { online: "Online", offline: "Offline", do_not_track: "Do Not Track" };

export function useAssetOptions() {
  const { can } = useSession();
  return useQuery({ queryKey: ["asset-options"], queryFn: () => api<AssetOptions>("/assets/options"), staleTime: 60_000, enabled: can("assets.view") });
}

/** Light lists for pickers (≤500 rows; the pickers search on the server beyond that). */
export function useAssetList(q = "") {
  const { can } = useSession();
  return useQuery({ queryKey: ["asset-pick", q], queryFn: () => api<Paged<Asset>>(`/assets?per_page=500&sort=name${q ? "&q=" + encodeURIComponent(q) : ""}`),
    staleTime: 30_000, enabled: can("assets.view") });
}
export function useLocationList() {
  const { can } = useSession();
  return useQuery({ queryKey: ["location-pick"], queryFn: () => api<Paged<Location>>("/locations?per_page=500"), staleTime: 30_000,
    enabled: can("locations.view") });
}

export function pathLabel(path: Crumb[] | undefined, name: string): string {
  return [...(path ?? []).map((p) => p.name), name].join(" › ");
}

/** Binary download of a POSTed request (labels). Opens PDFs in a new tab; saves ZPL. */
export async function postForFile(path: string, body: unknown, filename: string): Promise<void> {
  const res = await fetch("/api/v1" + path, { method: "POST", credentials: "same-origin",
    headers: { "Content-Type": "application/json", "X-CSRF-Token": getCsrf(), Accept: "application/pdf, text/plain, application/json" }, body: JSON.stringify(body) });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.message || "Couldn't make the labels. Try again.");
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  if (blob.type === "application/pdf") {
    const w = window.open(url, "_blank");
    if (!w) { const a = document.createElement("a"); a.href = url; a.download = filename; a.click(); }
  } else {
    const a = document.createElement("a"); a.href = url; a.download = filename; a.click();
  }
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
