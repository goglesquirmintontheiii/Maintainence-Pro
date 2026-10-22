// Preventive maintenance (0.4.0): API types, hooks and small helpers shared by the PM pages and the work-order inserts.
import { useQuery } from "@tanstack/react-query";
import { api } from "../../lib/api";

export type Freq = "daily" | "weekly" | "monthly" | "yearly" | "every_n_days";
export type Spec = { freq: Freq; interval?: number; weekdays?: number[]; monthly?: "by_date" | "by_weekday"; last?: boolean };
export type ScheduleKind = "time" | "usage" | "time_or_usage";
export type Calendar = { months?: number[]; skip_weekends?: boolean; skip_holidays?: boolean; shift?: "previous" | "next" | "skip" };
export type Defaults = {
  title?: string; description?: string; priority?: string; assignees?: string[]; categories?: string[]; estimated_minutes?: number | null;
  procedure_ids?: string[]; due_in_days?: number; sub_work_orders?: { title: string }[];
};
export type Task = {
  id?: string; name: string; rrule?: string; spec: Spec | Record<string, never>; anchor: string | null; summary?: string;
  meter_id: string | null; every_units: number | null; next_units?: number | null; lead_units: number | null; start_units?: number | null;
  overrides: { priority?: string; estimated_minutes?: number | null; description?: string; assignees?: string[] }; procedure_ids: string[];
  last_completed_at?: string | null;
};
export type Compliance = { on_time: number; late: number; missed: number; skipped: number; open: number; percent: number | null };
export type Plan = {
  id: string; kind: "plan" | "repeat"; name: string; description: string; active: boolean;
  asset: { id: string; name: string; status: string } | null; location: { id: string; name: string } | null;
  schedule_kind: ScheduleKind; interval_mode: "fixed" | "floating"; timezone: string; horizon_days: number; start_offset_days: number;
  defaults: Defaults; calendar: Calendar; frequency: string; next_due_at: string | null; task_count: number; version: number; deleted: boolean; last_problem?: string;
  source_work_order_id: string | null; created_at: string; updated_at: string; tasks?: Task[]; compliance?: Compliance | null;
};
export type OccStatus = "upcoming" | "planned" | "generated" | "skipped" | "completed" | "canceled";
export type Occurrence = {
  key: string; id: string | null; due_at: string | null; original_due_at: string | null; due_units: number | null; status: OccStatus;
  tasks: { id: string; name: string }[]; skip_reason: string; overrides: { assignees?: string[] };
  work_order: { id: string; number: number; status: string; title: string } | null; completed_at: string | null;
  plan?: { id: string; name: string; kind: "plan" | "repeat" };
};
export type Recurrence = {
  plan_id: string; kind: "plan" | "repeat"; name: string; summary: string; active: boolean; interval_mode: "fixed" | "floating";
  spec: Spec | Record<string, never>; horizon_days: number; next_due_at: string | null; next_key: string | null;
};
export type Rollup = {
  own: RollupTotals; total: RollupTotals;
  subs: ({ id: string; number: number; title: string; status: string } & RollupTotals)[];
};
type RollupTotals = { minutes: number; labor_cents: number | null; other_cents: number; total_cents: number | null };
export type Holiday = { id: string; day: string; name: string };
export type ComplianceReport = Compliance & {
  from: string; to: string; plans: ({ id: string; name: string; kind: "plan" | "repeat"; deleted: boolean } & Compliance)[];
};

export const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
export const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export const FREQ_LABEL: Record<Freq, string> = { daily: "Daily", weekly: "Weekly", monthly: "Monthly", yearly: "Yearly", every_n_days: "Every N days" };
export const OCC_LABEL: Record<OccStatus, string> = {
  upcoming: "Upcoming", planned: "Planned", generated: "Created", skipped: "Skipped", completed: "Completed", canceled: "Canceled",
};
export const OCC_TONE: Record<OccStatus, "neutral" | "info" | "success" | "warning" | "danger"> = {
  upcoming: "neutral", planned: "neutral", generated: "info", skipped: "warning", completed: "success", canceled: "danger",
};
const ORD = ["", "1st", "2nd", "3rd", "4th", "last"];

/** Friendly summary of a spec, mirroring mpro/pm/schedule.py describe(). `anchor` decides "on the 15th" / "on the 3rd Thursday". */
export function describe(spec: Partial<Spec> | undefined, anchor?: string | null, floating = false): string {
  if (!spec?.freq) return "";
  const n = Math.max(1, spec.interval || 1);
  const d = anchor ? new Date(anchor) : null;
  let s: string;
  switch (spec.freq) {
    case "daily": s = n === 1 ? "Daily" : `Every ${n} days`; break;
    case "every_n_days": s = `Every ${n} day${n === 1 ? "" : "s"}`; break;
    case "weekly": {
      const days = (spec.weekdays?.length ? spec.weekdays : d ? [(d.getDay() + 6) % 7] : []).slice().sort();
      s = (n === 1 ? "Weekly" : `Every ${n} weeks`) + (days.length ? " on " + days.map((x) => WEEKDAYS[x]).join(", ") : "");
      break;
    }
    case "monthly": {
      s = n === 1 ? "Monthly" : `Every ${n} months`;
      if (d && spec.monthly === "by_weekday") {
        const nth = Math.floor((d.getDate() - 1) / 7) + 1;
        s += ` on the ${ORD[spec.last || nth === 5 ? 5 : nth]} ${d.toLocaleDateString(undefined, { weekday: "long" })}`;
      } else if (d) s += ` on day ${d.getDate()}`;
      break;
    }
    default: s = n === 1 ? "Yearly" : `Every ${n} years`;
  }
  return s + (floating ? " after completion" : "");
}

export function usePlan(id: string | undefined) {
  return useQuery({ queryKey: ["pm-plan", id], queryFn: () => api<Plan>(`/pm/plans/${id}`), enabled: !!id });
}
export function useHolidays(enabled = true) {
  return useQuery({ queryKey: ["pm-holidays"], queryFn: () => api<{ items: Holiday[] }>("/pm/holidays"), enabled, staleTime: 30_000 });
}

export function pctLabel(p: number | null | undefined): string { return p === null || p === undefined ? "—" : `${Math.round(p)}%`; }
export function pctTone(p: number | null | undefined): "" | "success" | "warning" | "danger" {
  if (p === null || p === undefined) return "";
  return p >= 90 ? "success" : p >= 70 ? "warning" : "danger";
}
export const fmtUnits = (n: number | null | undefined) => (n === null || n === undefined ? "—" : n.toLocaleString());
