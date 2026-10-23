// Customer invoices (MP-093): bill one or several completed work orders — labour at the customer's billing rate,
// parts with the markup, other costs — with tax by the customer's location (none when their exemption certificate
// is on file). Draft → Sent (numbered PDF, emailed, read-only) → Partially paid / Paid / Overdue; credit notes,
// statements. Online payment links are an MPro Cloud feature.
import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, ExternalLink, FileText, Plus, Search, Send, Trash2 } from "lucide-react";
import { api, ApiError } from "../../lib/api";
import { useToast } from "../../components/Toast";
import { Button, Checkbox, EmptyState, Field, Input, ListSkeleton, Modal, Pill, Select } from "../../components/ui";
import { PaymentModal } from "./VendorInvoices";
import { CI_STATUS, day, money, type CILine, type CustomerInvoice, type FinanceMe, type Paged } from "./types";

const FILTERS: [string, string][] = [["", "All"], ["draft", "Drafts"], ["sent,partially_paid", "Open"], ["overdue", "Overdue"], ["paid", "Paid"]];
type CustomerLite = { id: string; name: string };

const useCustomers = () => useQuery({ queryKey: ["customers", "lite"], staleTime: 30_000,
  queryFn: () => api<{ items: CustomerLite[] }>("/customers?per_page=500") });

export function CustomerInvoicesTab({ me, id }: { me: FinanceMe; id?: string }) {
  const [filter, setFilter] = useState("");
  const [q, setQ] = useState("");
  const [adding, setAdding] = useState(false);
  const nav = useNavigate();
  const params = new URLSearchParams({ per_page: "100" });
  if (filter) params.set("status", filter);
  const list = useQuery({ queryKey: ["finance", "customer-invoices", params.toString()], queryFn: () => api<Paged<CustomerInvoice>>(`/finance/customer-invoices?${params}`) });
  const items = (list.data?.items ?? []).filter((i) => !q.trim() || `${i.label} ${i.customer?.name ?? ""}`.toLowerCase().includes(q.trim().toLowerCase()));
  return (
    <div className={"split fin-split" + (id ? " has-detail" : "")}>
      <div className="split-list">
        <div className="list-tools">
          <div className="row" style={{ justifyContent: "space-between" }}>
            <h1>Customer invoices</h1>
            {me.can["finance.customer_invoices"] && <Button variant="primary" onClick={() => setAdding(true)}><Plus size={16} />New</Button>}
          </div>
          <div className="seg fin-seg" role="tablist" aria-label="Filter">
            {FILTERS.map(([k, l]) => <button key={k} type="button" role="tab" aria-selected={filter === k} className={"seg-btn" + (filter === k ? " on" : "")} onClick={() => setFilter(k)}>{l}</button>)}
          </div>
          <div className="search-in"><Search size={15} className="faint" /><Input placeholder="Number or customer" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search invoices" /></div>
        </div>
        <div className="list" aria-label="Customer invoices">
          {list.isLoading ? <ListSkeleton /> : !items.length ? <EmptyState title="No invoices">Bill completed work orders to your customers.</EmptyState>
            : items.map((ci) => {
              const [label, tone] = CI_STATUS[ci.status];
              return (
                <Link key={ci.id} to={`/finance/customer-invoices/${ci.id}`} className={"list-row" + (ci.id === id ? " active" : "")}>
                  <div className="grow">
                    <div className="t">{ci.label} · {ci.customer?.name ?? ""}</div>
                    <div className="s">{ci.kind === "credit_note" ? "Credit note" : ci.due_date ? `Due ${day(ci.due_date)}` : "Not sent"}{Number(ci.balance) > 0 && ci.status !== "draft" ? ` · ${money(ci.balance, ci.currency)} due` : ""}</div>
                    <div className="row wrap fin-pills"><Pill tone={tone}>{label}</Pill>{ci.tax_exempt && <Pill>Tax-exempt</Pill>}</div>
                  </div>
                  <div className="fin-amt">{money(ci.kind === "credit_note" ? `-${ci.total}` : ci.total, ci.currency)}</div>
                </Link>
              );
            })}
        </div>
      </div>
      <div className="split-detail">
        {id ? <InvoiceDetail id={id} me={me} onBack={() => nav("/finance/customer-invoices")} /> : <EmptyState title="Pick an invoice" />}
      </div>
      {adding && <NewInvoice onClose={() => setAdding(false)} onSaved={(ci) => { setAdding(false); nav(`/finance/customer-invoices/${ci.id}`); }} />}
    </div>
  );
}

function NewInvoice({ onClose, onSaved }: { onClose: () => void; onSaved: (ci: CustomerInvoice) => void }) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const customers = useCustomers();
  const [cust, setCust] = useState("");
  const [wos, setWos] = useState<string[]>([]);
  const [inc, setInc] = useState({ labor: true, parts: true, costs: true });
  const billable = useQuery({ queryKey: ["finance", "billable", cust], enabled: !!cust,
    queryFn: () => api<{ items: { id: string; number: number; title: string }[] }>(`/finance/billable-work-orders?customer_id=${cust}`) });
  useEffect(() => { setWos(billable.data?.items.map((w) => w.id) ?? []); }, [billable.data]);
  const save = useMutation({ mutationFn: () => api<CustomerInvoice>("/finance/customer-invoices", { method: "POST", body: { customer_id: cust, work_order_ids: wos, include: inc } }),
    onSuccess: (ci) => { void qc.invalidateQueries({ queryKey: ["finance"] }); onSaved(ci); }, onError: (e) => toast((e as ApiError).message, { kind: "error" }) });
  return (
    <Modal title="New customer invoice" onClose={onClose} width={560} footer={<><Button onClick={onClose}>Cancel</Button>
      <Button variant="primary" disabled={!cust || save.isPending} onClick={() => save.mutate()}>Create draft</Button></>}>
      <div className="stack">
        <Field label="Customer">{(fid) => <Select id={fid} value={cust} onChange={(e) => setCust(e.target.value)}><option value="">Pick a customer</option>
          {customers.data?.items.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select>}</Field>
        {cust && <div className="stack fin-tight"><span className="fin-label">Completed work orders not billed yet</span>
          {billable.isLoading ? <ListSkeleton rows={2} /> : billable.data?.items.length
            ? billable.data.items.map((w) => <Checkbox key={w.id} checked={wos.includes(w.id)} label={`#${w.number} ${w.title}`}
              onChange={(v) => setWos((x) => (v ? [...x, w.id] : x.filter((y) => y !== w.id)))} />)
            : <p className="muted">None. You can still create the invoice and add lines yourself.</p>}</div>}
        {wos.length > 0 && <div className="row wrap">
          <Checkbox checked={inc.labor} onChange={(v) => setInc({ ...inc, labor: v })} label="Labour" />
          <Checkbox checked={inc.parts} onChange={(v) => setInc({ ...inc, parts: v })} label="Parts" />
          <Checkbox checked={inc.costs} onChange={(v) => setInc({ ...inc, costs: v })} label="Other costs" /></div>}
      </div>
    </Modal>
  );
}

function InvoiceDetail({ id, me, onBack }: { id: string; me: FinanceMe; onBack: () => void }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const nav = useNavigate();
  const q = useQuery({ queryKey: ["finance", "customer-invoice", id], queryFn: () => api<CustomerInvoice>(`/finance/customer-invoices/${id}`) });
  const [lines, setLines] = useState<CILine[] | null>(null);
  const [pay, setPay] = useState(false);
  const [send, setSend] = useState(false);
  const done = (x: CustomerInvoice, msg?: string) => { qc.setQueryData(["finance", "customer-invoice", x.id], x); void qc.invalidateQueries({ queryKey: ["finance", "customer-invoices"] });
    void qc.invalidateQueries({ queryKey: ["finance", "summary"] }); if (msg) toast(msg); };
  const err = (e: unknown) => toast((e as ApiError).message, { kind: "error" });
  const act = useMutation({ mutationFn: ({ path, body }: { path: string; body?: unknown }) => api<CustomerInvoice>(`/finance/customer-invoices/${id}/${path}`, { method: "POST", body: body ?? {} }),
    onError: err });
  const patch = useMutation({ mutationFn: (body: unknown) => api<CustomerInvoice>(`/finance/customer-invoices/${id}`, { method: "PATCH", body }),
    onSuccess: (x) => { setLines(null); done(x, "Saved"); }, onError: err });
  const del = useMutation({ mutationFn: () => api(`/finance/customer-invoices/${id}`, { method: "DELETE" }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ["finance"] }); onBack(); }, onError: err });
  const ci = q.data;
  if (q.isLoading) return <div className="detail"><ListSkeleton rows={4} /></div>;
  if (!ci) return <div className="detail"><EmptyState title="Invoice not found" /></div>;
  const [label, tone] = CI_STATUS[ci.status];
  const writer = me.can["finance.customer_invoices"];
  const draft = ci.status === "draft";
  const upd = (i: number, k: keyof CILine, v: string | boolean) => setLines((ls) => (ls ?? []).map((l, j) => (j === i ? { ...l, [k]: v } : l)));
  return (
    <div className="detail fin-detail">
      <div className="detail-head">
        <Button icon className="fin-back" aria-label="Back" onClick={onBack}><ArrowLeft size={18} /></Button>
        <div className="grow"><h2>{ci.kind === "credit_note" ? "Credit note" : "Invoice"} {ci.label}</h2>
          <div className="muted fin-small">{ci.customer?.name}{ci.issue_date ? ` · issued ${day(ci.issue_date)}` : ""}{ci.due_date ? ` · due ${day(ci.due_date)}` : ""}</div></div>
        <Pill tone={tone}>{label}</Pill>
        <a className="btn icon" href={`/api/v1/finance/customer-invoices/${ci.id}/pdf`} target="_blank" rel="noreferrer" aria-label="PDF" title="PDF"><FileText size={16} /></a>
        {writer && draft && <Button icon aria-label="Delete draft" onClick={() => { if (confirm("Delete this draft?")) del.mutate(); }}><Trash2 size={16} /></Button>}
      </div>
      {ci.tax_exempt && <div className="fin-banner">The customer's tax exemption certificate is on file: no tax is charged.</div>}
      {ci.credit_for_id && <div className="fin-banner">Credit note for <Link to={`/finance/customer-invoices/${ci.credit_for_id}`}>this invoice</Link>.</div>}
      <section className="card">
        {lines ? (
          <div className="card-body stack">
            {lines.map((l, i) => (
              <div key={i} className="fin-line ci">
                <Select value={l.kind} onChange={(e) => upd(i, "kind", e.target.value)} aria-label="Kind">
                  <option value="labor">Labour</option><option value="part">Part</option><option value="cost">Cost</option><option value="other">Other</option></Select>
                <Input value={l.description} onChange={(e) => upd(i, "description", e.target.value)} aria-label="Description" />
                <Input inputMode="decimal" value={l.quantity} onChange={(e) => upd(i, "quantity", e.target.value)} aria-label="Quantity" />
                <Input inputMode="decimal" value={l.unit_price} onChange={(e) => upd(i, "unit_price", e.target.value)} aria-label="Unit price" />
                <Checkbox checked={l.taxable} onChange={(v) => upd(i, "taxable", v)} label="Tax" />
                <Button icon aria-label="Remove line" onClick={() => setLines((ls) => (ls ?? []).filter((_, j) => j !== i))}><Trash2 size={15} /></Button>
              </div>))}
            <div className="row"><Button size="sm" onClick={() => setLines((ls) => [...(ls ?? []), { kind: "other", description: "", quantity: "1", unit_price: "0", taxable: true }])}><Plus size={14} />Add line</Button>
              <span className="grow" /><Button onClick={() => setLines(null)}>Cancel</Button>
              <Button variant="primary" onClick={() => patch.mutate({ lines: lines.map((l) => ({ ...l, work_order_id: l.work_order_id ?? undefined })) })}>Save</Button></div>
          </div>
        ) : (
          <div className="table-wrap"><table className="table fin-table">
            <thead><tr><th>Description</th><th className="num">Qty</th><th className="num">Price</th><th className="num">Amount</th></tr></thead>
            <tbody>{(ci.lines ?? []).map((l) => <tr key={l.id}><td>{l.description}{!l.taxable && !ci.tax_exempt ? <span className="faint"> · no tax</span> : null}</td>
              <td className="num">{Number(l.quantity)}</td><td className="num">{money(l.unit_price, ci.currency)}</td><td className="num">{money(l.amount ?? "0", ci.currency)}</td></tr>)}
              {!ci.lines?.length && <tr><td colSpan={4} className="muted">No lines yet.</td></tr>}</tbody>
          </table></div>
        )}
        <div className="po-totals">
          <div><span>Subtotal</span><span>{money(ci.subtotal, ci.currency)}</span></div>
          <div><span>{ci.tax_exempt ? "Tax (exempt)" : `Tax (${Number(ci.tax_rate_pct ?? 0)}%)`}</span><span>{money(ci.tax, ci.currency)}</span></div>
          <div className="tot"><span>Total</span><span>{money(ci.total, ci.currency)}</span></div>
          {ci.status !== "draft" && ci.kind === "invoice" && <><div><span>Paid and credited</span><span>{money(ci.paid, ci.currency)}</span></div>
            <div className="tot"><span>Balance due</span><span>{money(ci.balance, ci.currency)}</span></div></>}
        </div>
      </section>
      {ci.payment_link_url && <a className="fin-chip" href={ci.payment_link_url} target="_blank" rel="noreferrer"><ExternalLink size={13} />Online payment link</a>}
      {writer && <div className="row wrap fin-actions">
        {draft && !lines && <Button onClick={() => setLines((ci.lines ?? []).map((l) => ({ ...l, quantity: String(Number(l.quantity)), unit_price: String(Number(l.unit_price)) })))}>Edit lines</Button>}
        {draft && <Button variant="primary" onClick={() => setSend(true)}><Send size={15} />Send</Button>}
        {!draft && ci.status !== "void" && <Button onClick={() => setSend(true)}><Send size={15} />Send again</Button>}
        {ci.kind === "invoice" && ["sent", "partially_paid", "overdue"].includes(ci.status) && <Button variant="primary" onClick={() => setPay(true)}>Record payment</Button>}
        {ci.kind === "invoice" && !draft && ci.status !== "void" && <Button onClick={() => {
          const reason = prompt("Reason for the credit note?", "");
          if (reason !== null) act.mutate({ path: "credit-note", body: { reason } }, { onSuccess: (cn) => { done(cn); nav(`/finance/customer-invoices/${cn.id}`); } });
        }}>Credit note</Button>}
        {!draft && ci.status !== "void" && ci.status !== "paid" && Number(ci.paid) === 0 &&
          <Button variant="ghost" onClick={() => { if (confirm("Void this invoice?")) act.mutate({ path: "void" }, { onSuccess: (x) => done(x) }); }}>Void</Button>}
        {ci.customer && <a className="btn ghost" href={`/api/v1/finance/customers/${ci.customer.id}/statement?format=csv`}>Customer statement</a>}
      </div>}
      {(ci.credit_notes ?? []).length > 0 && <section className="card card-pad"><h3 className="sec-h">Credit notes</h3>
        {ci.credit_notes!.map((c) => <Link key={c.id} to={`/finance/customer-invoices/${c.id}`} className="row fin-small"><span className="grow">{c.label} · {c.status}</span>{money(c.total, ci.currency)}</Link>)}</section>}
      {(ci.payments ?? []).length > 0 && <section className="card card-pad"><h3 className="sec-h">Payments</h3>
        {ci.payments!.map((p) => <div key={p.id} className="row fin-small"><span className="grow">{day(p.paid_on)} · {p.method || "payment"}{p.reference ? ` · ${p.reference}` : ""}</span>{money(p.amount, ci.currency)}</div>)}</section>}
      {pay && <PaymentModal currency={ci.currency} balance={ci.balance} onClose={() => setPay(false)}
        onSave={(body) => act.mutate({ path: "payments", body }, { onSuccess: (x) => { setPay(false); done(x, "Payment recorded"); } })} />}
      {send && <SendModal onClose={() => setSend(false)} onSend={(body) => act.mutate({ path: "send", body }, { onSuccess: (x) => { setSend(false); done(x, "Sent"); } })} />}
    </div>
  );
}

function SendModal({ onClose, onSend }: { onClose: () => void; onSend: (b: { to: string; message: string }) => void }) {
  const [to, setTo] = useState("");
  const [message, setMessage] = useState("");
  return (
    <Modal title="Send invoice" onClose={onClose} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" onClick={() => onSend({ to, message })}>Send</Button></>}>
      <div className="stack">
        <Field label="To" hint="Leave empty to use the customer's billing email.">{(fid) => <Input id={fid} type="email" value={to} onChange={(e) => setTo(e.target.value)} />}</Field>
        <Field label="Message (optional)">{(fid) => <textarea id={fid} className="input" rows={3} value={message} onChange={(e) => setMessage(e.target.value)} />}</Field>
        <p className="faint fin-small">The PDF is attached. Once sent, the invoice is numbered and read-only; fix mistakes with a credit note.</p>
      </div>
    </Modal>
  );
}
