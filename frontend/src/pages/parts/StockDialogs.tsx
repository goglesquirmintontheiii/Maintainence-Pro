// Restock, adjust, move between locations, and a stocking location's area/min/max. Every change goes through the ledger.
import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { api, ApiError } from "../../lib/api";
import { useSession } from "../../lib/session";
import { useToast } from "../../components/Toast";
import { Button, Field, Input, Modal, Select } from "../../components/ui";
import { LocationPicker } from "../../components/assetPickers";
import { qty, type PartDetail, type StockRow } from "./types";

type Props = { p: PartDetail; stock?: StockRow; onClose: () => void; onDone: () => void };
const locKey = (s: StockRow) => s.location?.id ?? "none";
const locId = (k: string) => (k === "none" ? null : k);

function LocationSelect({ p, value, onChange, label = "Location", exclude }: { p: PartDetail; value: string; onChange: (v: string) => void; label?: string; exclude?: string }) {
  return (
    <Field label={label}>{(id) => <Select id={id} value={value} onChange={(e) => onChange(e.target.value)}>
      {p.stock.filter((s) => locKey(s) !== exclude).map((s) => <option key={s.id} value={locKey(s)}>{s.location?.name ?? "No location"}{s.area ? ` · ${s.area}` : ""} ({qty(s.on_hand, p.unit)})</option>)}
    </Select>}</Field>
  );
}

function useStockAction(path: string, done: string, onDone: () => void, onClose: () => void) {
  const { toast } = useToast();
  const [err, setErr] = useState("");
  const m = useMutation({
    mutationFn: (body: Record<string, unknown>) => api(path, { method: "POST", body }),
    onSuccess: () => { toast(done); onDone(); onClose(); },
    onError: (e) => setErr((e as ApiError).message),
  });
  return { m, err };
}

export function RestockDialog({ p, stock, onClose, onDone }: Props) {
  const { can } = useSession();
  const [loc, setLoc] = useState(stock ? locKey(stock) : p.stock[0] ? locKey(p.stock[0]) : "none");
  const [newLoc, setNewLoc] = useState<string | null>(null);
  const cur = p.stock.find((s) => locKey(s) === loc);
  const [n, setN] = useState(cur?.restock_quantity && cur.restock_quantity !== "0" ? cur.restock_quantity : "");
  const [cost, setCost] = useState(p.unit_cost ?? "");
  const [note, setNote] = useState("");
  const { m, err } = useStockAction(`/parts/${p.id}/restock`, "Restocked", onDone, onClose);
  const target = p.stock.length ? locId(loc) : newLoc;
  return (
    <Modal title={`Restock ${p.name}`} onClose={onClose}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!n || m.isPending}
        onClick={() => m.mutate({ location_id: target, quantity: n, unit_cost: can("costs.view") && cost !== "" ? cost : undefined, note })}>Restock</Button></>}>
      {p.stock.length ? <LocationSelect p={p} value={loc} onChange={setLoc} />
        : <Field label="Location">{() => <LocationPicker value={newLoc} onChange={setNewLoc} placeholder="No location" />}</Field>}
      <div className="part-grid2">
        <Field label={`Quantity added${p.unit !== "each" ? ` (${p.unit})` : ""}`}>{(id) => <Input id={id} autoFocus inputMode="decimal" value={n} onChange={(e) => setN(e.target.value)} />}</Field>
        {can("costs.view") && <Field label="Unit cost">{(id) => <Input id={id} inputMode="decimal" value={cost} onChange={(e) => setCost(e.target.value)} />}</Field>}
      </div>
      <Field label="Note">{(id) => <Input id={id} value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} placeholder="Where it came from (optional)" />}</Field>
      {err && <div className="banner warning" role="alert">{err}</div>}
    </Modal>
  );
}

export function AdjustDialog({ p, stock, onClose, onDone }: Props) {
  const [loc, setLoc] = useState(stock ? locKey(stock) : p.stock[0] ? locKey(p.stock[0]) : "none");
  const cur = p.stock.find((s) => locKey(s) === loc);
  const [n, setN] = useState(cur?.on_hand ?? "");
  const [note, setNote] = useState("");
  const { m, err } = useStockAction(`/parts/${p.id}/adjust`, "Quantity updated", onDone, onClose);
  const change = cur && n !== "" ? Number(n) - Number(cur.on_hand) : 0;
  return (
    <Modal title={`Adjust ${p.name}`} onClose={onClose}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={n === "" || !change || (change < 0 && !note.trim()) || m.isPending}
        onClick={() => m.mutate({ location_id: locId(loc), quantity: n, note })}>Save</Button></>}>
      {p.stock.length === 0 ? <p className="small muted">Add a stocking location first.</p> : <>
        <LocationSelect p={p} value={loc} onChange={(v) => { setLoc(v); setN(p.stock.find((s) => locKey(s) === v)?.on_hand ?? ""); }} />
        <Field label="Quantity in stock" hint={change ? `${change > 0 ? "+" : ""}${Number(change.toFixed(4))} ${p.unit}` : "Enter what's really on the shelf."}>{(id) =>
          <Input id={id} autoFocus inputMode="decimal" value={n} onChange={(e) => setN(e.target.value)} />}</Field>
        <Field label={change < 0 ? "Reason (needed when removing)" : "Reason"}>{(id) => <Input id={id} value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Damaged, found extra, recount" />}</Field>
      </>}
      {err && <div className="banner warning" role="alert">{err}</div>}
    </Modal>
  );
}

export function TransferDialog({ p, stock, onClose, onDone }: Props) {
  const [from, setFrom] = useState(stock ? locKey(stock) : p.stock[0] ? locKey(p.stock[0]) : "none");
  const [to, setTo] = useState<string | null>(p.stock.find((s) => locKey(s) !== from)?.location?.id ?? null);
  const [n, setN] = useState("");
  const [note, setNote] = useState("");
  const { m, err } = useStockAction(`/parts/${p.id}/transfer`, "Moved", onDone, onClose);
  return (
    <Modal title={`Move ${p.name}`} onClose={onClose}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!n || (to ?? "none") === from || m.isPending}
        onClick={() => m.mutate({ from_location_id: locId(from), to_location_id: to, quantity: n, note })}>Move</Button></>}>
      <LocationSelect p={p} value={from} onChange={setFrom} label="From" />
      <Field label="To" hint="A new location starts with no minimum or maximum.">{() => <LocationPicker value={to} onChange={setTo} placeholder="No location" />}</Field>
      <Field label="Quantity">{(id) => <Input id={id} autoFocus inputMode="decimal" value={n} onChange={(e) => setN(e.target.value)} />}</Field>
      <Field label="Note">{(id) => <Input id={id} value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} />}</Field>
      {err && <div className="banner warning" role="alert">{err}</div>}
    </Modal>
  );
}

export function LocationDialog({ p, stock, onClose, onDone }: Props) {
  const { can } = useSession();
  const { toast } = useToast();
  const [loc, setLoc] = useState<string | null>(stock?.location?.id ?? null);
  const [area, setArea] = useState(stock?.area ?? "");
  const [min, setMin] = useState(stock?.min_qty ?? "");
  const [max, setMax] = useState(stock?.max_qty ?? "");
  const [initial, setInitial] = useState("");
  const [err, setErr] = useState("");
  const save = useMutation({
    mutationFn: () => api(`/parts/${p.id}/stock`, { method: "PUT", body: { location_id: loc, area, min_qty: min || null, max_qty: max || null, initial_quantity: stock ? undefined : initial || undefined } }),
    onSuccess: () => { toast("Saved"); onDone(); onClose(); },
    onError: (e) => setErr((e as ApiError).message),
  });
  const remove = useMutation({
    mutationFn: () => api(`/parts/${p.id}/stock?location_id=${stock?.location?.id ?? "none"}`, { method: "DELETE" }),
    onSuccess: () => { toast("Location removed"); onDone(); onClose(); },
    onError: (e) => setErr((e as ApiError).message),
  });
  return (
    <Modal title={stock ? `${stock.location?.name ?? "No location"}` : "Add a stocking location"} onClose={onClose}
      footer={<>{stock && <Button variant="danger" disabled={remove.isPending} onClick={() => remove.mutate()} style={{ marginRight: "auto" }}>Remove</Button>}
        <Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={save.isPending} onClick={() => save.mutate()}>Save</Button></>}>
      {!stock && <Field label="Location">{() => <LocationPicker value={loc} onChange={setLoc} placeholder="No location" />}</Field>}
      <Field label="Area or bin">{(id) => <Input id={id} value={area} maxLength={120} onChange={(e) => setArea(e.target.value)} placeholder="e.g. Aisle 3 / Bin 12" />}</Field>
      <div className="part-grid2">
        <Field label="Minimum" hint="Below this, the part needs restocking.">{(id) => <Input id={id} inputMode="decimal" value={min} onChange={(e) => setMin(e.target.value)} />}</Field>
        <Field label="Maximum" hint="Orders fill up to this.">{(id) => <Input id={id} inputMode="decimal" value={max} onChange={(e) => setMax(e.target.value)} />}</Field>
      </div>
      {!stock && can("parts.stock") && <Field label="Quantity in stock now">{(id) => <Input id={id} inputMode="decimal" value={initial} onChange={(e) => setInitial(e.target.value)} />}</Field>}
      {stock && <p className="small faint">A location can only be removed when nothing is in stock or reserved there.</p>}
      {err && <div className="banner warning" role="alert">{err}</div>}
    </Modal>
  );
}
