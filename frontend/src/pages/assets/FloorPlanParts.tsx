// Parts lists pinned on a floor plan (0.5.0, MP-128): a small card at a spot on the plan that expands to the parts
// kept there and how many are on hand. Stored as a "parts" shape in the drawing, so it moves, undoes and saves with
// the rest of the edits. Stock comes live from GET /parts?ids=…
import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, Package, Search } from "lucide-react";
import { api } from "../../lib/api";
import { useSession } from "../../lib/session";
import { Button, Checkbox, Field, Input, Modal } from "../../components/ui";
import type { Shape } from "./floorplanShapes";

type PartRow = { id: string; name: string; on_hand: number | string | null; unit: string; part_number?: string };

function usePartsById(ids: string[], enabled: boolean) {
  const key = [...ids].sort().join(",");
  return useQuery({
    queryKey: ["parts-by-id", key],
    queryFn: () => api<{ items: PartRow[] }>(`/parts?ids=${key}&per_page=100`),
    enabled: enabled && ids.length > 0, staleTime: 30_000,
  });
}

const fmtQty = (v: PartRow["on_hand"]) => (v === null || v === undefined ? "—" : String(Number(v)));

/** One pinned list. In the editor the card carries data-sid so it can be selected and moved like any shape. */
export function PartsListCard({ s, editing, onToggleDefault, onOpenPart }: {
  s: Shape; editing: boolean; onToggleDefault?: (open: boolean) => void; onOpenPart?: () => void;
}) {
  const { can } = useSession();
  const [openLocal, setOpenLocal] = useState<boolean | null>(null);
  const open = editing ? !!s.open : openLocal ?? !!s.open;
  const ids = s.part_ids ?? [];
  const allowed = can("parts.view");
  const q = usePartsById(ids, open && allowed);
  const byId = new Map((q.data?.items ?? []).map((p) => [p.id, p]));
  const rows = ids.map((id) => byId.get(id)).filter((p): p is PartRow => !!p);
  const title = s.label || "Parts";
  return (
    <div className={"plan-parts" + (open ? " open" : "")} data-sid={editing ? s.id : undefined}
      style={{ left: `${(s.x ?? 0) * 100}%`, top: `${(s.y ?? 0) * 100}%` }}
      onPointerDown={editing ? undefined : (e) => e.stopPropagation()}>
      <button type="button" className="plan-parts-head" aria-expanded={open}
        onPointerDown={editing ? (e) => e.stopPropagation() : undefined}
        onClick={(e) => { e.stopPropagation(); if (editing) onToggleDefault?.(!open); else setOpenLocal(!open); }}
        title={editing ? "Choose whether this list starts expanded" : undefined}>
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}<Package size={14} aria-hidden />
        <span className="plan-parts-t">{title}</span><span className="plan-parts-n">{ids.length}</span>
      </button>
      {open && (
        <div className="plan-parts-body">
          {!allowed ? <div className="small faint">You don't have access to parts.</div>
            : q.isLoading ? <div className="small faint">Loading…</div>
            : q.isError ? <div className="small faint">Couldn't load the parts.</div>
            : rows.length === 0 ? <div className="small faint">These parts were removed.</div>
            : <ul>{rows.map((p) => {
                const n = Number(p.on_hand);
                const tone = p.on_hand === null ? "" : n <= 0 ? " out" : "";
                return (
                  <li key={p.id}>
                    {editing ? <span className="grow">{p.name}</span>
                      : <Link className="grow" to={`/parts/${p.id}`} onClick={() => onOpenPart?.()}>{p.name}</Link>}
                    <span className={"tnum plan-parts-q" + tone} title="On hand">{fmtQty(p.on_hand)} {p.unit}</span>
                  </li>);
              })}</ul>}
        </div>)}
    </div>
  );
}

/** Pick the parts for a pinned list (new or edited). */
export function PartsListDialog({ current, onClose, onSave }: {
  current: Shape | null; onClose: () => void; onSave: (v: { part_ids: string[]; label: string; open: boolean }) => void;
}) {
  const [q, setQ] = useState("");
  const [picked, setPicked] = useState<string[]>(current?.part_ids ?? []);
  const [label, setLabel] = useState(current?.label ?? "");
  const [open, setOpen] = useState(current?.open ?? true);
  const found = useQuery({
    queryKey: ["parts-search", q],
    queryFn: () => api<{ items: PartRow[] }>(`/parts?per_page=30&sort=name&q=${encodeURIComponent(q)}`),
    placeholderData: (p) => p,
  });
  const chosen = usePartsById(picked, true);
  const names = new Map([...(chosen.data?.items ?? []), ...(found.data?.items ?? [])].map((p) => [p.id, p.name]));
  const toggle = (id: string) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : p.length >= 50 ? p : [...p, id]));
  return (
    <Modal title={current ? "Edit parts list" : "Pin a parts list"} onClose={onClose} width={520}
      footer={<><Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" disabled={!picked.length} onClick={() => onSave({ part_ids: picked, label: label.trim(), open })}>{current ? "Save list" : "Pin list"}</Button></>}>
      <Field label="Title" hint="Optional, e.g. “Spares by press 2”.">{(id) => <Input id={id} value={label} maxLength={120} placeholder="Parts" onChange={(e) => setLabel(e.target.value)} />}</Field>
      {picked.length > 0 && <div className="row wrap" style={{ gap: 6 }} aria-label="Chosen parts">{picked.map((id) => (
        <button key={id} type="button" className="chip" onClick={() => toggle(id)} aria-label={`Remove ${names.get(id) ?? "part"}`}>{names.get(id) ?? "Part"} ×</button>))}</div>}
      <div className="search-in"><Search size={15} className="faint" />
        <Input placeholder="Search parts by name or number" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search parts" autoFocus /></div>
      <div className="plan-parts-pick" role="group" aria-label="Parts">
        {(found.data?.items ?? []).map((p) => (
          <Checkbox key={p.id} checked={picked.includes(p.id)} onChange={() => toggle(p.id)}
            label={<span className="row" style={{ gap: 8 }}><span className="grow">{p.name}</span><span className="small faint tnum">{fmtQty(p.on_hand)} {p.unit}</span></span>} />))}
        {found.data && found.data.items.length === 0 && <div className="small faint">No parts match.</div>}
      </div>
      <Checkbox checked={open} onChange={setOpen} label="Show the list expanded" />
      {picked.length >= 50 && <div className="small muted">A list can hold up to 50 parts.</div>}
    </Modal>
  );
}
