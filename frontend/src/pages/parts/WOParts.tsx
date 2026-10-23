// Parts on a work order (r029, r042, r219, r220): the section on the WO detail, the field on the WO form,
// and the cycle count lines when the work order is a count.
import { useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { MoreHorizontal, Package, Plus, Trash2, Undo2 } from "lucide-react";
import { api, ApiError, type WODetail } from "../../lib/api";
import { useSession } from "../../lib/session";
import { currency } from "../../lib/format";
import { useToast } from "../../components/Toast";
import { Button, Dropdown, Field, Input, Modal, Pill, Select } from "../../components/ui";
import { MultiPicker } from "../../components/pickers";
import { RunPanel } from "./CycleCounts";
import { qsOf, qty, STATUS_OPTIONS, type CountRun, type PartList, type WOPartLine, type WOParts } from "./types";
import "./parts.css";

const AVAIL: Record<string, { tone: "success" | "warning" | "danger" | "neutral" | "info"; label: string }> = {
  available: { tone: "success", label: "Available" }, partial: { tone: "warning", label: "Partly available" }, unavailable: { tone: "danger", label: "Not available" },
  issued: { tone: "info", label: "Used" }, none: { tone: "neutral", label: "Non-stock" },
};

function usePartPicker(search: string) {
  return useQuery({ queryKey: ["parts", "picker", search], queryFn: () => api<PartList>(`/parts?per_page=50&sort=name&${qsOf({ q: search })}`), placeholderData: (p) => p });
}

/** Parts section on the work-order detail. */
export function WOPartsSection({ wo }: { wo: WODetail }) {
  const { can, session } = useSession();
  const qc = useQueryClient();
  const { toast } = useToast();
  const q = useQuery({ queryKey: ["wo-parts", wo.id], queryFn: () => api<WOParts>(`/work-orders/${wo.id}/parts`), enabled: can("parts.view") });
  const count = useQuery({ queryKey: ["wo-count", wo.id], queryFn: () => api<{ run: CountRun | null }>(`/work-orders/${wo.id}/cycle-count`), enabled: can("parts.view") });
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<WOPartLine | null>(null);
  const closed = ["done", "canceled"].includes(wo.status);
  const editable = can("parts.use") && !closed;
  const refresh = () => { qc.invalidateQueries({ queryKey: ["wo-parts", wo.id] }); qc.invalidateQueries({ queryKey: ["part"] }); qc.invalidateQueries({ queryKey: ["parts"] }); qc.invalidateQueries({ queryKey: ["wo", wo.id] }); };
  const err = (e: unknown) => toast((e as ApiError).message, { kind: "error" });
  const patch = useMutation({ mutationFn: ({ l, body }: { l: WOPartLine; body: Record<string, unknown> }) => api(`/work-orders/${wo.id}/parts/${l.id}`, { method: "PATCH", body }), onSuccess: refresh, onError: err });
  const ret = useMutation({ mutationFn: (l: WOPartLine) => api(`/work-orders/${wo.id}/parts/${l.id}/return`, { method: "POST", body: {} }), onSuccess: () => { refresh(); toast("Returned to stock"); }, onError: err });
  const del = useMutation({ mutationFn: (l: WOPartLine) => api(`/work-orders/${wo.id}/parts/${l.id}`, { method: "DELETE" }), onSuccess: refresh, onError: err });
  const items = q.data?.items ?? [];
  const cur = session.org?.currency;
  if (!can("parts.view")) return null;
  return (
    <>
      {count.data?.run && <RunPanel run={count.data.run} onChange={() => count.refetch()} />}
      {(items.length > 0 || editable) && <section className="card wo-parts">
        <div className="card-head"><h3 className="sec-h" style={{ margin: 0 }}>Parts</h3>
          {editable && <Button size="sm" variant="ghost" onClick={() => setAdding(true)}><Plus size={14} />Add parts</Button>}</div>
        {items.length === 0 ? <div className="card-body small faint">No parts yet. Add what you used, or plan and reserve what the job needs.</div>
          : items.map((l) => (
            <div key={l.id} className="list-row wo-part-row">
              <Package size={16} className="faint" />
              <div className="grow" style={{ minWidth: 0 }}>
                <div className="t">{l.part.deleted ? l.part.name : <Link to={`/parts/${l.part.id}`}>{l.part.name}</Link>}</div>
                <div className="s">{[l.part.part_number, l.location?.name, l.note].filter(Boolean).join(" · ") || " "}</div>
              </div>
              <span className="wo-part-qty">{l.status === "issued" ? qty(l.used, l.part.unit) : qty(l.quantity, l.part.unit)}</span>
              <Pill tone={l.status === "issued" ? "info" : "neutral"}>{l.status_label}</Pill>
              {l.status !== "issued" && !l.part.non_stock && <Pill tone={AVAIL[l.availability.state]?.tone ?? "neutral"}>{AVAIL[l.availability.state]?.label}{l.availability.state === "partial" && l.availability.available ? ` (${l.availability.available})` : ""}</Pill>}
              {l.status !== "issued" && l.availability.overcommitted && <Pill tone="danger">Overcommitted</Pill>}
              {q.data?.costs_visible && <span className="small muted wo-part-cost">{currency(l.line_cost, cur)}</span>}
              {editable && <Dropdown trigger={(_, t) => <Button size="sm" variant="ghost" icon aria-label={`Actions for ${l.part.name}`} onClick={t}><MoreHorizontal size={15} /></Button>} width={220}>
                {(close) => <>
                  {l.status !== "issued" && <button className="menu-item" onClick={() => { close(); patch.mutate({ l, body: { status: "issued" } }); }}><Package size={15} />Mark as used</button>}
                  <button className="menu-item" onClick={() => { close(); setEditing(l); }}>Change quantity or status</button>
                  {l.status === "issued" && Number(l.used) > 0 && <button className="menu-item" onClick={() => { close(); ret.mutate(l); }}><Undo2 size={15} />Return to stock</button>}
                  <div className="menu-sep" />
                  <button className="menu-item" style={{ color: "var(--c-danger)" }} onClick={() => { close(); del.mutate(l); }}><Trash2 size={15} />Remove</button>
                </>}
              </Dropdown>}
            </div>))}
        {q.data?.costs_visible && items.length > 0 && <div className="card-body row" style={{ justifyContent: "flex-end" }}><span className="small muted">Parts total</span><b>{currency(q.data.total_cost, cur)}</b></div>}
      </section>}
      {adding && <AddPartsDialog woId={wo.id} onClose={() => setAdding(false)} onDone={refresh} />}
      {editing && <EditLineDialog woId={wo.id} l={editing} onClose={() => setEditing(null)} onDone={refresh} />}
    </>
  );
}

function AddPartsDialog({ woId, onClose, onDone }: { woId: string; onClose: () => void; onDone: () => void }) {
  const [search, setSearch] = useState("");
  const parts = usePartPicker(search);
  const [rows, setRows] = useState<{ part_id: string; name: string; unit: string; quantity: string; location_id: string | null; status: string; stocks: { id: string | null; name: string }[] }[]>([]);
  const [err, setErr] = useState("");
  const add = useMutation({
    mutationFn: async () => {
      for (const r of rows) await api(`/work-orders/${woId}/parts`, { method: "POST", body: { part_id: r.part_id, quantity: r.quantity, status: r.status, ...(r.location_id !== undefined ? { location_id: r.location_id } : {}) } });
    },
    onSuccess: () => { onDone(); onClose(); },
    onError: (e) => { setErr((e as ApiError).message); onDone(); },
  });
  const pick = async (ids: string[]) => {
    const keep = rows.filter((r) => ids.includes(r.part_id));
    const added = ids.filter((id) => !rows.some((r) => r.part_id === id));
    const found = (parts.data?.items ?? []).filter((p) => added.includes(p.id));
    const fresh = await Promise.all(found.map(async (p) => {
      let stocks: { id: string | null; name: string }[] = [];
      try { const d = await api<{ stock: { location: { id: string; name: string } | null; on_hand: string }[] }>(`/parts/${p.id}`);
        stocks = d.stock.map((s) => ({ id: s.location?.id ?? null, name: `${s.location?.name ?? "No location"} (${s.on_hand})` })); } catch { /* keep empty */ }
      return { part_id: p.id, name: p.name, unit: p.unit, quantity: "1", location_id: stocks[0]?.id ?? null, status: "issued", stocks };
    }));
    setRows([...keep, ...fresh]);
  };
  return (
    <Modal title="Add parts" onClose={onClose} width={640}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!rows.length || add.isPending} onClick={() => add.mutate()}>Add {rows.length || ""} part{rows.length === 1 ? "" : "s"}</Button></>}>
      <MultiPicker label="Parts" placeholder="Search parts by name, number or barcode" value={rows.map((r) => r.part_id)} onChange={pick} searchPlaceholder="Search parts"
        options={[...rows.map((r) => ({ key: r.part_id, label: r.name })), ...(parts.data?.items ?? []).filter((p) => !rows.some((r) => r.part_id === p.id)).map((p) => ({
          key: p.id, label: p.name, sub: [p.part_number, p.non_stock ? "Non-stock" : `${qty(p.available, p.unit)} available`].filter(Boolean).join(" · ") }))]} />
      <Input aria-label="Filter parts" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Narrow the list (name, number, barcode)" />
      {rows.map((r, i) => {
        const upd = (p: Partial<(typeof rows)[number]>) => setRows((rs) => rs.map((x, j) => (j === i ? { ...x, ...p } : x)));
        return (
          <div key={r.part_id} className="wo-add-row">
            <b className="grow">{r.name}</b>
            <Input aria-label={`Quantity of ${r.name}`} inputMode="decimal" value={r.quantity} onChange={(e) => upd({ quantity: e.target.value })} />
            {r.stocks.length > 1 && <Select aria-label={`Location for ${r.name}`} value={r.location_id ?? "none"} onChange={(e) => upd({ location_id: e.target.value === "none" ? null : e.target.value })}>
              {r.stocks.map((s) => <option key={s.id ?? "none"} value={s.id ?? "none"}>{s.name}</option>)}</Select>}
            <Select aria-label={`Status of ${r.name}`} value={r.status} onChange={(e) => upd({ status: e.target.value })}>{STATUS_OPTIONS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select>
          </div>);
      })}
      <p className="small faint" style={{ margin: 0 }}>Used takes the parts out of stock now. Planned, Reserved, Kitted and Staged hold them for this work order; they're used when it's done.</p>
      {err && <div className="banner warning" role="alert">{err}</div>}
    </Modal>
  );
}

function EditLineDialog({ woId, l, onClose, onDone }: { woId: string; l: WOPartLine; onClose: () => void; onDone: () => void }) {
  const { can } = useSession();
  const [quantity, setQuantity] = useState(l.quantity);
  const [status, setStatus] = useState(l.status);
  const [override, setOverride] = useState(l.unit_cost_override ?? "");
  const [note, setNote] = useState(l.note);
  const [err, setErr] = useState("");
  const m = useMutation({
    mutationFn: () => api(`/work-orders/${woId}/parts/${l.id}`, { method: "PATCH", body: { quantity, status, note, ...(can("costs.view") ? { unit_cost_override: override || null } : {}) } }),
    onSuccess: () => { onDone(); onClose(); }, onError: (e) => setErr((e as ApiError).message),
  });
  return (
    <Modal title={l.part.name} onClose={onClose} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={m.isPending} onClick={() => m.mutate()}>Save</Button></>}>
      <div className="part-grid2">
        <Field label={`Quantity${l.part.unit !== "each" ? ` (${l.part.unit})` : ""}`}>{(id) => <Input id={id} inputMode="decimal" value={quantity} onChange={(e) => setQuantity(e.target.value)} />}</Field>
        <Field label="Status">{(id) => <Select id={id} value={status} onChange={(e) => setStatus(e.target.value)}>{STATUS_OPTIONS.map(([k, lb]) => <option key={k} value={k}>{lb}</option>)}</Select>}</Field>
      </div>
      {can("costs.view") && <Field label="Unit cost on this work order" hint="Leave empty to use the part's cost.">{(id) => <Input id={id} inputMode="decimal" value={override} placeholder={l.unit_cost ?? ""} onChange={(e) => setOverride(e.target.value)} />}</Field>}
      <Field label="Note">{(id) => <Input id={id} value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} />}</Field>
      {err && <div className="banner warning" role="alert">{err}</div>}
    </Modal>
  );
}

// ---------------------------------------------------------------- WO form: parts planned when creating
export type PartDraft = { part_id: string; name: string; quantity: string };

/** On the new-work-order form: parts the job needs (added as Planned; r219). */
export function WOFormParts({ value, onChange }: { value: PartDraft[]; onChange: (v: PartDraft[]) => void }) {
  const { can } = useSession();
  const [search, setSearch] = useState("");
  const parts = usePartPicker(search);
  if (!can("parts.use")) return null;
  return (
    <div className="stack" style={{ gap: 6 }}>
      <MultiPicker label="Parts" placeholder="Add parts the job needs" value={value.map((v) => v.part_id)} searchPlaceholder="Search parts"
        onChange={(ids) => onChange([...value.filter((v) => ids.includes(v.part_id)),
          ...(parts.data?.items ?? []).filter((p) => ids.includes(p.id) && !value.some((v) => v.part_id === p.id)).map((p) => ({ part_id: p.id, name: p.name, quantity: "1" }))])}
        options={[...value.map((v) => ({ key: v.part_id, label: v.name })), ...(parts.data?.items ?? []).filter((p) => !value.some((v) => v.part_id === p.id))
          .map((p) => ({ key: p.id, label: p.name, sub: [p.part_number, p.non_stock ? "Non-stock" : `${qty(p.available, p.unit)} available`].filter(Boolean).join(" · ") }))]} />
      {value.length === 0 && <Input aria-label="Filter parts" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Narrow the parts list" />}
      {value.map((v, i) => <div key={v.part_id} className="wo-add-row"><span className="grow">{v.name}</span>
        <Input aria-label={`Quantity of ${v.name}`} inputMode="decimal" value={v.quantity} onChange={(e) => onChange(value.map((x, j) => (j === i ? { ...x, quantity: e.target.value } : x)))} /></div>)}
    </div>
  );
}
