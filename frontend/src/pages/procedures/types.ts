// Procedures (0.4.0, MP-034–037): shared types, field metadata and the client-side mirror of the schema rules
// (visibility and scoring) used by the builder's live preview and the runner.
import { useQuery } from "@tanstack/react-query";
import { api, type FileItem } from "../../lib/api";
import { useSession } from "../../lib/session";

export type FieldType =
  | "checkbox" | "text" | "number" | "amount" | "multiple_choice" | "checklist" | "inspection" | "yes_no_na"
  | "date" | "file" | "signature" | "meter_reading" | "location_check_in";
export type ItemType = FieldType | "heading" | "section" | "procedure";
export type CondOp = "eq" | "neq" | "in" | "not_in" | "gt" | "lt" | "answered";
export type Condition = { field: string; op: CondOp; value?: unknown };

export type Item = {
  id: string; type: ItemType; label: string; description?: string; link?: string; reference_file_ids?: string[];
  condition?: Condition | null; required?: boolean; assignees?: string[]; options?: string[];
  points?: number | Record<string, number>; unit?: string; min?: number; max?: number; meter_id?: string;
  buffer_m?: number; allow_skip?: boolean; with_time?: boolean;
  items?: Item[]; procedure_id?: string; version_number?: number | null;
};
export type Schema = { items: Item[]; scoring: { enabled: boolean; goal: number | null } };
export type Version = { id: string; number: number; schema: Schema; published_at: string | null; created_at: string; field_count: number;
  changes: { added?: string[]; edited?: string[]; removed?: string[] }; work_order_count?: number };
export type Variant = { name: string; months: number[]; procedure_id: string };
export type ProcStatus = "draft" | "published" | "archived";
export type Procedure = {
  id: string; name: string; description: string; status: ProcStatus; category: string; tags: string[]; variants: Variant[]; one_off: boolean;
  current_version_id: string | null; created_at: string; updated_at: string; deleted: boolean;
  work_order_count?: number; field_count?: number; version?: number; has_unpublished_changes?: boolean;
};
export type ProcedureDetail = Procedure & { draft: Version | null; published: Version | null; has_unpublished_changes: boolean; work_order_count: number; files: FileItem[] };
export type Library = { items: Procedure[]; tags: string[]; categories: string[] };
export type ProcSettings = { on_fail: Policy; on_flag: Policy; on_low_score: Policy; auto_in_progress: boolean };
export type Policy = "prompt" | "auto" | "none";
export type ProcOptions = { field_types: FieldType[]; limits: { fields: number; label: number };
  templates: { key: string; name: string; description: string; category: string; field_count: number }[];
  settings: ProcSettings; can: { manage: boolean; delete: boolean; fill: boolean } };

export type Answer = { value: unknown; result: string; note: string; files: FileItem[]; skipped: boolean; answered_by: string | null; answered_at: string | null };
export type Run = {
  id: string; procedure: { id: string; name: string; one_off: boolean } | null; version: number | null; schema: Schema;
  status: "not_started" | "in_progress" | "done"; score: number | null; goal: number | null;
  progress: { answered: number; total: number; visible: string[]; missing_required: string[] };
  answers: Record<string, Answer>; reference_files: Record<string, FileItem>; completed_at: string | null; sort: number;
};
export type Corrective = { prompt?: { field_id: string | null; label: string; result: string; title: string; score?: number; goal?: number };
  created?: { id: string; number: number; title: string } } | null;

export const FIELD_LABEL: Record<ItemType, string> = {
  checkbox: "Checkbox", text: "Text", number: "Number", amount: "Amount ($)", multiple_choice: "Multiple choice", checklist: "Checklist",
  inspection: "Inspection check", yes_no_na: "Yes, No, N/A", date: "Date", file: "Pictures and files", signature: "Signature",
  meter_reading: "Meter reading", location_check_in: "Location check-in", heading: "Heading", section: "Section", procedure: "Procedure",
};
export const FIELD_HINT: Partial<Record<ItemType, string>> = {
  inspection: "Pass, Flag or Fail", checklist: "Tick several items", multiple_choice: "Pick one option", yes_no_na: "Yes, No or N/A",
  meter_reading: "Records a meter reading", location_check_in: "Confirms the technician is on site", section: "Groups fields; can be conditional",
  procedure: "Insert a library procedure", heading: "A title between fields",
};
export const FIELD_ORDER: ItemType[] = ["checkbox", "text", "number", "amount", "multiple_choice", "checklist", "inspection", "yes_no_na", "date",
  "file", "signature", "meter_reading", "location_check_in", "heading", "section", "procedure"];
export const SCORABLE: ItemType[] = ["checkbox", "multiple_choice", "checklist", "inspection"];
export const COND_SOURCES: ItemType[] = ["checkbox", "multiple_choice", "checklist", "inspection", "yes_no_na", "number", "amount"];
export const OP_LABEL: Record<CondOp, string> = { eq: "is", neq: "is not", in: "is one of", not_in: "is none of", gt: "is more than", lt: "is less than", answered: "is answered" };
export const RESULT_LABEL: Record<string, string> = { pass: "Pass", flag: "Flag", fail: "Fail", yes: "Yes", no: "No", na: "N/A" };
export const POLICY_LABEL: Record<Policy, string> = { prompt: "Ask whether to create one", auto: "Create one automatically", none: "Don't create one (add a comment)" };
export const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export const isField = (t: ItemType): t is FieldType => !["heading", "section", "procedure"].includes(t);
export const newId = () => "f" + Math.random().toString(16).slice(2, 12).padEnd(10, "0");

export function newItem(type: ItemType): Item {
  const base: Item = { id: newId(), type, label: type === "section" ? "New section" : type === "heading" ? "Heading" : type === "procedure" ? "" : "" };
  if (type === "multiple_choice" || type === "checklist") base.options = ["Option 1", "Option 2"];
  if (type === "location_check_in") { base.buffer_m = 10; base.allow_skip = true; }
  if (type === "section") base.items = [];
  return base;
}

/** Depth-first list of items; sections and nested procedures are expanded. */
export function walk(items: Item[], structure = false): Item[] {
  const out: Item[] = [];
  for (const it of items) {
    if (it.type === "section" || it.type === "procedure") { if (structure) out.push(it); out.push(...walk(it.items ?? [], structure)); }
    else if (structure || it.type !== "heading") out.push(it);
  }
  return out;
}
export const fieldsOf = (s: { items: Item[] }) => walk(s.items).filter((i) => isField(i.type));

const empty = (v: unknown) => v === null || v === undefined || v === "" || (Array.isArray(v) && v.length === 0);
export function condOk(c: Condition | null | undefined, answers: Record<string, unknown>): boolean {
  if (!c) return true;
  const v = answers[c.field];
  if (c.op === "answered") return !empty(v);
  if (empty(v)) return c.op === "neq" || c.op === "not_in";
  if (c.op === "gt" || c.op === "lt") { const a = Number(v), b = Number(c.value); if (isNaN(a) || isNaN(b)) return false; return c.op === "gt" ? a > b : a < b; }
  const want = (Array.isArray(c.value) ? c.value : [c.value]).map((x) => String(x).toLowerCase());
  const hit = Array.isArray(v) ? v.some((x) => want.includes(String(x).toLowerCase())) : want.includes(String(v).toLowerCase());
  return c.op === "eq" || c.op === "in" ? hit : !hit;
}
/** Ids of visible items (structure included) given the answers. */
export function visibleIds(items: Item[], answers: Record<string, unknown>): Set<string> {
  const out = new Set<string>();
  const rec = (xs: Item[], shown: boolean) => {
    for (const it of xs) {
      const ok = shown && condOk(it.condition, answers);
      if (ok) out.add(it.id);
      if (it.type === "section" || it.type === "procedure") rec(it.items ?? [], ok);
    }
  };
  rec(items, true);
  return out;
}
export function isAnswered(f: Item, v: unknown, skipped = false): boolean {
  if (skipped) return true;
  if (f.type === "checkbox") return v === true;
  if (v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === 0) return false;
  return !empty(v);
}
export function scoreOf(s: Schema, answers: Record<string, unknown>): number | null {
  if (!s.scoring?.enabled) return null;
  const vis = visibleIds(s.items, answers);
  let earned = 0, possible = 0;
  for (const f of fieldsOf(s)) {
    if (!vis.has(f.id) || !SCORABLE.includes(f.type)) continue;
    const v = answers[f.id];
    const per = typeof f.points === "number" ? f.points : 1;
    if (f.type === "multiple_choice") {
      const table = typeof f.points === "object" && f.points ? f.points : Object.fromEntries((f.options ?? []).map((o, i) => [o, i === 0 ? 1 : 0]));
      possible += Math.max(0, ...Object.values(table)); earned += v ? table[String(v)] ?? 0 : 0;
    } else if (f.type === "checklist") { possible += per * (f.options?.length ?? 0); earned += per * (Array.isArray(v) ? v.length : 0); }
    else if (f.type === "inspection") { possible += per; earned += v === "pass" ? per : v === "flag" ? per / 2 : 0; }
    else { possible += per; earned += v === true ? per : 0; }
  }
  return possible ? Math.round((earned * 10000) / possible) / 100 : null;
}

export function useProcOptions() {
  const { can } = useSession();
  return useQuery({ queryKey: ["proc-options"], queryFn: () => api<ProcOptions>("/procedures/options"), staleTime: 60_000, enabled: can("procedures.view") });
}
export function useLibrary(published = false) {
  const { can } = useSession();
  return useQuery({ queryKey: ["procedures", "pick", published], queryFn: () => api<Library>(`/procedures${published ? "?status=published" : ""}`),
    staleTime: 15_000, enabled: can("procedures.view") });
}

/** Remove one item (anywhere in the tree) / replace one / insert relative to one. Pure helpers for the builder. */
export function mapItems(items: Item[], fn: (it: Item) => Item | null): Item[] {
  const out: Item[] = [];
  for (const it of items) {
    const r = fn(it);
    if (!r) continue;
    out.push(r.items && (r.type === "section") ? { ...r, items: mapItems(r.items, fn) } : r);
  }
  return out;
}
export function findItem(items: Item[], id: string): Item | undefined {
  return walk(items, true).find((i) => i.id === id);
}
/** Fields that come before `id` (in order) — the only ones a condition may use. */
export function fieldsBefore(items: Item[], id: string): Item[] {
  const all = walk(items, true);
  const i = all.findIndex((x) => x.id === id);
  return all.slice(0, i < 0 ? all.length : i).filter((x) => COND_SOURCES.includes(x.type));
}
