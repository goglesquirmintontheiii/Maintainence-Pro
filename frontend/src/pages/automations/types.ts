// Automations (0.4.0, MP-117): types and small helpers shared by the list, detail and builder.
import { useQuery } from "@tanstack/react-query";
import { api } from "../../lib/api";
import type { Meter, Paged } from "../../lib/assets";
import { useSession } from "../../lib/session";

export type TriggerType = "meter_reading" | "asset_status" | "work_order_status";
export type MeterCondition = "above" | "below" | "equal" | "increases_by" | "decreases_by" | "increases_from_last" | "decreases_from_last";
export type AssetStatus = "online" | "offline" | "do_not_track";
export type WOStatus = "open" | "on_hold" | "in_progress" | "done" | "canceled";

export type Trigger =
  | { type: "meter_reading"; condition: MeterCondition; value: string | number; first_at?: string | number }
  | { type: "asset_status"; from: AssetStatus[]; to: AssetStatus[] }
  | { type: "work_order_status"; from: WOStatus[]; to: WOStatus[]; priorities: string[]; categories: string[] };

export type Condition =
  | { type: "asset_status"; in: AssetStatus[] }
  | { type: "weekday"; days: number[] }
  | { type: "time_window"; from: string; to: string };

export type Action =
  | { type: "create_work_order"; rerun_minutes?: number; template_id?: string; title?: string; description?: string; priority?: string;
      assignees?: string[]; categories?: string[]; due_in_days?: number | "" }
  | { type: "change_asset_status"; rerun_minutes?: number; status: AssetStatus; downtime_type?: "" | "planned" | "unplanned"; reason?: string; note?: string }
  | { type: "send_email"; rerun_minutes?: number; recipients: string[]; subject: string; body?: string };

export type Sensitivity = { mode?: "every" | "once" | "n_of_m" | "duration"; n?: number; m?: number; minutes?: number };

export type AutomationDoc = {
  name: string; description: string; active: boolean; trigger: Trigger; targets: string[]; conditions: Condition[]; actions: Action[];
  sensitivity: Sensitivity; rerun_minutes: number;
};

export type Automation = AutomationDoc & {
  id: string; summary: string; run_count: number; fail_count: number; skip_count: number; last_run_at: string | null; created_at: string;
  updated_at: string; legacy: boolean; target_kind: "meter" | "asset"; target_names: string[];
  next_expected?: { target_id: string; value?: number | null; at?: string }[];
};

export type RunResult = { action: Action["type"]; ok: boolean; skipped?: boolean; message: string; work_order_id?: string; work_order_number?: number | null };
export type Run = { id: string; target_id: string; status: "ok" | "failed" | "skipped"; message: string; results: RunResult[]; at: string };

export const TRIGGER_LABEL: Record<TriggerType, string> = {
  meter_reading: "Meter reading", asset_status: "Asset status changes", work_order_status: "Work order status changes",
};
export const COND_LABEL: Record<MeterCondition, string> = {
  above: "Is above", below: "Is below", equal: "Is equal to", increases_by: "Increases by (every…)", decreases_by: "Decreases by (every…)",
  increases_from_last: "Increases from the last reading by", decreases_from_last: "Decreases from the last reading by",
};
export const RECURRING: MeterCondition[] = ["increases_by", "decreases_by"];
export const ASSET_STATUS: Record<AssetStatus, string> = { online: "Online", offline: "Offline", do_not_track: "Do Not Track" };
export const WO_STATUS: Record<WOStatus, string> = { open: "Open", on_hold: "On Hold", in_progress: "In Progress", done: "Done", canceled: "Canceled" };
export const ACTION_LABEL: Record<Action["type"], string> = {
  create_work_order: "Create a work order", change_asset_status: "Change asset status", send_email: "Send an email",
};
export const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/** 90 → "1 hour 30 min"; 0 → "" */
export function minutesText(n: number | undefined | null): string {
  if (!n) return "";
  if (n % 1440 === 0) return `${n / 1440} day${n === 1440 ? "" : "s"}`;
  if (n % 60 === 0) return `${n / 60} hour${n === 60 ? "" : "s"}`;
  if (n > 60) return `${Math.floor(n / 60)} h ${n % 60} min`;
  return `${n} min`;
}

export function emptyDoc(kind: TriggerType = "meter_reading"): AutomationDoc {
  return {
    name: "", description: "", active: true, targets: [], conditions: [], rerun_minutes: 0,
    trigger: kind === "meter_reading" ? { type: kind, condition: "above", value: "" }
      : kind === "asset_status" ? { type: kind, from: [], to: ["offline"] }
      : { type: kind, from: [], to: ["done"], priorities: [], categories: [] },
    sensitivity: kind === "meter_reading" ? { mode: "once" } : {},
    actions: [{ type: "create_work_order", title: "", priority: "medium" }],
  };
}

/** Light meter list for the pickers (≤500). */
export function useMeterList() {
  const { can } = useSession();
  return useQuery({ queryKey: ["meter-pick"], queryFn: () => api<Paged<Meter>>("/meters?per_page=500"), staleTime: 30_000, enabled: can("meters.view") });
}
