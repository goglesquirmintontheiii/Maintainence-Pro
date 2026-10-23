// Create or edit a purchase order (MP-042): vendor, lines (parts or free text), taxes and additional costs,
// addresses, budget and due date. People who can only request POs get a "Submit request" button.
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Lock, Package, Plus, Trash2 } from "lucide-react";
import { api, ApiError } from "../../lib/api";
import { useSession } from "../../lib/session";
import { currency } from "../../lib/format";
import { Button, Checkbox, Drawer, Field, Input, Select } from "../../components/ui";
import { MultiPicker } from "../../components/pickers";
import { LocationPicker } from "../../components/assetPickers";
import { usePOOptions, type PODetail } from "./types";

type Line = { id?: string; part_id: string | null; part_name?: string; description: string; part_number: string; unit: string; quantity: string;
  unit_cost: string; location_id: string | null; taxable: boolean; locked?: boolean; received?: string };
type Cost = { label: string; kind: "fixed" | "percent"; value: string; is_tax: boolean; taxable: boolean };
type VendorLite = { id: string; name: string; currency: string; contacts: { id: string; name: string; email: string; is_po_contact: boolean }[] };
type PartLite = { id: string; name: string; part_number: string; unit: string; unit_cost: string | null };

export type POPrefill = { vendor_id?: string; part_id?: string; quantity?: string; work_order_id?: string };

const blankLine = (): Line => ({ part_id: null, description: "", part_number: "", unit: "each", quantity: "1", unit_cost: "", location_id: null, taxable: true });

export function useVendorsLite() {
  return useQuery({ queryKey: ["vendors", "lite"], queryFn: () => api<{ items: VendorLite[] }>("/vendors?per_page=500&sort=name"), staleTime: 30_000 });
}

function n(v: string): number { const x = Number(v); return Number.isFinite(x) ? x : 0; }

export function POForm({ edit, prefill, onClose, onSaved }: { edit?: PODetail; prefill?: POPrefill; onClose: () => void; onSaved: (po: PODetail) => void }) {
  const opts = usePOOptions();
  const vendors = useVendorsLite();
  const { session } = useSession();
  const can = opts.data?.can;
  const manager = !!can?.manage;
  const costsVisible = can ? can.costs : true;
  const [vendorId, setVendorId] = useState<string>(edit?.vendor?.id ?? prefill?.vendor_id ?? "");
  const [title, setTitle] = useState(edit?.title ?? "");
  const [customNumber, setCustomNumber] = useState(edit?.custom_number ?? "");
  const [due, setDue] = useState(edit?.due_on ?? "");
  const [notes, setNotes] = useState(edit?.notes ?? "");
  const [contacts, setContacts] = useState<string[]>(edit?.vendor_contact_ids ?? []);
  const [ship, setShip] = useState(edit?.shipping_address?.id ?? "");
  const [bill, setBill] = useState(edit?.billing_address?.id ?? "");
  const [budget, setBudget] = useState(edit?.budget?.budget_id ?? "");
  const [lines, setLines] = useState<Line[]>(() => edit ? edit.lines.map((l) => ({ id: l.id, part_id: l.part?.id ?? null, part_name: l.part?.name, description: l.description,
    part_number: l.part_number, unit: l.unit, quantity: l.quantity, unit_cost: l.unit_cost ?? "", location_id: l.location_id, taxable: l.taxable, locked: l.locked, received: l.received })) : []);
  const [costs, setCosts] = useState<Cost[]>(() => (edit?.costs ?? []).map((c) => ({ label: c.label, kind: c.kind, value: c.value, is_tax: c.is_tax, taxable: c.taxable })));
  const [err, setErr] = useState("");
  const [warnings, setWarnings] = useState<string[]>([]);

  // "Order this part" handoff: /purchase-orders?new=1&part_id=…&vendor_id=…&quantity=…
  const prePart = useQuery({ queryKey: ["part", prefill?.part_id], enabled: !edit && !!prefill?.part_id,
    queryFn: () => api<PartLite & { vendors: { vendor: { id: string }; vendor_part_number: string; unit_cost: string | null; preferred: boolean }[]; stock: { location: { id: string } | null; restock_quantity: string }[] }>(`/parts/${prefill?.part_id}`) });
  useEffect(() => {
    const p = prePart.data;
    if (!p || lines.length) return;
    const pv = p.vendors.find((v) => v.vendor.id === prefill?.vendor_id) ?? p.vendors.find((v) => v.preferred) ?? p.vendors[0];
    if (!vendorId && pv) setVendorId(pv.vendor.id);
    const restock = p.stock.find((s) => Number(s.restock_quantity) > 0);
    setLines([{ part_id: p.id, part_name: p.name, description: p.name, part_number: pv?.vendor_part_number || p.part_number, unit: p.unit,
      quantity: prefill?.quantity || restock?.restock_quantity || "1", unit_cost: pv?.unit_cost ?? p.unit_cost ?? "", location_id: restock?.location?.id ?? null, taxable: true }]);
  }, [prePart.data]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (!edit && !prefill?.part_id && !lines.length) setLines([blankLine()]); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const vendor = vendors.data?.items.find((v) => v.id === vendorId);
  const cur = vendor?.currency || edit?.currency || session.org?.currency || "USD";
  const totals = useMemo(() => {
    const sub = lines.reduce((s, l) => s + n(l.quantity) * n(l.unit_cost), 0);
    let taxable = lines.filter((l) => l.taxable).reduce((s, l) => s + n(l.quantity) * n(l.unit_cost), 0);
    let extra = 0;
    for (const c of costs.filter((c) => !c.is_tax)) { const a = c.kind === "fixed" ? n(c.value) : sub * n(c.value) / 100; extra += a; if (c.taxable) taxable += a; }
    for (const c of costs.filter((c) => c.is_tax)) extra += c.kind === "fixed" ? n(c.value) : taxable * n(c.value) / 100;
    return { sub, total: sub + extra };
  }, [lines, costs]);

  const body = (asRequest: boolean) => ({
    vendor_id: vendorId || null, title, custom_number: customNumber, due_on: due || null, notes, vendor_contact_ids: vendorId ? contacts : [],
    shipping_address_id: ship || null, billing_address_id: bill || null, budget_id: budget || null,
    lines: lines.filter((l) => l.description.trim() || l.part_id).map((l) => ({ id: l.id, part_id: l.part_id, description: l.description, part_number: l.part_number, unit: l.unit,
      quantity: l.quantity, unit_cost: costsVisible ? l.unit_cost : undefined, location_id: l.location_id, taxable: l.taxable })),
    ...(costsVisible ? { costs } : {}),
    ...(edit ? { version: edit.version } : { as_request: asRequest, work_order_id: prefill?.work_order_id }),
  });
  const save = useMutation({
    mutationFn: (asRequest: boolean) => edit ? api<PODetail>(`/purchase-orders/${edit.id}`, { method: "PATCH", body: body(false) }) : api<PODetail>("/purchase-orders", { method: "POST", body: body(asRequest) }),
    onSuccess: (po) => { if (po.warnings?.length) setWarnings(po.warnings); onSaved(po); },
    onError: (e) => setErr((e as ApiError).message),
  });
  const setLine = (i: number, p: Partial<Line>) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...p } : l)));
  const valid = lines.some((l) => l.description.trim() || l.part_id) && lines.every((l) => (!l.description.trim() && !l.part_id) || n(l.quantity) > 0);

  return (
    <Drawer title={edit ? `Edit ${edit.display_number}` : "New Purchase Order"} onClose={onClose} width={760}
      footer={<>
        <span className="grow small muted">{costsVisible && <>Total <b>{currency(totals.total, cur)}</b></>}</span>
        <Button onClick={onClose}>Cancel</Button>
        {!edit && manager && <Button onClick={() => save.mutate(true)} disabled={!valid || save.isPending} title="Save it as a request someone reviews first">Save as request</Button>}
        <Button variant="primary" disabled={!valid || save.isPending} onClick={() => save.mutate(false)}>{edit ? "Save" : manager ? "Create" : "Submit request"}</Button>
      </>}>
      <div className="stack po-form" style={{ gap: 14 }}>
        {!edit && !manager && <div className="banner info">This becomes a request. Someone who manages purchase orders reviews it before it's ordered.</div>}
        <div className="po-form-grid">
          <Field label="Vendor">{(id) => (
            <MultiPicker id={id} single label="Vendor" placeholder="Pick a vendor" value={vendorId ? [vendorId] : []}
              onChange={(v) => { setVendorId(v[0] ?? ""); setContacts([]); }}
              options={(vendors.data?.items ?? []).map((v) => ({ key: v.id, label: v.name }))} />)}</Field>
          <Field label="Title">{(id) => <Input id={id} value={title} maxLength={255} placeholder={opts.data?.settings.default_title || "Purchase Order"} onChange={(e) => setTitle(e.target.value)} />}</Field>
          <Field label="Due date" hint="When you expect it to arrive">{(id) => <Input id={id} type="date" value={due} onChange={(e) => setDue(e.target.value)} />}</Field>
          <Field label="PO number" hint={`Leave empty for the next number (${opts.data?.settings.number_prefix ?? "PO-"}…)`}>{(id) => <Input id={id} value={customNumber} maxLength={60} onChange={(e) => setCustomNumber(e.target.value)} />}</Field>
        </div>
        {vendor && vendor.contacts.length > 0 && <Field label="Send to" hint="Leave empty to use the vendor's purchase order contact">{(id) => (
          <MultiPicker id={id} label="Vendor contacts" placeholder="Purchase order contact" value={contacts} onChange={setContacts}
            options={vendor.contacts.map((c) => ({ key: c.id, label: c.name, sub: c.email + (c.is_po_contact ? " · PO contact" : "") }))} />)}</Field>}

        <section>
          <h3 className="sec-h">Items</h3>
          <div className="po-lines">
            {lines.map((l, i) => <LineEditor key={l.id ?? `n${i}`} l={l} costs={costsVisible} cur={cur} onChange={(p) => setLine(i, p)}
              onRemove={l.locked ? undefined : () => setLines((ls) => ls.filter((_, j) => j !== i))} />)}
          </div>
          <Button size="sm" variant="ghost" onClick={() => setLines((ls) => [...ls, blankLine()])}><Plus size={14} />Add item</Button>
        </section>

        {costsVisible && <section>
          <h3 className="sec-h">Taxes and additional costs</h3>
          {costs.map((c, i) => (
            <div key={i} className="po-cost-row">
              <Input aria-label="Label" value={c.label} placeholder={c.is_tax ? "Sales tax" : "Shipping"} onChange={(e) => setCosts((cs) => cs.map((x, j) => j === i ? { ...x, label: e.target.value } : x))} />
              <Select aria-label="Type" value={`${c.is_tax ? "tax" : "cost"}`} onChange={(e) => setCosts((cs) => cs.map((x, j) => j === i ? { ...x, is_tax: e.target.value === "tax", taxable: e.target.value === "tax" ? false : x.taxable } : x))}>
                <option value="cost">Additional cost</option><option value="tax">Tax</option></Select>
              <Select aria-label="Fixed or percent" value={c.kind} onChange={(e) => setCosts((cs) => cs.map((x, j) => j === i ? { ...x, kind: e.target.value as Cost["kind"] } : x))}>
                <option value="fixed">{cur}</option><option value="percent">%</option></Select>
              <Input aria-label="Amount" inputMode="decimal" value={c.value} onChange={(e) => setCosts((cs) => cs.map((x, j) => j === i ? { ...x, value: e.target.value } : x))} />
              {!c.is_tax ? <Checkbox checked={c.taxable} onChange={(v) => setCosts((cs) => cs.map((x, j) => j === i ? { ...x, taxable: v } : x))} label="Taxed" /> : <span />}
              <Button size="sm" variant="ghost" icon aria-label="Remove" onClick={() => setCosts((cs) => cs.filter((_, j) => j !== i))}><Trash2 size={14} /></Button>
            </div>))}
          <div className="row" style={{ gap: 6 }}>
            <Button size="sm" variant="ghost" onClick={() => setCosts((cs) => [...cs, { label: "Sales tax", kind: "percent", value: "", is_tax: true, taxable: false }])}><Plus size={14} />Tax</Button>
            <Button size="sm" variant="ghost" onClick={() => setCosts((cs) => [...cs, { label: "Shipping", kind: "fixed", value: "", is_tax: false, taxable: false }])}><Plus size={14} />Additional cost</Button>
          </div>
          <div className="po-sum"><span>Subtotal</span><b>{currency(totals.sub, cur)}</b><span>Total</span><b>{currency(totals.total, cur)}</b></div>
        </section>}

        <div className="po-form-grid">
          <Field label="Ship to">{(id) => <Select id={id} value={ship} onChange={(e) => setShip(e.target.value)}><option value="">Default</option>
            {(opts.data?.addresses ?? []).filter((a) => a.kind !== "billing").map((a) => <option key={a.id} value={a.id}>{a.label || a.line1}</option>)}</Select>}</Field>
          {!opts.data?.settings.single_address && <Field label="Bill to">{(id) => <Select id={id} value={bill} onChange={(e) => setBill(e.target.value)}><option value="">Default</option>
            {(opts.data?.addresses ?? []).filter((a) => a.kind !== "shipping").map((a) => <option key={a.id} value={a.id}>{a.label || a.line1}</option>)}</Select>}</Field>}
          {(opts.data?.budgets ?? []).length > 0 && <Field label="Budget">{(id) => <Select id={id} value={budget} onChange={(e) => setBudget(e.target.value)}><option value="">None</option>
            {(opts.data?.budgets ?? []).map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</Select>}</Field>}
        </div>
        <Field label="Notes" hint="Printed on the purchase order">{(id) => <textarea id={id} className="input" rows={3} value={notes} maxLength={4096} onChange={(e) => setNotes(e.target.value)} />}</Field>
        {warnings.map((w) => <div key={w} className="banner warning">{w}</div>)}
        {err && <div className="banner warning" role="alert">{err}</div>}
      </div>
    </Drawer>
  );
}

function LineEditor({ l, costs, cur, onChange, onRemove }: { l: Line; costs: boolean; cur: string; onChange: (p: Partial<Line>) => void; onRemove?: () => void }) {
  const [search, setSearch] = useState("");
  const parts = useQuery({ queryKey: ["parts", "po-pick", search], enabled: search.length > 0,
    queryFn: () => api<{ items: PartLite[] }>(`/parts?per_page=8&q=${encodeURIComponent(search)}`) });
  return (
    <div className={"po-line" + (l.locked ? " locked" : "")}>
      <div className="po-line-main">
        {l.part_id ? <div className="row" style={{ gap: 6 }}><Package size={15} className="faint" /><span className="grow t">{l.part_name ?? l.description}</span>
          {!l.locked && <button type="button" className="linkbtn small" onClick={() => onChange({ part_id: null, part_name: undefined })}>Unlink part</button>}</div>
          : <div className="po-part-search">
            <Input aria-label="Item" placeholder="Search parts or type an item" value={l.description} disabled={l.locked}
              onChange={(e) => { onChange({ description: e.target.value }); setSearch(e.target.value.trim()); }} onBlur={() => setTimeout(() => setSearch(""), 150)} />
            {search && (parts.data?.items ?? []).length > 0 && <div className="menu po-part-menu" role="listbox" aria-label="Parts">
              {(parts.data?.items ?? []).map((p) => <button type="button" key={p.id} className="menu-item" role="option" aria-selected={false}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => { onChange({ part_id: p.id, part_name: p.name, description: p.name, part_number: p.part_number, unit: p.unit, unit_cost: p.unit_cost ?? l.unit_cost }); setSearch(""); }}>
                <Package size={14} /><span className="grow">{p.name}{p.part_number && <span className="small faint"> · {p.part_number}</span>}</span></button>)}
            </div>}
          </div>}
        {l.locked && <span className="small faint row" style={{ gap: 4 }}><Lock size={12} />{l.received} received — this line can't change</span>}
      </div>
      <div className="po-line-fields">
        <Input aria-label="Part number" placeholder="Part #" value={l.part_number} disabled={l.locked} onChange={(e) => onChange({ part_number: e.target.value })} />
        <Input aria-label="Quantity" inputMode="decimal" value={l.quantity} disabled={l.locked} onChange={(e) => onChange({ quantity: e.target.value })} />
        <Input aria-label="Unit" value={l.unit} disabled={l.locked} onChange={(e) => onChange({ unit: e.target.value })} />
        {costs && <Input aria-label={`Unit cost (${cur})`} placeholder="Unit cost" inputMode="decimal" value={l.unit_cost} disabled={l.locked} onChange={(e) => onChange({ unit_cost: e.target.value })} />}
        {costs && <span className="po-line-amt">{currency(n(l.quantity) * n(l.unit_cost), cur)}</span>}
        {onRemove ? <Button size="sm" variant="ghost" icon aria-label="Remove item" onClick={onRemove}><Trash2 size={14} /></Button> : <span />}
      </div>
      {l.part_id && !l.locked && <div className="po-line-loc"><span className="small muted">Receive into</span>
        <LocationPicker value={l.location_id} onChange={(v) => onChange({ location_id: v })} placeholder="Part's main location" />
        <Checkbox checked={l.taxable} onChange={(v) => onChange({ taxable: v })} label="Taxed" /></div>}
      {!l.part_id && !l.locked && <div className="po-line-loc"><Checkbox checked={l.taxable} onChange={(v) => onChange({ taxable: v })} label="Taxed" /></div>}
    </div>
  );
}
