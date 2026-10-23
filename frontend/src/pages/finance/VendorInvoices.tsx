// Vendor invoices (MP-092): upload or email in, read, 3-way match against the purchase order and what was received,
// work the exceptions queue, approve (purchasing approval rules, applies_to vendor_invoice), pay.
// Statuses: Received → Matched → Approved → Paid, plus Disputed and Void.
import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, ArrowLeft, Copy, FileUp, Mail, Plus, RefreshCw, Search, Trash2 } from "lucide-react";
import { api, ApiError } from "../../lib/api";
import { useToast } from "../../components/Toast";
import { Button, Checkbox, EmptyState, Field, Input, ListSkeleton, Modal, Pill, Select } from "../../components/ui";
import { readPages } from "./capture";
import { day, money, postForm, todayISO, VI_STATUS, type FinanceMe, type Paged, type VendorInvoice } from "./types";

const FILTERS: [string, string][] = [["exceptions", "Exceptions"], ["unpaid", "To pay"], ["overdue", "Overdue"], ["paid", "Paid"],
  ["disputed", "Disputed"], ["", "All"]];
type VendorLite = { id: string; name: string };
type POLite = { id: string; display_number: string; title: string; total: string; vendor: { id: string; name: string } | null };
type LineIn = { description: string; part_number: string; quantity: string; unit_price: string };

export const useVendors = () => useQuery({ queryKey: ["vendors", "lite"], staleTime: 30_000,
  queryFn: () => api<{ items: VendorLite[] }>("/vendors?per_page=500&sort=name") });

export function VendorInvoicesTab({ me, id }: { me: FinanceMe; id?: string }) {
  const [filter, setFilter] = useState(() => { try { return sessionStorage.getItem("finance.vi") ?? "exceptions"; } catch { return "exceptions"; } });
  const [q, setQ] = useState("");
  const [adding, setAdding] = useState(false);
  const nav = useNavigate();
  const { toast } = useToast();
  useEffect(() => { try { sessionStorage.setItem("finance.vi", filter); } catch { /* private mode */ } }, [filter]);
  const params = new URLSearchParams({ per_page: "100" });
  if (filter) params.set("status", filter);
  if (q.trim()) params.set("q", q.trim());
  const list = useQuery({ queryKey: ["finance", "vendor-invoices", params.toString()], queryFn: () => api<Paged<VendorInvoice>>(`/finance/vendor-invoices?${params}`) });
  return (
    <div className={"split fin-split" + (id ? " has-detail" : "")}>
      <div className="split-list">
        <div className="list-tools">
          <div className="row" style={{ justifyContent: "space-between" }}>
            <h1>Vendor invoices</h1>
            {me.can["finance.invoices"] && <Button variant="primary" onClick={() => setAdding(true)}><Plus size={16} />New</Button>}
          </div>
          {me.invoices_address && <button type="button" className="fin-email" onClick={() => { void navigator.clipboard?.writeText(me.invoices_address); toast("Address copied"); }}>
            <Mail size={14} /><span className="grow">{me.invoices_address}</span><Copy size={13} /></button>}
          <div className="seg fin-seg" role="tablist" aria-label="Filter">
            {FILTERS.map(([k, l]) => <button key={k} type="button" role="tab" aria-selected={filter === k} className={"seg-btn" + (filter === k ? " on" : "")}
              onClick={() => setFilter(k)}>{l}</button>)}
          </div>
          <div className="search-in"><Search size={15} className="faint" /><Input placeholder="Invoice number" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search invoices" /></div>
        </div>
        <div className="list" aria-label="Vendor invoices">
          {list.isLoading ? <ListSkeleton /> : !list.data?.items.length
            ? <EmptyState title={filter === "exceptions" ? "No exceptions" : "No invoices here"}>{filter === "exceptions" ? "Every invoice matches its purchase order." : "Upload a vendor invoice or email it in."}</EmptyState>
            : list.data.items.map((inv) => {
              const [label, tone] = VI_STATUS[inv.status];
              return (
                <Link key={inv.id} to={`/finance/vendor-invoices/${inv.id}`} className={"list-row" + (inv.id === id ? " active" : "")}>
                  <div className="grow">
                    <div className="t">{inv.vendor?.name ?? "Vendor?"} · {inv.number || "no number"}</div>
                    <div className="s">{inv.due_date ? `Due ${day(inv.due_date)}` : day(inv.invoice_date || inv.created_at)}{inv.purchase_orders.length ? ` · ${inv.purchase_orders.map((p) => p.number).join(", ")}` : ""}</div>
                    <div className="row wrap fin-pills"><Pill tone={tone}>{label}</Pill>
                      {inv.overdue && <Pill tone="danger">Overdue</Pill>}
                      {inv.exceptions.length > 0 && inv.status === "received" && <Pill tone="warning">{inv.exceptions.length} exception{inv.exceptions.length > 1 ? "s" : ""}</Pill>}</div>
                  </div>
                  <div className="fin-amt">{money(inv.total, inv.currency)}</div>
                </Link>
              );
            })}
        </div>
      </div>
      <div className="split-detail">
        {id ? <InvoiceDetail id={id} me={me} onBack={() => nav("/finance/vendor-invoices")} /> : <EmptyState title="Pick an invoice">The exceptions queue lists invoices that don't match their purchase order.</EmptyState>}
      </div>
      {adding && <NewInvoice onClose={() => setAdding(false)} onSaved={(inv) => { setAdding(false); nav(`/finance/vendor-invoices/${inv.id}`); }} />}
    </div>
  );
}

function NewInvoice({ onClose, onSaved }: { onClose: () => void; onSaved: (inv: VendorInvoice) => void }) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState("");
  const vendors = useVendors();
  const [f, setF] = useState({ vendor_id: "", number: "", invoice_date: todayISO(), terms: "", tax: "", shipping: "" });
  const [poIds, setPoIds] = useState<string[]>([]);
  const [lines, setLines] = useState<LineIn[]>([]);
  const pos = useQuery({ queryKey: ["finance", "pos-for", f.vendor_id], enabled: !!f.vendor_id,
    queryFn: () => api<Paged<POLite>>(`/purchase-orders?vendor_id=${f.vendor_id}&status=approved,partially_fulfilled,complete&per_page=50`) });
  const save = useMutation({
    mutationFn: async () => {
      const fields: Record<string, unknown> = { ...f, purchase_order_ids: poIds };
      if (!f.vendor_id) delete fields.vendor_id;
      if (lines.length) fields.lines = lines;
      for (const k of ["tax", "shipping", "terms", "number"] as const) if (!f[k]) delete fields[k];
      if (!file) return api<VendorInvoice>("/finance/vendor-invoices", { method: "POST", body: fields });
      let text = "";
      if (file.type.startsWith("image/")) {
        setBusy("Reading…");
        try { text = await readPages([file]); } catch { /* type it in */ }
      }
      setBusy("Uploading…");
      return postForm<VendorInvoice>("/finance/vendor-invoices", { file, ocr_text: text || undefined, fields: JSON.stringify(fields) });
    },
    onSuccess: (inv) => { void qc.invalidateQueries({ queryKey: ["finance"] }); toast(inv.exceptions.length ? "Saved — it has exceptions to check" : "Saved and matched"); onSaved(inv); },
    onError: (e) => { setBusy(""); toast((e as ApiError).message, { kind: "error" }); },
  });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }));
  return (
    <Modal title="New vendor invoice" onClose={onClose} width={640} footer={<><Button onClick={onClose}>Cancel</Button>
      <Button variant="primary" disabled={!!busy || (!file && !f.vendor_id)} onClick={() => save.mutate()}>{busy || "Save"}</Button></>}>
      <div className="stack">
        <label className="fin-drop">
          <FileUp size={20} /><span className="grow">{file ? file.name : "Upload the invoice (PDF or picture). We read the number, dates, PO and totals."}</span>
          <input type="file" accept="application/pdf,image/*" hidden onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        </label>
        <div className="fin-form-grid">
          <Field label="Vendor">{(fid) => <Select id={fid} value={f.vendor_id} onChange={(e) => { set("vendor_id")(e); setPoIds([]); }}>
            <option value="">{file ? "From the invoice" : "Pick a vendor"}</option>{vendors.data?.items.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}</Select>}</Field>
          <Field label="Invoice number">{(fid) => <Input id={fid} value={f.number} onChange={set("number")} />}</Field>
          <Field label="Invoice date">{(fid) => <Input id={fid} type="date" value={f.invoice_date} onChange={set("invoice_date")} />}</Field>
          <Field label="Terms" hint='e.g. "Net 30" or "2/10 net 30"'>{(fid) => <Input id={fid} value={f.terms} onChange={set("terms")} />}</Field>
          <Field label="Tax">{(fid) => <Input id={fid} inputMode="decimal" value={f.tax} onChange={set("tax")} />}</Field>
          <Field label="Shipping">{(fid) => <Input id={fid} inputMode="decimal" value={f.shipping} onChange={set("shipping")} />}</Field>
        </div>
        {!!pos.data?.items.length && <div className="stack fin-tight"><span className="fin-label">Purchase orders</span>
          <div className="fin-chips">{pos.data.items.map((p) => <button key={p.id} type="button" className={"fin-chip" + (poIds.includes(p.id) ? " on" : "")}
            onClick={() => setPoIds((x) => x.includes(p.id) ? x.filter((y) => y !== p.id) : [...x, p.id])}>{p.display_number} · {p.title}</button>)}</div></div>}
        <LinesEditor lines={lines} onChange={setLines} />
      </div>
    </Modal>
  );
}

function LinesEditor({ lines, onChange }: { lines: LineIn[]; onChange: (l: LineIn[]) => void }) {
  const upd = (i: number, k: keyof LineIn, v: string) => onChange(lines.map((l, j) => (j === i ? { ...l, [k]: v } : l)));
  return (
    <div className="stack fin-tight">
      <span className="fin-label">Lines</span>
      {lines.map((l, i) => (
        <div key={i} className="fin-line">
          <Input placeholder="Description" value={l.description} onChange={(e) => upd(i, "description", e.target.value)} aria-label="Description" />
          <Input placeholder="Part #" value={l.part_number} onChange={(e) => upd(i, "part_number", e.target.value)} aria-label="Part number" />
          <Input placeholder="Qty" inputMode="decimal" value={l.quantity} onChange={(e) => upd(i, "quantity", e.target.value)} aria-label="Quantity" />
          <Input placeholder="Unit price" inputMode="decimal" value={l.unit_price} onChange={(e) => upd(i, "unit_price", e.target.value)} aria-label="Unit price" />
          <Button icon aria-label="Remove line" onClick={() => onChange(lines.filter((_, j) => j !== i))}><Trash2 size={15} /></Button>
        </div>
      ))}
      <div><Button size="sm" onClick={() => onChange([...lines, { description: "", part_number: "", quantity: "1", unit_price: "" }])}><Plus size={14} />Add line</Button></div>
    </div>
  );
}

function InvoiceDetail({ id, me, onBack }: { id: string; me: FinanceMe; onBack: () => void }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const q = useQuery({ queryKey: ["finance", "vendor-invoice", id], queryFn: () => api<VendorInvoice>(`/finance/vendor-invoices/${id}`) });
  const [override, setOverride] = useState(false);
  const [pay, setPay] = useState(false);
  const [dispute, setDispute] = useState(false);
  const [editLines, setEditLines] = useState<LineIn[] | null>(null);
  const done = (x: VendorInvoice, msg?: string) => { qc.setQueryData(["finance", "vendor-invoice", id], x); void qc.invalidateQueries({ queryKey: ["finance", "vendor-invoices"] });
    void qc.invalidateQueries({ queryKey: ["finance", "summary"] }); if (msg) toast(msg); };
  const err = (e: unknown) => toast((e as ApiError).message, { kind: "error" });
  const act = useMutation({ mutationFn: ({ path, body }: { path: string; body?: unknown }) => api<VendorInvoice>(`/finance/vendor-invoices/${id}/${path}`, { method: "POST", body: body ?? {} }),
    onSuccess: (x) => done(x), onError: err });
  const patch = useMutation({ mutationFn: (body: unknown) => api<VendorInvoice>(`/finance/vendor-invoices/${id}`, { method: "PATCH", body }),
    onSuccess: (x) => { setEditLines(null); done(x, "Saved"); }, onError: err });
  const del = useMutation({ mutationFn: () => api(`/finance/vendor-invoices/${id}`, { method: "DELETE" }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ["finance"] }); onBack(); }, onError: err });
  const inv = q.data;
  if (q.isLoading) return <div className="detail"><ListSkeleton rows={4} /></div>;
  if (!inv) return <div className="detail"><EmptyState title="Invoice not found" /></div>;
  const [label, tone] = VI_STATUS[inv.status];
  const writer = me.can["finance.invoices"];
  const approver = me.can["finance.invoices.approve"];
  const open = inv.status === "received" || inv.status === "matched";
  const pending = (inv.approvals ?? []).some((a) => a.status === "pending");
  return (
    <div className="detail fin-detail">
      <div className="detail-head">
        <Button icon className="fin-back" aria-label="Back" onClick={onBack}><ArrowLeft size={18} /></Button>
        <div className="grow"><h2>{inv.vendor?.name ?? "Vendor?"} · {inv.number || "no number"}</h2>
          <div className="muted fin-small">{inv.invoice_date ? `Invoiced ${day(inv.invoice_date)}` : "No invoice date"}{inv.due_date ? ` · due ${day(inv.due_date)}` : ""}
            {inv.terms ? ` · ${inv.terms}` : ""}{inv.discount_until ? ` · ${Number(inv.discount_pct)}% off if paid by ${day(inv.discount_until)}` : ""}</div></div>
        <Pill tone={tone}>{label}</Pill>
        {writer && !inv.locked && <Button icon aria-label="Delete invoice" onClick={() => { if (confirm("Delete this invoice?")) del.mutate(); }}><Trash2 size={16} /></Button>}
      </div>
      {inv.exceptions.length > 0 && open && (
        <div className="fin-banner warn stack fin-tight">
          <div className="row"><AlertTriangle size={16} /><strong className="grow">Doesn't match ({inv.exceptions.length})</strong>
            {writer && <Button size="sm" onClick={() => act.mutate({ path: "match" })}><RefreshCw size={14} />Match again</Button>}</div>
          <ul className="fin-exc">{inv.exceptions.map((e, i) => <li key={i}><strong>{e.label}:</strong> {e.message}</li>)}</ul>
        </div>
      )}
      {inv.status === "disputed" && inv.dispute_note && <div className="fin-banner warn"><AlertTriangle size={16} />Disputed: {inv.dispute_note}</div>}
      <div className="row wrap">
        {inv.purchase_orders.map((p) => <Link key={p.id} className="fin-chip" to={`/purchase-orders/${p.id}`}>{p.number}{p.tax_exempt ? " · tax-exempt" : ""}</Link>)}
        {inv.file && <a className="fin-chip" href={inv.file.url} target="_blank" rel="noreferrer"><FileUp size={13} />{inv.file.name}</a>}
      </div>
      <section className="card">
        <div className="table-wrap"><table className="table fin-table">
          <thead><tr><th>Item</th><th className="num">Qty</th><th className="num">Price</th><th className="num">Amount</th><th>PO</th></tr></thead>
          <tbody>{(inv.lines ?? []).map((l) => (
            <tr key={l.id} className={l.match_status && l.match_status !== "ok" ? "fin-bad" : ""}>
              <td>{l.description}{l.part_number ? <span className="faint"> · {l.part_number}</span> : null}</td>
              <td className="num">{Number(l.quantity)}</td><td className="num">{money(l.unit_price, inv.currency)}</td><td className="num">{money(l.amount, inv.currency)}</td>
              <td className="fin-small">{l.po_line ? <>{money(l.po_line.unit_cost, inv.currency)} · received {Number(l.po_line.received)} of {Number(l.po_line.quantity)}</> : <span className="faint">—</span>}</td>
            </tr>))}
            {!inv.lines?.length && <tr><td colSpan={5} className="muted">No lines. Add them to match against the purchase order.</td></tr>}</tbody>
        </table></div>
        <div className="po-totals">
          <div><span>Subtotal</span><span>{money(inv.subtotal, inv.currency)}</span></div>
          <div><span>Tax</span><span>{money(inv.tax, inv.currency)}</span></div>
          {Number(inv.shipping) > 0 && <div><span>Shipping</span><span>{money(inv.shipping, inv.currency)}</span></div>}
          <div className="tot"><span>Total</span><span>{money(inv.total, inv.currency)}</span></div>
          {Number(inv.paid) > 0 && <div><span>Balance</span><span>{money(inv.balance, inv.currency)}</span></div>}
        </div>
      </section>
      {writer && open && !inv.locked && (editLines
        ? <section className="card card-pad stack"><LinesEditor lines={editLines} onChange={setEditLines} />
          <div className="row"><Button onClick={() => setEditLines(null)}>Cancel</Button><Button variant="primary" onClick={() => patch.mutate({ lines: editLines })}>Save lines</Button></div></section>
        : <div><Button size="sm" onClick={() => setEditLines((inv.lines ?? []).map((l) => ({ description: l.description, part_number: l.part_number, quantity: String(Number(l.quantity)), unit_price: l.unit_price })))}>Edit lines</Button></div>)}
      <div className="row wrap fin-actions">
        {open && writer && !pending && <>
          {inv.exceptions.length > 0 && approver && <Checkbox checked={override} onChange={setOverride} label="Approve despite the exceptions" />}
          <Button variant="primary" disabled={inv.exceptions.length > 0 && !override} onClick={() => act.mutate({ path: "submit", body: { override } })}>
            {approver ? "Approve" : "Send for approval"}</Button></>}
        {pending && <><span className="muted grow">Waiting for approval.</span>
          <Button onClick={() => { const c = prompt("Why is it rejected?"); if (c !== null) act.mutate({ path: "decide", body: { approve: false, comment: c } }); }}>Reject</Button>
          <Button variant="primary" onClick={() => act.mutate({ path: "decide", body: { approve: true } })}>Approve</Button></>}
        {writer && inv.status === "approved" && <Button variant="primary" onClick={() => setPay(true)}>Record payment</Button>}
        {writer && !["paid", "void", "disputed"].includes(inv.status) && <Button onClick={() => setDispute(true)}>Dispute</Button>}
        {writer && inv.status === "disputed" && <Button onClick={() => act.mutate({ path: "status", body: { action: "reopen" } })}>Reopen</Button>}
        {writer && inv.status !== "paid" && inv.status !== "void" && <Button variant="ghost" onClick={() => { if (confirm("Void this invoice?")) act.mutate({ path: "status", body: { action: "void" } }); }}>Void</Button>}
      </div>
      {(inv.payments ?? []).length > 0 && <section className="card card-pad"><h3 className="sec-h">Payments</h3>
        {(inv.payments ?? []).map((p) => <div key={p.id} className="row fin-small"><span className="grow">{day(p.paid_on)} · {p.method || "payment"}{p.reference ? ` · ${p.reference}` : ""}</span>{money(p.amount, inv.currency)}</div>)}</section>}
      {pay && <PaymentModal currency={inv.currency} balance={inv.balance} onClose={() => setPay(false)}
        onSave={(body) => act.mutate({ path: "payments", body }, { onSuccess: () => setPay(false) })} />}
      {dispute && <Modal title="Dispute invoice" onClose={() => setDispute(false)} footer={null}>
        <form className="stack" onSubmit={(e) => { e.preventDefault(); const note = String(new FormData(e.currentTarget).get("note") || ""); act.mutate({ path: "status", body: { action: "dispute", note } }, { onSuccess: () => setDispute(false) }); }}>
          <Field label="What's wrong?">{(fid) => <textarea id={fid} name="note" className="input" rows={3} required />}</Field>
          <div className="row"><Button type="submit" variant="primary">Dispute</Button></div></form></Modal>}
    </div>
  );
}

export function PaymentModal({ currency, balance, onClose, onSave }: { currency: string; balance: string; onClose: () => void; onSave: (b: Record<string, string>) => void }) {
  const [f, setF] = useState({ amount: balance, paid_on: todayISO(), method: "ach", reference: "" });
  return (
    <Modal title="Record payment" onClose={onClose} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" onClick={() => onSave(f)}>Save</Button></>}>
      <div className="fin-form-grid">
        <Field label={`Amount (${currency})`}>{(fid) => <Input id={fid} inputMode="decimal" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} />}</Field>
        <Field label="Date">{(fid) => <Input id={fid} type="date" value={f.paid_on} onChange={(e) => setF({ ...f, paid_on: e.target.value })} />}</Field>
        <Field label="Method">{(fid) => <Select id={fid} value={f.method} onChange={(e) => setF({ ...f, method: e.target.value })}>
          {[["ach", "ACH / bank transfer"], ["check", "Check"], ["card", "Card"], ["wire", "Wire"], ["cash", "Cash"], ["other", "Other"]].map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select>}</Field>
        <Field label="Reference">{(fid) => <Input id={fid} value={f.reference} onChange={(e) => setF({ ...f, reference: e.target.value })} />}</Field>
      </div>
    </Modal>
  );
}
