// MaintainX-style filter chips: "Status: One of Open, On Hold", with One of / None of / Is empty / Contains.
import { useMemo, useState } from "react";
import { Bookmark, Check, ChevronDown, Filter as FilterIcon, Pin, Plus, Save, Trash2, X } from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError, type Filter, type SavedView, type WOOptions } from "../../lib/api";
import { useSession } from "../../lib/session";
import { useToast } from "../../components/Toast";
import { Avatar, Button, Checkbox, Dropdown, Field, Input, Modal, Select } from "../../components/ui";

type FieldDef = { id: string; label: string; kind: "list" | "date" | "text" | "bool" | "parent"; options?: (o: WOOptions) => { id: string; label: string; color?: string; initials?: string }[] };

const OPS: Record<string, { id: string; label: string }[]> = {
  list: [{ id: "in", label: "One of" }, { id: "not_in", label: "None of" }, { id: "empty", label: "Is empty" }, { id: "not_empty", label: "Is not empty" }],
  date: [{ id: "between", label: "Between" }, { id: "before", label: "Before" }, { id: "after", label: "After" }, { id: "overdue", label: "Overdue" }, { id: "empty", label: "Is empty" }, { id: "not_empty", label: "Is not empty" }],
  text: [{ id: "contains", label: "Contains" }, { id: "not_contains", label: "Does not contain" }, { id: "empty", label: "Is empty" }, { id: "not_empty", label: "Is not empty" }],
  bool: [{ id: "is", label: "Is" }],
  parent: [{ id: "empty", label: "Top-level only" }, { id: "not_empty", label: "Sub-work orders only" }],
};
const NO_EMPTY = new Set(["status", "priority", "work_type", "created_by", "completed_by"]);

export function fieldDefs(o: WOOptions | undefined): FieldDef[] {
  const people = (x: WOOptions) => [{ id: "me", label: "Me" }, ...x.people.map((p) => ({ id: p.id, label: p.name, initials: p.initials }))];
  const base: FieldDef[] = [
    { id: "status", label: "Status", kind: "list", options: (x) => x.statuses.map((s) => ({ id: s.id, label: s.label })) },
    { id: "priority", label: "Priority", kind: "list", options: (x) => x.priorities.map((s) => ({ id: s.id, label: s.label })) },
    { id: "assignee", label: "Assigned to", kind: "list", options: (x) => [...people(x), { id: "none", label: "Nobody" }] },
    { id: "team", label: "Team", kind: "list", options: (x) => x.teams.map((t) => ({ id: t.id, label: t.name, color: t.color })) },
    { id: "category", label: "Category", kind: "list", options: (x) => x.categories.map((c) => ({ id: c.id, label: c.name, color: c.color })) },
    { id: "due_at", label: "Due date", kind: "date" },
    { id: "start_at", label: "Start date", kind: "date" },
    { id: "work_type", label: "Work type", kind: "list", options: (x) => x.work_types.map((s) => ({ id: s.id, label: s.label })) },
    { id: "created_by", label: "Created by", kind: "list", options: people },
    { id: "completed_by", label: "Completed by", kind: "list", options: people },
    { id: "created_at", label: "Created", kind: "date" },
    { id: "completed_at", label: "Completed", kind: "date" },
    { id: "title", label: "Title", kind: "text" },
    { id: "description", label: "Description", kind: "text" },
    { id: "parent", label: "Sub-work orders", kind: "parent" },
    { id: "unread", label: "Unread", kind: "bool" },
  ];
  const custom: FieldDef[] = (o?.custom_fields ?? []).map((f) => ({
    id: `custom.${f.id}`, label: f.name,
    kind: f.type === "select" ? "list" : f.type === "date" || f.type === "datetime" ? "date" : f.type === "checkbox" ? "list" : "text",
    options: f.type === "select" ? () => f.options.map((x) => ({ id: x, label: x })) : f.type === "checkbox" ? () => [{ id: "true", label: "Checked" }, { id: "false", label: "Not checked" }] : undefined,
  }));
  return [...base, ...custom];
}

function describe(f: Filter, def: FieldDef | undefined, o: WOOptions | undefined): string {
  if (!def) return f.field;
  const op = (OPS[def.kind] ?? []).find((x) => x.id === f.op)?.label ?? f.op;
  if (["empty", "not_empty", "overdue"].includes(f.op) || def.kind === "parent") return `${def.label}: ${op}`;
  if (def.kind === "bool") return f.value ? "Unread" : "Read";
  if (def.kind === "list" && o && def.options) {
    const opts = def.options(o);
    const names = ((f.value as string[]) ?? []).map((v) => opts.find((x) => x.id === v)?.label ?? v);
    return `${def.label}: ${f.op === "not_in" ? "not " : ""}${names.length > 2 ? `${names.slice(0, 2).join(", ")} +${names.length - 2}` : names.join(", ") || "—"}`;
  }
  if (def.kind === "date") {
    const v = f.value as string | string[] | undefined;
    if (f.op === "between" && Array.isArray(v)) return `${def.label}: ${v[0] || "…"} – ${v[1] || "…"}`;
    return `${def.label}: ${op.toLowerCase()} ${v ?? ""}`;
  }
  return `${def.label}: ${op.toLowerCase()} “${f.value ?? ""}”`;
}

function FilterEditor({ filter, def, options, onChange, onRemove, close }: { filter: Filter; def: FieldDef; options: WOOptions; onChange: (f: Filter) => void; onRemove: () => void; close: () => void }) {
  const [f, setF] = useState<Filter>(filter);
  const [q, setQ] = useState("");
  const ops = (OPS[def.kind] ?? []).filter((x) => !(NO_EMPTY.has(def.id) && (x.id === "empty" || x.id === "not_empty")));
  const vals = (f.value as string[] | undefined) ?? [];
  const noValue = ["empty", "not_empty", "overdue"].includes(f.op) || def.kind === "parent";
  const opts = def.options ? def.options(options).filter((x) => !q || x.label.toLowerCase().includes(q.toLowerCase())) : [];
  return (
    <div style={{ padding: 8, width: 290 }} className="stack">
      <div className="row"><b className="grow">{def.label}</b><Button size="sm" variant="ghost" icon aria-label="Remove filter" onClick={() => { onRemove(); close(); }}><Trash2 size={14} /></Button></div>
      {def.kind !== "bool" && <Select value={f.op} aria-label="Condition" onChange={(e) => setF({ ...f, op: e.target.value, value: def.kind === "list" ? vals : f.value })}>
        {ops.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}</Select>}
      {!noValue && def.kind === "list" && (<>
        {opts.length > 7 && <Input placeholder="Search" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search options" />}
        <div className="filter-opts">{opts.map((x) => (
          <Checkbox key={x.id} checked={vals.includes(x.id)} onChange={(c) => setF({ ...f, value: c ? [...vals, x.id] : vals.filter((v) => v !== x.id) })}
            label={<span className="row" style={{ gap: 6 }}>{x.color && <span className="sw lg" style={{ background: x.color }} />}{x.initials && <Avatar name={x.label} initials={x.initials} size="sm" />}{x.label}</span>} />))}</div>
      </>)}
      {!noValue && def.kind === "date" && (f.op === "between"
        ? <div className="row"><Input type="date" aria-label="From" value={((f.value as string[]) ?? [])[0] ?? ""} onChange={(e) => setF({ ...f, value: [e.target.value, ((f.value as string[]) ?? [])[1] ?? ""] })} />
            <Input type="date" aria-label="To" value={((f.value as string[]) ?? [])[1] ?? ""} onChange={(e) => setF({ ...f, value: [((f.value as string[]) ?? [])[0] ?? "", e.target.value] })} /></div>
        : <Input type="date" aria-label="Date" value={(f.value as string) ?? ""} onChange={(e) => setF({ ...f, value: e.target.value })} />)}
      {!noValue && def.kind === "text" && <Input aria-label="Text" value={(f.value as string) ?? ""} onChange={(e) => setF({ ...f, value: e.target.value })} autoFocus />}
      {def.kind === "bool" && <Select value={f.value ? "1" : "0"} aria-label="Value" onChange={(e) => setF({ ...f, value: e.target.value === "1" })}><option value="1">Unread</option><option value="0">Read</option></Select>}
      <div className="row" style={{ justifyContent: "flex-end" }}><Button size="sm" onClick={close}>Cancel</Button><Button size="sm" variant="primary" onClick={() => { onChange(f); close(); }}>Apply</Button></div>
    </div>
  );
}

export function FilterBar({ filters, onChange, options, activeView, onViewChange, sort }: {
  filters: Filter[]; onChange: (f: Filter[]) => void; options: WOOptions | undefined; activeView: SavedView | null; onViewChange: (v: SavedView | null) => void; sort?: string;
}) {
  const defs = useMemo(() => fieldDefs(options), [options]);
  const [adding, setAdding] = useState<string | null>(null);
  return (
    <div className="filterbar">
      <SavedViews filters={filters} active={activeView} onPick={(v) => { onViewChange(v); onChange(v ? v.filters : []); }} sort={sort} />
      {filters.map((f, i) => {
        const def = defs.find((d) => d.id === f.field);
        return (
          <Dropdown key={i} align="left" width={306} trigger={(_, toggle) => (
            <span className="fchip"><button type="button" onClick={toggle}>{describe(f, def, options)}</button>
              <button type="button" aria-label="Remove filter" onClick={() => onChange(filters.filter((_, j) => j !== i))}><X size={13} /></button></span>)}>
            {(close) => def && options ? <FilterEditor filter={f} def={def} options={options} close={close}
              onChange={(nf) => onChange(filters.map((x, j) => (j === i ? nf : x)))} onRemove={() => onChange(filters.filter((_, j) => j !== i))} /> : null}
          </Dropdown>);
      })}
      <Dropdown align="left" width={adding ? 306 : 240} trigger={(_, toggle) => <Button size="sm" variant="ghost" onClick={() => { setAdding(null); toggle(); }}><Plus size={14} />Add filter</Button>}>
        {(close) => adding && options ? (
          <FilterEditor def={defs.find((d) => d.id === adding)!} options={options} close={() => { setAdding(null); close(); }} onRemove={() => setAdding(null)}
            filter={{ field: adding, op: (OPS[defs.find((d) => d.id === adding)!.kind] ?? [{ id: "in" }])[0].id, value: defs.find((d) => d.id === adding)!.kind === "bool" ? true : undefined }}
            onChange={(nf) => onChange([...filters, nf])} />
        ) : (<div style={{ maxHeight: 360, overflowY: "auto" }}>
          <div className="menu-label">Filter by</div>
          {defs.map((d) => <button key={d.id} type="button" className="menu-item" onClick={() => setAdding(d.id)}><FilterIcon size={14} className="faint" />{d.label}</button>)}
        </div>)}
      </Dropdown>
      {filters.length > 0 && <button type="button" className="linkbtn small" onClick={() => { onChange([]); onViewChange(null); }}>Reset</button>}
    </div>
  );
}

function SavedViews({ filters, active, onPick, sort }: { filters: Filter[]; active: SavedView | null; onPick: (v: SavedView | null) => void; sort?: string }) {
  const { can } = useSession();
  const qc = useQueryClient();
  const { toast } = useToast();
  const views = useQuery({ queryKey: ["wo-views"], queryFn: () => api<{ items: SavedView[] }>("/work-orders/views") });
  const [saving, setSaving] = useState(false);
  const [name, setName] = useState("");
  const [shared, setShared] = useState(false);
  const err = (e: unknown) => toast((e as ApiError).message, { kind: "error" });
  const save = useMutation({
    mutationFn: () => api<SavedView>("/work-orders/views", { method: "POST", body: { name, filters, shared, sort: sort ?? "" } }),
    onSuccess: (v) => { qc.invalidateQueries({ queryKey: ["wo-views"] }); onPick(v); setSaving(false); toast(`Saved view “${v.name}”`); }, onError: err,
  });
  const update = useMutation({
    mutationFn: (v: SavedView) => api<SavedView>(`/work-orders/views/${v.id}`, { method: "PATCH", body: { filters, sort: sort ?? v.sort } }),
    onSuccess: (v) => { qc.invalidateQueries({ queryKey: ["wo-views"] }); onPick(v); toast("View updated"); }, onError: err,
  });
  const pin = useMutation({ mutationFn: (v: SavedView) => api(`/work-orders/views/${v.id}`, { method: "PATCH", body: { pinned: !v.pinned } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["wo-views"] }), onError: err });
  const del = useMutation({ mutationFn: (v: SavedView) => api(`/work-orders/views/${v.id}`, { method: "DELETE" }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["wo-views"] }); onPick(null); toast("View deleted"); }, onError: err });
  const changed = active && JSON.stringify(active.filters) !== JSON.stringify(filters);
  const pinned = (views.data?.items ?? []).filter((v) => v.pinned);
  return (
    <>
      {pinned.map((v) => <button type="button" key={v.id} className={"vchip" + (active?.id === v.id ? " active" : "")} onClick={() => onPick(active?.id === v.id ? null : v)}><Pin size={12} />{v.name}</button>)}
      <Dropdown align="left" width={280} trigger={(_, toggle) => (
        <Button size="sm" onClick={toggle} aria-label="Saved views"><Bookmark size={14} />{active && !active.pinned ? active.name : "Views"}{changed && " •"}<ChevronDown size={13} /></Button>)}>
        {(close) => <>
          <div className="menu-label">Saved views</div>
          {(views.data?.items ?? []).length === 0 && <div className="small faint" style={{ padding: "4px 10px 8px" }}>Filter the list, then save it as a view.</div>}
          {(views.data?.items ?? []).map((v) => {
            const mine = !v.shared || can("views.share");
            return (
              <div key={v.id} className="menu-item" style={{ padding: "4px 6px 4px 10px" }}>
                <button type="button" className="grow linkbtn" style={{ color: "var(--c-text)", fontWeight: 500, textAlign: "left" }} onClick={() => { onPick(v); close(); }}>
                  {v.name}{v.shared && <span className="small faint"> · shared</span>}</button>
                {active?.id === v.id && <Check size={14} color="var(--c-primary)" />}
                {mine && <Button size="sm" variant="ghost" icon aria-label={v.pinned ? "Unpin" : "Pin"} onClick={() => pin.mutate(v)}><Pin size={13} style={{ opacity: v.pinned ? 1 : 0.4 }} /></Button>}
                {mine && <Button size="sm" variant="ghost" icon aria-label="Delete view" onClick={() => del.mutate(v)}><Trash2 size={13} /></Button>}
              </div>);
          })}
          <div className="menu-sep" />
          {changed && active && (!active.shared || can("views.share")) && <button type="button" className="menu-item" onClick={() => { update.mutate(active); close(); }}><Save size={14} />Update “{active.name}”</button>}
          <button type="button" className="menu-item" disabled={!filters.length} onClick={() => { setName(""); setShared(false); setSaving(true); close(); }}><Plus size={14} />Save current filters as a view</button>
        </>}
      </Dropdown>
      {saving && (
        <Modal title="Save view" onClose={() => setSaving(false)} footer={<><Button onClick={() => setSaving(false)}>Cancel</Button>
          <Button variant="primary" disabled={!name.trim() || save.isPending} onClick={() => save.mutate()}>Save view</Button></>}>
          <Field label="Name">{(id) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. High priority electrical" autoFocus />}</Field>
          {can("views.share") && <Checkbox checked={shared} onChange={setShared} label="Share with everyone in the organization" />}
        </Modal>)}
    </>
  );
}
