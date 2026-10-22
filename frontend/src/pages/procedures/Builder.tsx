// Procedure builder (MP-034/035, r180–r185, r203): drag-and-drop items, every field type, sections and nested
// procedures, conditional logic, scoring with a goal, assignment, links and reference files, seasonal variants (r598),
// and a live preview. Saving writes the draft; publishing makes a new version (work orders keep the one they used).
import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowDown, ArrowLeft, ArrowUp, Calendar, Camera, CheckSquare, ChevronDown, ClipboardCheck, Copy, DollarSign, Eye, FileText,
  Flag, Gauge, GitMerge, GripVertical, Hash, Heading, Layers, ListChecks, ListOrdered, MapPin, PenLine, Plus, Trash2, Type, Upload, X, CircleDot,
} from "lucide-react";
import { api, ApiError, upload, type FileItem } from "../../lib/api";
import { useWOOptions } from "../../lib/wo";
import { useToast } from "../../components/Toast";
import { AssigneePicker } from "../../components/pickers";
import { Button, Dropdown, Field, Input, ListSkeleton, Modal, Pill, Select, Toggle } from "../../components/ui";
import { useMeterList } from "../automations/types";
import { PreviewForm } from "./Runner";
import {
  FIELD_HINT, FIELD_LABEL, FIELD_ORDER, MONTHS, COND_SOURCES, SCORABLE, fieldsBefore, fieldsOf, findItem, isField, newId, newItem, useLibrary,
  type Condition, type Item, type ItemType, type ProcedureDetail, type Schema, type Variant,
} from "./types";
import "../../styles/procedures.css";

export const FIELD_ICON: Record<ItemType, typeof Type> = {
  checkbox: CheckSquare, text: Type, number: Hash, amount: DollarSign, multiple_choice: CircleDot, checklist: ListChecks, inspection: Flag,
  yes_no_na: ListOrdered, date: Calendar, file: Camera, signature: PenLine, meter_reading: Gauge, location_check_in: MapPin, heading: Heading,
  section: Layers, procedure: ClipboardCheck,
};

type Ctx = { root: Item[]; scoring: boolean; files: Record<string, FileItem>; addFile: (f: FileItem) => void; selfId?: string; compact?: boolean };
const BuilderCtx = createContext<Ctx>({ root: [], scoring: false, files: {}, addFile: () => {} });

// ---- tree helpers --------------------------------------------------------------------------------
function take(items: Item[], id: string): [Item[], Item | null] {
  let found: Item | null = null;
  const rec = (xs: Item[]): Item[] => xs.flatMap((it) => {
    if (it.id === id) { found = it; return []; }
    return it.type === "section" ? [{ ...it, items: rec(it.items ?? []) }] : [it];
  });
  return [rec(items), found];
}
function put(items: Item[], targetId: string | null, pos: "before" | "after" | "inside", node: Item): Item[] {
  if (targetId === null) return [...items, node];
  const rec = (xs: Item[]): Item[] => xs.flatMap((it) => {
    if (it.id === targetId) {
      if (pos === "inside") return [{ ...it, items: [...(it.items ?? []), node] }];
      return pos === "before" ? [node, it] : [it, node];
    }
    return it.type === "section" ? [{ ...it, items: rec(it.items ?? []) }] : [it];
  });
  return rec(items);
}
function parentOf(items: Item[], id: string): Item | null {
  for (const it of items) {
    if (it.type === "section") { if ((it.items ?? []).some((k) => k.id === id)) return it; const p = parentOf(it.items ?? [], id); if (p) return p; }
  }
  return null;
}
function update(items: Item[], id: string, patch: Partial<Item>): Item[] {
  return items.map((it) => it.id === id ? { ...it, ...patch } : it.type === "section" ? { ...it, items: update(it.items ?? [], id, patch) } : it);
}
function reId(it: Item, used: Set<string>): Item {
  let id = it.id;
  while (used.has(id)) id = newId();
  used.add(id);
  return { ...it, id, condition: null, items: it.items?.map((k) => reId(k, used)) };
}

// ---- items editor (also used for one-off procedures on a work order) --------------------------------
export function ItemsEditor({ items, onChange, scoring, compact, files, addFile, selfId }: {
  items: Item[]; onChange: (v: Item[]) => void; scoring: boolean; compact?: boolean; files?: Record<string, FileItem>; addFile?: (f: FileItem) => void; selfId?: string;
}) {
  const [sel, setSel] = useState<string | null>(null);
  const [localFiles, setLocalFiles] = useState<Record<string, FileItem>>({});
  const drag = useRef<string | null>(null);
  const [over, setOver] = useState<{ id: string; pos: "before" | "after" | "inside" } | null>(null);
  const { toast } = useToast();
  const ctx: Ctx = { root: items, scoring, files: files ?? localFiles, addFile: addFile ?? ((f) => setLocalFiles((x) => ({ ...x, [f.id]: f }))), selfId, compact };

  const add = (type: ItemType, into?: string) => {
    const node = newItem(type);
    const target = into ?? sel;
    const tItem = target ? findItem(items, target) : undefined;
    let next: Item[];
    if (tItem && tItem.type === "section" && type !== "section") next = put(items, tItem.id, "inside", node);
    else if (tItem && !(type === "section" && parentOf(items, tItem.id))) next = put(items, tItem.id, "after", node);
    else if (tItem && type === "section") next = put(items, parentOf(items, tItem.id)!.id, "after", node);
    else next = [...items, node];
    onChange(next);
    setSel(node.id);
    setTimeout(() => document.getElementById(`pb-${node.id}`)?.scrollIntoView({ block: "nearest", behavior: "smooth" }), 30);
  };
  const move = (id: string, target: string, pos: "before" | "after" | "inside") => {
    if (id === target) return;
    const [rest, node] = take(items, id);
    if (!node) return;
    const tParent = pos === "inside" ? findItem(rest, target) : parentOf(rest, target);
    if (node.type === "section" && tParent) { toast("Sections can't go inside other sections.", { kind: "error" }); return; }
    if (!findItem(rest, target)) return; // dropped onto its own child
    onChange(put(rest, target, pos, node));
  };
  const step = (id: string, dir: -1 | 1) => {
    const parent = parentOf(items, id);
    const sibs = parent ? parent.items ?? [] : items;
    const i = sibs.findIndex((x) => x.id === id);
    const j = i + dir;
    if (j < 0 || j >= sibs.length) {
      // step out of a section
      if (parent) move(id, parent.id, dir < 0 ? "before" : "after");
      return;
    }
    const other = sibs[j];
    const node = findItem(items, id)!;
    if (other.type === "section" && node.type !== "section") move(id, other.id, dir > 0 && (other.items ?? []).length === 0 ? "inside" : dir < 0 ? "inside" : "before");
    else move(id, other.id, dir < 0 ? "before" : "after");
  };
  const dnd = {
    start: (id: string) => { drag.current = id; },
    over: (e: React.DragEvent, it: Item) => {
      if (!drag.current || drag.current === it.id) return;
      e.preventDefault(); e.stopPropagation();
      const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
      const y = (e.clientY - r.top) / r.height;
      const pos = it.type === "section" && y > 0.3 && y < 0.7 ? "inside" : y < 0.5 ? "before" : "after";
      if (over?.id !== it.id || over.pos !== pos) setOver({ id: it.id, pos });
    },
    drop: (e: React.DragEvent) => { e.preventDefault(); e.stopPropagation(); if (drag.current && over) move(drag.current, over.id, over.pos); drag.current = null; setOver(null); },
    end: () => { drag.current = null; setOver(null); },
  };
  const count = fieldsOf({ items }).length;
  return (
    <BuilderCtx.Provider value={ctx}>
      <div className={"pb-items" + (compact ? " compact" : "")}>
        {items.length === 0 && <div className="pb-empty">Add the first field. Drag fields to reorder them, and group them in sections.</div>}
        {items.map((it) => <ItemCard key={it.id} it={it} sel={sel} setSel={setSel} over={over} dnd={dnd}
          onPatch={(id, p) => onChange(update(items, id, p))} onRemove={(id) => { onChange(take(items, id)[0]); if (sel === id) setSel(null); }}
          onDuplicate={(id) => { const n = findItem(items, id); if (!n) return; const used = new Set(fieldsOf({ items }).map((f) => f.id)); const copy = reId({ ...n, condition: n.condition }, used); onChange(put(items, id, "after", { ...copy, label: n.label ? `${n.label} (copy)`.slice(0, 512) : n.label })); setSel(copy.id); }}
          onStep={step} onAdd={add} onReplace={(id, nodes) => { let next = items; for (const n of [...nodes].reverse()) next = put(next, id, "after", n); onChange(take(next, id)[0]); }} />)}
        <div className="row wrap pb-add-row">
          <AddMenu onAdd={(t) => add(t)} label={sel ? "Add field below" : "Add field"} />
          <span className="small faint">{count} / 350 fields</span>
        </div>
      </div>
    </BuilderCtx.Provider>);
}

function AddMenu({ onAdd, label, inSection }: { onAdd: (t: ItemType) => void; label: string; inSection?: boolean }) {
  return (
    <Dropdown align="left" width={280} trigger={(_, t) => <Button size="sm" onClick={t}><Plus size={15} />{label}</Button>}>
      {(close) => <div className="pb-add-menu">{FIELD_ORDER.filter((t) => !(inSection && t === "section")).map((t) => {
        const Icon = FIELD_ICON[t];
        return <button key={t} type="button" className="menu-item" onClick={() => { close(); onAdd(t); }}>
          <Icon size={15} /><span className="grow"><span>{FIELD_LABEL[t]}</span>{FIELD_HINT[t] && <span className="small faint" style={{ display: "block" }}>{FIELD_HINT[t]}</span>}</span></button>;
      })}</div>}
    </Dropdown>);
}

type CardProps = {
  it: Item; sel: string | null; setSel: (id: string | null) => void; over: { id: string; pos: string } | null;
  dnd: { start: (id: string) => void; over: (e: React.DragEvent, it: Item) => void; drop: (e: React.DragEvent) => void; end: () => void };
  onPatch: (id: string, p: Partial<Item>) => void; onRemove: (id: string) => void; onDuplicate: (id: string) => void; onStep: (id: string, d: -1 | 1) => void;
  onAdd: (t: ItemType, into?: string) => void; onReplace: (id: string, nodes: Item[]) => void;
};

function ItemCard(props: CardProps) {
  const { it, sel, setSel, over, dnd, onRemove, onDuplicate, onStep, onAdd } = props;
  const Icon = FIELD_ICON[it.type];
  const open = sel === it.id;
  const [handle, setHandle] = useState(false);
  const badges: string[] = [];
  if (it.required) badges.push("Required");
  if (it.condition) badges.push("Conditional");
  if (it.assignees?.length) badges.push("Assigned");
  const hint = over?.id === it.id ? " drop-" + over.pos : "";
  const head = (
    <div className="pb-card-head" onClick={() => setSel(open ? null : it.id)}>
      <span className="pb-grip" aria-hidden="true" onMouseDown={() => setHandle(true)} onMouseUp={() => setHandle(false)} onTouchStart={() => setHandle(true)}><GripVertical size={16} /></span>
      <span className="pb-ic"><Icon size={15} /></span>
      <div className="grow" style={{ minWidth: 0 }}>
        <div className={"pb-card-label" + (it.label ? "" : " faint")}>{it.label || (it.type === "procedure" ? "Pick a procedure" : `Untitled ${FIELD_LABEL[it.type].toLowerCase()}`)}</div>
        <div className="small faint">{FIELD_LABEL[it.type]}{badges.length ? " · " + badges.join(" · ") : ""}</div>
      </div>
      <span className="pb-card-actions" onClick={(e) => e.stopPropagation()}>
        <Button variant="ghost" icon size="sm" aria-label={`Move ${it.label || "item"} up`} onClick={() => onStep(it.id, -1)}><ArrowUp size={14} /></Button>
        <Button variant="ghost" icon size="sm" aria-label={`Move ${it.label || "item"} down`} onClick={() => onStep(it.id, 1)}><ArrowDown size={14} /></Button>
        <Button variant="ghost" icon size="sm" className="pb-act-more" aria-label={`Duplicate ${it.label || "item"}`} onClick={() => onDuplicate(it.id)}><Copy size={14} /></Button>
        <Button variant="ghost" icon size="sm" className="pb-act-more" aria-label={`Delete ${it.label || "item"}`} onClick={() => onRemove(it.id)}><Trash2 size={14} /></Button>
      </span>
    </div>);
  return (
    <div id={`pb-${it.id}`} className={"pb-card" + (open ? " open" : "") + (it.type === "section" ? " section" : "") + (it.type === "heading" ? " heading" : "") + hint}
      draggable={handle} onDragStart={(e) => { e.stopPropagation(); e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", it.id); dnd.start(it.id); }}
      onDragEnd={() => { setHandle(false); dnd.end(); }} onDragOver={(e) => dnd.over(e, it)} onDrop={dnd.drop}>
      {head}
      {open && <div className="pb-card-body" onClick={(e) => e.stopPropagation()}><ItemEditor {...props} /></div>}
      {it.type === "section" && (
        <div className="pb-section-items">
          {(it.items ?? []).map((k) => <ItemCard {...props} key={k.id} it={k} />)}
          {(it.items ?? []).length === 0 && <div className="pb-empty small">Drag fields here or add one.</div>}
          <div><AddMenu inSection label="Add to section" onAdd={(t) => onAdd(t, it.id)} /></div>
        </div>)}
    </div>);
}

function ItemEditor({ it, onPatch, onReplace }: CardProps) {
  const ctx = useContext(BuilderCtx);
  const opts = useWOOptions();
  const set = (p: Partial<Item>) => onPatch(it.id, p);
  const field = isField(it.type);
  return (
    <div className="pb-editor">
      {it.type === "procedure" ? <NestedPicker it={it} onPatch={set} onReplace={(nodes) => onReplace(it.id, nodes)} /> : (
        <Field label={it.type === "section" ? "Section name" : it.type === "heading" ? "Heading" : "Field name"}>
          {(id) => <Input id={id} value={it.label} maxLength={512} autoFocus onChange={(e) => set({ label: e.target.value })} placeholder={it.type === "checkbox" ? "e.g. Lockout applied" : "Name this field"} />}
        </Field>)}
      {field && <Field label="Description" hint="Shown under the field name">{(id) => <textarea id={id} className="textarea" rows={2} value={it.description ?? ""} maxLength={4000} onChange={(e) => set({ description: e.target.value })} />}</Field>}
      {(it.type === "multiple_choice" || it.type === "checklist") && <OptionsEditor it={it} onPatch={set} scoring={ctx.scoring} />}
      {(it.type === "number" || it.type === "amount") && (
        <div className="pb-grid3">
          <Field label="Unit">{(id) => <Input id={id} value={it.unit ?? ""} maxLength={30} placeholder={it.type === "amount" ? "$" : "e.g. psi"} onChange={(e) => set({ unit: e.target.value })} />}</Field>
          <Field label="Lowest allowed">{(id) => <Input id={id} type="number" step="any" value={it.min ?? ""} onChange={(e) => set({ min: e.target.value === "" ? undefined : Number(e.target.value) })} />}</Field>
          <Field label="Highest allowed">{(id) => <Input id={id} type="number" step="any" value={it.max ?? ""} onChange={(e) => set({ max: e.target.value === "" ? undefined : Number(e.target.value) })} />}</Field>
        </div>)}
      {it.type === "meter_reading" && <MeterField it={it} onPatch={set} />}
      {it.type === "location_check_in" && (
        <div className="stack" style={{ gap: 8 }}>
          <Field label="Allowed distance (metres)" hint="How close the technician must be to the work order's location (or its asset's)">
            {(id) => <Input id={id} type="number" min={1} max={5000} value={it.buffer_m ?? 10} onChange={(e) => set({ buffer_m: e.target.value === "" ? undefined : Number(e.target.value) })} style={{ maxWidth: 140 }} />}</Field>
          <Toggle checked={it.allow_skip !== false} onChange={(v) => set({ allow_skip: v })} label="Allow skipping" hint="Skips are recorded with the reason" />
        </div>)}
      {it.type === "date" && <Toggle checked={!!it.with_time} onChange={(v) => set({ with_time: v || undefined })} label="Include time" />}
      {field && ctx.scoring && SCORABLE.includes(it.type) && it.type !== "multiple_choice" && (
        <Field label={it.type === "checklist" ? "Points per item" : "Points"} hint={it.type === "inspection" ? "Pass earns all points, Flag half" : undefined}>
          {(id) => <Input id={id} type="number" min={0} max={100} value={typeof it.points === "number" ? it.points : 1} style={{ maxWidth: 100 }}
            onChange={(e) => set({ points: e.target.value === "" ? undefined : Math.max(0, Math.min(100, Math.round(Number(e.target.value)))) })} />}</Field>)}
      {field && <div className="pb-toggles">
        <Toggle checked={!!it.required} onChange={(v) => set({ required: v || undefined })} label="Required" hint="Must be answered before the work order is Done" />
      </div>}
      {it.type !== "heading" && <ConditionEditor it={it} onPatch={set} />}
      {field && !ctx.compact && <Field label="Assigned to" hint="Only these people (or team members) can answer it, and the work order can't be completed until they do">
        {(id) => <AssigneePicker id={id} options={opts.data} value={it.assignees ?? []} onChange={(v) => set({ assignees: v.length ? v : undefined })} />}</Field>}
      {field && <Field label="Link" hint="A web page with instructions, e.g. the manufacturer's manual">
        {(id) => <Input id={id} type="url" value={it.link ?? ""} placeholder="https://" maxLength={2000} onChange={(e) => set({ link: e.target.value || undefined })} />}</Field>}
      {field && !ctx.compact && <RefFiles it={it} onPatch={set} />}
    </div>);
}

function OptionsEditor({ it, onPatch, scoring }: { it: Item; onPatch: (p: Partial<Item>) => void; scoring: boolean }) {
  const opts = it.options ?? [];
  const pts = typeof it.points === "object" && it.points ? it.points : {};
  const perOption = scoring && it.type === "multiple_choice";
  const setOpt = (i: number, v: string) => {
    const next = opts.map((o, j) => j === i ? v : o);
    const p = perOption ? Object.fromEntries(Object.entries(pts).map(([k, n]) => [k === opts[i] ? v : k, n])) : undefined;
    onPatch(p ? { options: next, points: p } : { options: next });
  };
  return (
    <fieldset className="pb-options">
      <legend className="small">Options{perOption && <span className="faint"> · points</span>}</legend>
      {opts.map((o, i) => (
        <div key={i} className="row" style={{ gap: 6 }}>
          <Input value={o} aria-label={`Option ${i + 1}`} maxLength={512} onChange={(e) => setOpt(i, e.target.value)} />
          {perOption && <Input type="number" min={0} max={100} aria-label={`Points for ${o}`} style={{ width: 76 }} value={pts[o] ?? (i === 0 ? 1 : 0)}
            onChange={(e) => onPatch({ points: { ...Object.fromEntries(opts.map((x, j) => [x, pts[x] ?? (j === 0 ? 1 : 0)])), [o]: Math.max(0, Math.min(100, Math.round(Number(e.target.value) || 0))) } })} />}
          <Button variant="ghost" icon size="sm" aria-label={`Remove ${o || "option"}`} disabled={opts.length <= 1} onClick={() => onPatch({ options: opts.filter((_, j) => j !== i) })}><X size={14} /></Button>
        </div>))}
      <div><button type="button" className="linkbtn small" onClick={() => onPatch({ options: [...opts, `Option ${opts.length + 1}`] })} disabled={opts.length >= 100}><Plus size={13} />Add option</button></div>
    </fieldset>);
}

function MeterField({ it, onPatch }: { it: Item; onPatch: (p: Partial<Item>) => void }) {
  const meters = useMeterList();
  return <Field label="Meter" hint="The reading is saved on the meter, and alarm or warning readings mark the step Fail or Flag">
    {(id) => <Select id={id} value={it.meter_id ?? ""} onChange={(e) => onPatch({ meter_id: e.target.value || undefined })}>
      <option value="">Pick a meter</option>
      {(meters.data?.items ?? []).map((m) => <option key={m.id} value={m.id}>{m.name}{m.asset ? ` — ${m.asset.name}` : ""}</option>)}</Select>}</Field>;
}

function RefFiles({ it, onPatch }: { it: Item; onPatch: (p: Partial<Item>) => void }) {
  const { files, addFile } = useContext(BuilderCtx);
  const ref = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const { toast } = useToast();
  const ids = it.reference_file_ids ?? [];
  return (
    <div className="field">
      <label>Reference files</label>
      <div className="row wrap" style={{ gap: 6 }}>
        {ids.map((id) => <span key={id} className="chip"><FileText size={12} />{files[id]?.name ?? "File"}
          <button type="button" className="chip-x" aria-label={`Remove ${files[id]?.name ?? "file"}`} onClick={() => onPatch({ reference_file_ids: ids.filter((x) => x !== id) })}><X size={11} /></button></span>)}
        <input ref={ref} type="file" hidden onChange={async (e) => {
          const f = e.target.files?.[0]; e.target.value = ""; if (!f) return;
          setBusy(true);
          try { const up = await upload(f); addFile(up); onPatch({ reference_file_ids: [...ids, up.id] }); }
          catch (x) { toast((x as Error).message, { kind: "error" }); } finally { setBusy(false); }
        }} />
        <button type="button" className="linkbtn small" disabled={busy || ids.length >= 20} onClick={() => ref.current?.click()}><Upload size={13} />{busy ? "Uploading…" : "Attach a file"}</button>
      </div>
      <span className="hint">Manuals, diagrams or photos the technician can open from this step</span>
    </div>);
}

const ENUM_VALUES = (src: Item): { key: string; label: string }[] =>
  src.type === "inspection" ? [{ key: "pass", label: "Pass" }, { key: "flag", label: "Flag" }, { key: "fail", label: "Fail" }]
    : src.type === "yes_no_na" ? [{ key: "yes", label: "Yes" }, { key: "no", label: "No" }, { key: "na", label: "N/A" }]
      : (src.options ?? []).map((o) => ({ key: o, label: o }));

function ConditionEditor({ it, onPatch }: { it: Item; onPatch: (p: Partial<Item>) => void }) {
  const { root } = useContext(BuilderCtx);
  const sources = fieldsBefore(root, it.id).filter((f) => COND_SOURCES.includes(f.type) && f.label);
  const c = it.condition;
  const src = c ? sources.find((s) => s.id === c.field) : undefined;
  const set = (n: Condition | null) => onPatch({ condition: n });
  const pickSource = (id: string) => {
    const s = sources.find((x) => x.id === id);
    if (!s) return set(null);
    if (s.type === "checkbox") return set({ field: id, op: "eq", value: true });
    if (s.type === "number" || s.type === "amount") return set({ field: id, op: "gt", value: 0 });
    const vals = ENUM_VALUES(s);
    return set({ field: id, op: "in", value: s.type === "inspection" ? ["flag", "fail"] : vals.slice(0, 1).map((v) => v.key) });
  };
  if (!sources.length) return <div className="small faint">Conditions: add a checkbox, choice, inspection or number field above this one to show it only for certain answers.</div>;
  return (
    <fieldset className="pb-cond">
      <legend className="small">{it.type === "section" ? "Show this section" : "Show this field"}</legend>
      <div className="row wrap" style={{ gap: 6 }}>
        <Select aria-label="Condition field" value={c?.field ?? ""} onChange={(e) => pickSource(e.target.value)} style={{ maxWidth: 260 }}>
          <option value="">Always</option>
          {sources.map((s) => <option key={s.id} value={s.id}>When “{s.label.slice(0, 60)}”</option>)}
        </Select>
        {c && src && src.type === "checkbox" && (
          <Select aria-label="Condition" value={c.op === "neq" ? "off" : "on"} onChange={(e) => set({ field: c.field, op: e.target.value === "on" ? "eq" : "neq", value: true })} style={{ width: "auto" }}>
            <option value="on">is checked</option><option value="off">is not checked</option></Select>)}
        {c && src && (src.type === "number" || src.type === "amount") && <>
          <Select aria-label="Condition" value={c.op} onChange={(e) => set({ ...c, op: e.target.value as Condition["op"] })} style={{ width: "auto" }}>
            <option value="gt">is more than</option><option value="lt">is less than</option><option value="eq">is</option><option value="neq">is not</option><option value="answered">is answered</option></Select>
          {c.op !== "answered" && <Input type="number" step="any" aria-label="Value" value={String(c.value ?? "")} style={{ width: 110 }} onChange={(e) => set({ ...c, value: e.target.value === "" ? 0 : Number(e.target.value) })} />}
        </>}
        {c && src && !["checkbox", "number", "amount"].includes(src.type) && <>
          <Select aria-label="Condition" value={c.op === "answered" ? "answered" : c.op === "not_in" || c.op === "neq" ? "not_in" : "in"} style={{ width: "auto" }}
            onChange={(e) => set(e.target.value === "answered" ? { field: c.field, op: "answered" } : { field: c.field, op: e.target.value as Condition["op"], value: Array.isArray(c.value) ? c.value : [] })}>
            <option value="in">{src.type === "checklist" ? "includes any of" : "is"}</option><option value="not_in">{src.type === "checklist" ? "includes none of" : "is not"}</option><option value="answered">is answered</option></Select>
        </>}
      </div>
      {c && src && !["checkbox", "number", "amount"].includes(src.type) && c.op !== "answered" && (
        <div className="row wrap" style={{ gap: 4, marginTop: 6 }}>
          {ENUM_VALUES(src).map((v) => {
            const arr = Array.isArray(c.value) ? (c.value as string[]) : c.value !== undefined ? [String(c.value)] : [];
            const on = arr.includes(v.key);
            return <button key={v.key} type="button" className={"pb-chip" + (on ? " on" : "")} aria-pressed={on}
              onClick={() => set({ ...c, value: on ? arr.filter((x) => x !== v.key) : [...arr, v.key] })}>{v.label}</button>;
          })}
        </div>)}
    </fieldset>);
}

function NestedPicker({ it, onPatch, onReplace }: { it: Item; onPatch: (p: Partial<Item>) => void; onReplace: (nodes: Item[]) => void }) {
  const lib = useLibrary(true);
  const { selfId, root } = useContext(BuilderCtx);
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);
  const merge = async () => {
    if (!it.procedure_id) return;
    setBusy(true);
    try {
      const d = await api<ProcedureDetail>(`/procedures/${it.procedure_id}`);
      const used = new Set(fieldsOf({ items: root }).map((f) => f.id).concat(root.map((r) => r.id)));
      const src = d.published?.schema.items ?? [];
      // keep conditions that point inside the merged procedure by re-mapping their ids
      const map: Record<string, string> = {};
      const re = (x: Item): Item => { let id = x.id; while (used.has(id)) id = newId(); used.add(id); map[x.id] = id; return { ...x, id, items: x.items?.map(re) }; };
      const fix = (x: Item): Item => ({ ...x, condition: x.condition && map[x.condition.field] ? { ...x.condition, field: map[x.condition.field] } : null, items: x.items?.map(fix) });
      const isNestedSection = !!parentOfRoot(root, it.id);
      let nodes = src.map(re).map(fix);
      if (isNestedSection) nodes = nodes.flatMap((n) => n.type === "section" ? [{ ...newItem("heading"), label: n.label }, ...(n.items ?? [])] : [n]);
      onReplace(nodes);
      toast(`Merged ${d.name}. Changes to it won't affect this procedure.`);
    } catch (e) { toast((e as ApiError).message, { kind: "error" }); } finally { setBusy(false); }
  };
  const choices = (lib.data?.items ?? []).filter((p) => p.id !== selfId);
  return (
    <div className="stack" style={{ gap: 8 }}>
      <Field label="Procedure" hint="Its fields appear here as they are when you publish. Publish again to pick up later changes.">
        {(id) => <Select id={id} value={it.procedure_id ?? ""} onChange={(e) => { const p = choices.find((x) => x.id === e.target.value); onPatch({ procedure_id: p?.id, label: p?.name ?? "" }); }}>
          <option value="">Pick a published procedure</option>{choices.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</Select>}</Field>
      {it.procedure_id && <div><Button size="sm" onClick={merge} disabled={busy}><GitMerge size={14} />Merge its fields into this procedure</Button></div>}
    </div>);
}
const parentOfRoot = (root: Item[], id: string) => parentOf(root, id);

// ---- variants (r598) -----------------------------------------------------------------------------
function VariantsEditor({ value, onChange, selfId }: { value: Variant[]; onChange: (v: Variant[]) => void; selfId?: string }) {
  const lib = useLibrary(true);
  const choices = (lib.data?.items ?? []).filter((p) => p.id !== selfId);
  const taken = (i: number) => new Set(value.flatMap((v, j) => j === i ? [] : v.months));
  return (
    <div className="stack" style={{ gap: 10 }}>
      {value.map((v, i) => (
        <div key={i} className="pb-variant">
          <div className="row wrap" style={{ gap: 6 }}>
            <Input aria-label="Variant name" value={v.name} maxLength={60} placeholder="e.g. Winter" onChange={(e) => onChange(value.map((x, j) => j === i ? { ...x, name: e.target.value } : x))} style={{ maxWidth: 160 }} />
            <Select aria-label="Use this procedure" value={v.procedure_id} onChange={(e) => onChange(value.map((x, j) => j === i ? { ...x, procedure_id: e.target.value } : x))} style={{ maxWidth: 280 }}>
              <option value="">Pick the procedure to use</option>{choices.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</Select>
            <Button variant="ghost" icon size="sm" aria-label="Remove variant" onClick={() => onChange(value.filter((_, j) => j !== i))}><Trash2 size={14} /></Button>
          </div>
          <div className="pb-months" role="group" aria-label="Months">
            {MONTHS.map((m, k) => { const n = k + 1, on = v.months.includes(n), off = taken(i).has(n);
              return <button key={m} type="button" className={"pb-chip" + (on ? " on" : "")} aria-pressed={on} disabled={off && !on}
                onClick={() => onChange(value.map((x, j) => j === i ? { ...x, months: on ? x.months.filter((y) => y !== n) : [...x.months, n].sort((a, b) => a - b) } : x))}>{m}</button>; })}
          </div>
        </div>))}
      <div><button type="button" className="linkbtn small" onClick={() => onChange([...value, { name: "", months: [], procedure_id: "" }])}><Plus size={13} />Add a seasonal variant</button></div>
    </div>);
}

// ---- the builder page -----------------------------------------------------------------------------
type Draft = { name: string; description: string; category: string; tags: string[]; items: Item[]; scoring: Schema["scoring"]; variants: Variant[] };
const blank: Draft = { name: "", description: "", category: "", tags: [], items: [], scoring: { enabled: false, goal: null }, variants: [] };

export function ProcedureBuilder({ id, init }: { id: string; init?: { name: string; schema: Schema } | null }) {
  const isNew = id === "new";
  const q = useQuery({ queryKey: ["procedure", id], queryFn: () => api<ProcedureDetail>(`/procedures/${id}`), enabled: !isNew });
  if (!isNew && !q.data) return q.isError ? <div className="page"><p>That procedure doesn't exist or you can't edit it. <Link to="/procedures">Back to procedures</Link></p></div>
    : <div className="page"><ListSkeleton rows={6} /></div>;
  const d = q.data;
  const start: Draft = d ? {
    name: d.name, description: d.description, category: d.category, tags: d.tags, variants: d.variants,
    items: (d.draft ?? d.published)?.schema.items ?? [], scoring: (d.draft ?? d.published)?.schema.scoring ?? { enabled: false, goal: null },
  } : init ? { ...blank, name: init.name, items: init.schema.items, scoring: init.schema.scoring ?? blank.scoring } : blank;
  return <BuilderInner key={id} id={isNew ? null : id} detail={d} start={start} />;
}

function BuilderInner({ id, detail, start }: { id: string | null; detail?: ProcedureDetail; start: Draft }) {
  const [d, setD] = useState<Draft>(start);
  const [dirty, setDirty] = useState(false);
  const [tab, setTab] = useState<"edit" | "preview">("edit");
  const [tagText, setTagText] = useState(start.tags.join(", "));
  const [files, setFiles] = useState<Record<string, FileItem>>(() => Object.fromEntries((detail?.files ?? []).map((f) => [f.id, f])));
  const [leaving, setLeaving] = useState(false);
  const nav = useNavigate();
  const qc = useQueryClient();
  const { toast } = useToast();
  const set = (p: Partial<Draft>) => { setD((x) => ({ ...x, ...p })); setDirty(true); };
  useEffect(() => {
    if (!dirty) return;
    const h = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ""; };
    window.addEventListener("beforeunload", h);
    return () => window.removeEventListener("beforeunload", h);
  }, [dirty]);
  const schema: Schema = useMemo(() => ({ items: d.items, scoring: d.scoring }), [d.items, d.scoring]);
  const payload = () => ({ name: d.name.trim(), description: d.description, category: d.category.trim(), tags: tagText.split(",").map((t) => t.trim()).filter(Boolean),
    variants: d.variants.filter((v) => v.procedure_id && v.months.length).map((v) => ({ ...v, name: v.name.trim() || "Variant" })), schema });
  const save = useMutation({
    mutationFn: async (publish: boolean) => {
      let p = id ? await api<ProcedureDetail>(`/procedures/${id}`, { method: "PATCH", body: payload() })
        : await api<ProcedureDetail>("/procedures", { method: "POST", body: payload() });
      if (publish) p = await api<ProcedureDetail>(`/procedures/${p.id}/publish`, { method: "POST" });
      return { p, publish };
    },
    onSuccess: ({ p, publish }) => {
      setDirty(false);
      qc.setQueryData(["procedure", p.id], p); qc.invalidateQueries({ queryKey: ["procedures"] }); qc.invalidateQueries({ queryKey: ["procedure", p.id] });
      toast(publish ? `Published version ${p.published?.number}` : "Draft saved");
      if (publish || !id) nav(publish ? `/procedures/${p.id}` : `/procedures/${p.id}/edit`, { replace: !id });
    },
    onError: (e) => toast((e as ApiError).message, { kind: "error" }),
  });
  const back = () => (dirty ? setLeaving(true) : nav(id ? `/procedures/${id}` : "/procedures"));
  const count = fieldsOf(schema).length;
  return (
    <div className="pb-page">
      <div className="pb-top">
        <Button variant="ghost" icon aria-label="Back" onClick={back}><ArrowLeft size={18} /></Button>
        <Input className="pb-name" aria-label="Procedure name" placeholder="Name this procedure" value={d.name} maxLength={255} onChange={(e) => set({ name: e.target.value })} />
        <span className="desktop-only">{detail?.status === "published" ? <Pill tone="success">Published v{detail.published?.number}</Pill> : <Pill>Draft</Pill>}</span>
        <span className="grow" />
        <Button onClick={() => save.mutate(false)} disabled={save.isPending || !d.name.trim()}>Save draft</Button>
        <Button variant="primary" onClick={() => save.mutate(true)} disabled={save.isPending || !d.name.trim() || count === 0}>Publish</Button>
      </div>
      <div className="seg pb-tabs" role="tablist" aria-label="Builder view">
        <button type="button" role="tab" aria-selected={tab === "edit"} className={"seg-btn" + (tab === "edit" ? " on" : "")} onClick={() => setTab("edit")}>Edit</button>
        <button type="button" role="tab" aria-selected={tab === "preview"} className={"seg-btn" + (tab === "preview" ? " on" : "")} onClick={() => setTab("preview")}><Eye size={14} />Preview</button>
      </div>
      <div className={"pb-main tab-" + tab}>
        <div className="pb-edit">
          <details className="card pb-meta" open={!id}>
            <summary><span className="grow">Details, scoring and variants</span><ChevronDown size={16} className="faint" /></summary>
            <div className="stack" style={{ gap: 12, padding: "0 var(--s-4) var(--s-4)" }}>
              <Field label="Description">{(i) => <textarea id={i} className="textarea" rows={2} value={d.description} maxLength={4000} onChange={(e) => set({ description: e.target.value })} />}</Field>
              <div className="pb-grid2">
                <Field label="Category">{(i) => <Input id={i} value={d.category} maxLength={80} placeholder="e.g. Safety" onChange={(e) => set({ category: e.target.value })} />}</Field>
                <Field label="Tags" hint="Separate with commas">{(i) => <Input id={i} value={tagText} placeholder="e.g. Weekly, OSHA" onChange={(e) => { setTagText(e.target.value); setDirty(true); }} />}</Field>
              </div>
              <Toggle checked={d.scoring.enabled} onChange={(v) => set({ scoring: { ...d.scoring, enabled: v } })} label="Score this procedure"
                hint="Checkboxes, choices, checklists and inspections earn points; the score is a percent of the points available" />
              {d.scoring.enabled && <Field label="Goal (%)" hint="Below the goal, a corrective work order can be created">
                {(i) => <Input id={i} type="number" min={0} max={100} style={{ maxWidth: 110 }} value={d.scoring.goal ?? ""}
                  onChange={(e) => set({ scoring: { ...d.scoring, goal: e.target.value === "" ? null : Math.max(0, Math.min(100, Math.round(Number(e.target.value)))) } })} />}</Field>}
              <div className="field"><label>Seasonal variants</label>
                <span className="hint" style={{ marginBottom: 6 }}>In the months you pick, work orders get the other procedure instead of this one</span>
                <VariantsEditor value={d.variants} onChange={(v) => set({ variants: v })} selfId={id ?? undefined} /></div>
            </div>
          </details>
          <ItemsEditor items={d.items} onChange={(items) => set({ items })} scoring={d.scoring.enabled} files={files}
            addFile={(f) => setFiles((x) => ({ ...x, [f.id]: f }))} selfId={id ?? undefined} />
        </div>
        <aside className="pb-preview card" aria-label="Preview">
          <div className="card-head"><h2><Eye size={16} /> Preview</h2><span className="small faint">How technicians see it</span></div>
          <div className="card-body"><PreviewForm schema={schema} refs={files} /></div>
        </aside>
      </div>
      {leaving && <Modal title="Leave without saving?" onClose={() => setLeaving(false)}
        footer={<><Button onClick={() => setLeaving(false)}>Keep editing</Button><Button variant="danger" onClick={() => { setDirty(false); nav(id ? `/procedures/${id}` : "/procedures"); }}>Discard changes</Button></>}>
        <p>Your changes to this procedure haven't been saved.</p></Modal>}
    </div>);
}

export function FieldTypeIcon({ type, size = 15 }: { type: ItemType; size?: number }): ReactNode {
  const I = FIELD_ICON[type];
  return <I size={size} />;
}
