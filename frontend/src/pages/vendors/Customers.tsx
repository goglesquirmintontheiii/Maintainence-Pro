// Customers (0.5.0, MP-046, r234, r235): list + detail. A customer gets its own location, billing details, labor
// rate and parts markup, linked assets, work orders (the Customer field on a work order) and quotes the customer
// approves through a link — no account needed.
import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Ban, Copy, FileDown, FileText, MoreHorizontal, Pencil, Plus, Search, Send, Trash2, UserRound } from "lucide-react";
import { api, ApiError } from "../../lib/api";
import { useSession } from "../../lib/session";
import { copyText } from "../../lib/wo";
import { currency, dateTime, show, timeAgo } from "../../lib/format";
import { useToast } from "../../components/Toast";
import { Button, Checkbox, Drawer, Dropdown, EmptyState, Field, Input, ListSkeleton, Modal, Pill, Select } from "../../components/ui";
import { MultiPicker } from "../../components/pickers";
import { AssetPicker } from "../../components/assetPickers";
import { ColorPicker } from "../../components/ColorPicker";
import { useLocationList } from "../../lib/assets";
import { AddressFields, addressText, ContactCard, ContactDialog, OrgAvatar, type AddressValue, type Contact } from "./Vendors";
import "../purchasing/purchasing.css";

type CustomerRow = {
  id: string; name: string; color: string; description: string; email: string; phone: string; billing_address: AddressValue; billing_email: string;
  tax_id: string; payment_terms: string; currency: string; labor_rate: string | null; parts_markup_pct: string | null; default_location_id: string | null;
  contacts: Contact[]; created_at: string;
};
export type QuoteStatus = "draft" | "sent" | "approved" | "rejected" | "expired" | "canceled";
export type QuoteRow = { id: string; number: number; title: string; scope: string; status: QuoteStatus; currency: string; valid_until: string | null;
  subtotal: string; tax: string; total: string; sent_at: string | null; decided_at: string | null; decided_by_name: string; decision_comment: string;
  customer_id: string; work_order_id: string | null; shared: boolean; created_at: string };
type QuoteLine = { kind: "labor" | "part" | "other"; part_id?: string | null; description: string; quantity: string; unit_price: string; amount?: string; taxable: boolean };
type QuoteDetail = QuoteRow & { lines: QuoteLine[]; comments: { body: string; author: string; external: boolean; created_at: string }[] };
type CustomerDetail = CustomerRow & { locations: { id: string; name: string }[]; assets: { id: string; name: string }[];
  work_orders: { id: string; number: number; title: string; status: string }[]; quotes: QuoteRow[] };

export const QUOTE_TONE: Record<QuoteStatus, "neutral" | "info" | "success" | "warning" | "danger"> = {
  draft: "neutral", sent: "info", approved: "success", rejected: "danger", expired: "warning", canceled: "neutral" };
const QUOTE_LABEL: Record<QuoteStatus, string> = { draft: "Draft", sent: "Sent", approved: "Approved", rejected: "Rejected", expired: "Expired", canceled: "Canceled" };

export function useCustomersLite() {
  const { can } = useSession();
  return useQuery({ queryKey: ["customers", "lite"], queryFn: () => api<{ items: CustomerRow[] }>("/customers?per_page=500"), staleTime: 30_000, enabled: can("customers.view") });
}

export function CustomersPage() {
  const { id } = useParams();
  const nav = useNavigate();
  const { can } = useSession();
  const [search, setSearch] = useState("");
  const [creating, setCreating] = useState(false);
  const [params, setParams] = useSearchParams();
  useEffect(() => { if (params.get("new") === "1") { setCreating(true); const p = new URLSearchParams(params); p.delete("new"); setParams(p, { replace: true }); } }, [params, setParams]); // Create menu
  return (
    <div className="wo-page">
      <div className={"split wo-split" + (id ? " has-detail" : "")}>
        <div className="split-list">
          <div className="list-tools wo-list-tools">
            <div className="row" style={{ justifyContent: "space-between" }}>
              <h1>Customers</h1>
              {can("customers.manage") && <Button variant="primary" onClick={() => setCreating(true)} aria-label="New Customer"><Plus size={16} />New</Button>}
            </div>
            <div className="search-in"><Search size={15} className="faint" />
              <Input placeholder="Search customers" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search customers" /></div>
          </div>
          <div className="list" aria-label="Customers"><CustomerList q={search} activeId={id} /></div>
        </div>
        <div className="split-detail">
          {id ? <CustomerDetailView key={id} id={id} />
            : <EmptyState icon={<UserRound size={28} />} title="Select a customer">Pick one to see their locations, work orders and quotes.</EmptyState>}
        </div>
      </div>
      {creating && <CustomerForm onClose={() => setCreating(false)} onSaved={(c) => { setCreating(false); nav(`/customers/${c.id}`); }} />}
    </div>
  );
}

function CustomerList({ q, activeId }: { q: string; activeId?: string }) {
  const { can } = useSession();
  const list = useQuery({ queryKey: ["customers", "list", q], queryFn: () => api<{ items: CustomerRow[]; total: number }>(`/customers?per_page=200&q=${encodeURIComponent(q)}`), placeholderData: (p) => p });
  if (list.isLoading) return <ListSkeleton />;
  const items = list.data?.items ?? [];
  if (!items.length) return q ? <EmptyState title="No customers match">Try another search.</EmptyState>
    : <EmptyState icon={<UserRound size={26} />} title="No customers yet">{can("customers.manage") ? "Add the clients you do maintenance work for." : "Customers your team adds show here."}</EmptyState>;
  return <>{items.map((c) => <Link key={c.id} to={`/customers/${c.id}`} className={"list-row" + (c.id === activeId ? " active" : "")}>
    <OrgAvatar name={c.name} color={c.color} />
    <span className="grow" style={{ minWidth: 0 }}><span className="t" style={{ display: "block" }}>{c.name}</span>
      <span className="s" style={{ display: "block" }}>{[c.contacts[0]?.name, c.email, c.phone].filter(Boolean).join(" · ") || " "}</span></span>
  </Link>)}</>;
}

function CustomerDetailView({ id }: { id: string }) {
  const c = useQuery({ queryKey: ["customer", id], queryFn: () => api<CustomerDetail>(`/customers/${id}`) });
  const qc = useQueryClient();
  const nav = useNavigate();
  const { session, can } = useSession();
  const { toast } = useToast();
  const [editing, setEditing] = useState(false);
  const [contact, setContact] = useState<Contact | "new" | null>(null);
  const [quote, setQuote] = useState<string | "new" | null>(null);
  const [confirm, setConfirm] = useState(false);
  const refresh = () => { qc.invalidateQueries({ queryKey: ["customer", id] }); qc.invalidateQueries({ queryKey: ["customers"] }); };
  const del = useMutation({ mutationFn: () => api(`/customers/${id}`, { method: "DELETE" }), onSuccess: () => { refresh(); toast("Customer deleted"); nav("/customers"); },
    onError: (e) => toast((e as ApiError).message, { kind: "error" }) });
  if (c.isError) return <EmptyState icon={<UserRound size={28} />} title="Customer not found">It may have been deleted, or you don't have access.</EmptyState>;
  const d = c.data;
  if (!d) return <div className="detail"><ListSkeleton rows={5} /></div>;
  const cur = d.currency || session.org?.currency;
  const manage = can("customers.manage");
  return (
    <div className="detail">
      <Link to="/customers" className="row small mobile-only"><ArrowLeft size={14} />All customers</Link>
      <div className="wo-head">
        <OrgAvatar name={d.name} color={d.color} lg />
        <div className="grow"><div className="small muted"><Link to="/customers">Customers</Link></div><h1 className="wo-title">{d.name}</h1></div>
        <div className="row">
          {can("quotes.manage") && <Button onClick={() => setQuote("new")}><FileText size={15} /><span className="desktop-only">New quote</span></Button>}
          {manage && <Button icon aria-label="Edit customer" title="Edit" onClick={() => setEditing(true)}><Pencil size={15} /></Button>}
          {manage && <Dropdown trigger={(_, t) => <Button icon aria-label="More actions" onClick={t}><MoreHorizontal size={18} /></Button>} width={200}>
            {(close) => <button className="menu-item" style={{ color: "var(--c-danger)" }} onClick={() => { close(); setConfirm(true); }}><Trash2 size={15} />Delete</button>}
          </Dropdown>}
        </div>
      </div>
      {d.description && <section className="card card-pad prewrap">{d.description}</section>}
      <dl className="meta-grid card card-pad">
        <div><dt>Email</dt><dd>{d.email ? <a href={`mailto:${d.email}`}>{d.email}</a> : "—"}</dd></div>
        <div><dt>Phone</dt><dd>{show(d.phone)}</dd></div>
        <div><dt>Billing email</dt><dd>{show(d.billing_email)}</dd></div>
        <div><dt>Billing address</dt><dd className="prewrap small">{addressText(d.billing_address) || "—"}</dd></div>
        <div><dt>Tax ID</dt><dd className="mono">{show(d.tax_id)}</dd></div>
        <div><dt>Payment terms</dt><dd>{show(d.payment_terms)}</dd></div>
        {can("costs.view") && <><div><dt>Labor rate</dt><dd>{d.labor_rate ? `${currency(d.labor_rate, cur)} / h` : "—"}</dd></div>
          <div><dt>Parts markup</dt><dd>{d.parts_markup_pct ? `${Number(d.parts_markup_pct)}%` : "—"}</dd></div></>}
        <div className="span2"><dt>Locations</dt><dd>{d.locations.length ? <span className="vd-chips">{d.locations.map((l) => <Link key={l.id} className="chip" to={`/locations/${l.id}`}>{l.name}</Link>)}</span> : "—"}</dd></div>
        <div className="span2"><dt>Assets</dt><dd>{d.assets.length ? <span className="vd-chips">{d.assets.map((a) => <Link key={a.id} className="chip" to={`/assets/${a.id}`}>{a.name}</Link>)}</span> : <span className="faint">None</span>}</dd></div>
      </dl>
      <section className="card">
        <div className="card-head"><h3 className="sec-h" style={{ margin: 0 }}>Contacts</h3>
          {manage && <Button size="sm" variant="ghost" onClick={() => setContact("new")}><Plus size={14} />Add contact</Button>}</div>
        {d.contacts.length === 0 ? <div className="card-body small faint">No contacts yet.</div>
          : <div className="contact-grid">{d.contacts.map((x) => <ContactCard key={x.id} c={x} onEdit={manage ? () => setContact(x) : undefined} />)}</div>}
      </section>
      <section className="card">
        <div className="card-head"><h3 className="sec-h" style={{ margin: 0 }}>Quotes</h3>
          {can("quotes.manage") && <Button size="sm" variant="ghost" onClick={() => setQuote("new")}><Plus size={14} />New quote</Button>}</div>
        {d.quotes.length === 0 ? <div className="card-body small faint">No quotes yet. A quote lists the labor and parts for a job; the customer approves it from a link.</div>
          : d.quotes.map((x) => <button key={x.id} type="button" className="list-row" style={{ width: "100%", textAlign: "left", background: "none" }} onClick={() => setQuote(x.id)}>
            <span className="mono small faint">Q-{x.number}</span><span className="grow t">{x.title}</span><span className="small">{currency(x.total, x.currency || cur)}</span>
            <Pill tone={QUOTE_TONE[x.status]}>{QUOTE_LABEL[x.status]}</Pill></button>)}
      </section>
      <section className="card">
        <div className="card-head"><h3 className="sec-h" style={{ margin: 0 }}>Work orders</h3></div>
        {d.work_orders.length === 0 ? <div className="card-body small faint">Work orders with this customer show here. Set the Customer field on a work order.</div>
          : d.work_orders.map((w) => <Link key={w.id} to={`/work-orders/${w.id}`} className="list-row"><span className="mono small faint">#{w.number}</span><span className="grow t">{w.title}</span>
            <span className="small faint">{w.status.replace("_", " ")}</span></Link>)}
      </section>
      <div className="small faint">Added {dateTime(d.created_at, session.org?.timezone)}</div>

      {editing && <CustomerForm edit={d} onClose={() => setEditing(false)} onSaved={() => { setEditing(false); refresh(); }} />}
      {contact && <ContactDialog kind="customer" parentId={d.id} edit={contact === "new" ? undefined : contact} onClose={() => setContact(null)} onDone={() => { setContact(null); refresh(); }} />}
      {quote && <QuoteDrawer customer={d} quoteId={quote === "new" ? undefined : quote} onClose={() => { setQuote(null); refresh(); }} />}
      {confirm && <Modal title="Delete customer?" onClose={() => setConfirm(false)} footer={<><Button onClick={() => setConfirm(false)}>Cancel</Button>
        <Button variant="danger" disabled={del.isPending} onClick={() => del.mutate()}>Delete</Button></>}>
        <p>{d.name} will be removed from lists. Work orders keep their history.</p></Modal>}
    </div>
  );
}

function CustomerForm({ edit, onClose, onSaved }: { edit?: CustomerDetail; onClose: () => void; onSaved: (c: CustomerDetail) => void }) {
  const locs = useLocationList();
  const [f, setF] = useState(() => ({
    name: edit?.name ?? "", color: edit?.color ?? "#5d6880", description: edit?.description ?? "", email: edit?.email ?? "", phone: edit?.phone ?? "",
    billing_email: edit?.billing_email ?? "", billing_address: edit?.billing_address ?? {}, tax_id: edit?.tax_id ?? "", payment_terms: edit?.payment_terms ?? "",
    currency: edit?.currency ?? "", labor_rate: edit?.labor_rate ?? "", parts_markup_pct: edit?.parts_markup_pct ?? "",
    location_ids: edit?.locations.map((l) => l.id) ?? [], asset_ids: edit?.assets.map((a) => a.id) ?? [],
  }));
  const [err, setErr] = useState("");
  const set = (p: Partial<typeof f>) => setF((x) => ({ ...x, ...p }));
  const locOpts = useMemo(() => (locs.data?.items ?? []).map((l) => ({ key: l.id, label: l.name })), [locs.data]);
  const body = { ...f, labor_rate: f.labor_rate === "" ? null : f.labor_rate, parts_markup_pct: f.parts_markup_pct === "" ? null : f.parts_markup_pct,
    ...(edit ? {} : { location_ids: undefined }) };
  const save = useMutation({
    mutationFn: () => edit ? api<CustomerDetail>(`/customers/${edit.id}`, { method: "PATCH", body }) : api<CustomerDetail>("/customers", { method: "POST", body }),
    onSuccess: onSaved, onError: (e) => setErr((e as ApiError).message),
  });
  return (
    <Drawer title={edit ? `Edit ${edit.name}` : "New Customer"} onClose={onClose} width={620}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!f.name.trim() || save.isPending} onClick={() => save.mutate()}>{edit ? "Save" : "Create"}</Button></>}>
      <div className="stack" style={{ gap: 12 }}>
        <div className="row" style={{ gap: 10, alignItems: "flex-end" }}>
          <Field label="Name" className="grow">{(id) => <Input id={id} autoFocus value={f.name} maxLength={255} onChange={(e) => set({ name: e.target.value })} />}</Field>
          <ColorPicker value={f.color} onChange={(c) => set({ color: c })} />
        </div>
        {!edit && <p className="small muted">A location with the customer's name is created for them, so their assets and work orders sit together.</p>}
        <Field label="Description">{(id) => <textarea id={id} className="input" rows={2} value={f.description} onChange={(e) => set({ description: e.target.value })} />}</Field>
        <div className="po-form-grid">
          <Field label="Email">{(id) => <Input id={id} type="email" value={f.email} onChange={(e) => set({ email: e.target.value })} />}</Field>
          <Field label="Phone">{(id) => <Input id={id} type="tel" value={f.phone} onChange={(e) => set({ phone: e.target.value })} />}</Field>
          <Field label="Billing email" hint="Quotes are sent here">{(id) => <Input id={id} type="email" value={f.billing_email} onChange={(e) => set({ billing_email: e.target.value })} />}</Field>
          <Field label="Tax ID">{(id) => <Input id={id} value={f.tax_id} onChange={(e) => set({ tax_id: e.target.value })} />}</Field>
          <Field label="Payment terms">{(id) => <Input id={id} value={f.payment_terms} placeholder="Net 30" onChange={(e) => set({ payment_terms: e.target.value })} />}</Field>
          <Field label="Currency" hint="Empty: your organization's">{(id) => <Input id={id} value={f.currency} maxLength={3} onChange={(e) => set({ currency: e.target.value.toUpperCase() })} />}</Field>
          <Field label="Labor rate (per hour)">{(id) => <Input id={id} inputMode="decimal" value={f.labor_rate} onChange={(e) => set({ labor_rate: e.target.value })} />}</Field>
          <Field label="Parts markup %">{(id) => <Input id={id} inputMode="decimal" value={f.parts_markup_pct} onChange={(e) => set({ parts_markup_pct: e.target.value })} />}</Field>
        </div>
        <h3 className="sec-h">Billing address</h3>
        <AddressFields value={f.billing_address} onChange={(a) => set({ billing_address: a })} />
        {edit && <Field label="Locations">{(id) => <MultiPicker id={id} label="Locations" placeholder="Add locations" value={f.location_ids} onChange={(v) => set({ location_ids: v })} options={locOpts} />}</Field>}
        <Field label="Assets">{(id) => <AssetPicker id={id} multi value={f.asset_ids} onChange={(v) => set({ asset_ids: v })} placeholder="Add assets" />}</Field>
        {err && <div className="banner warning" role="alert">{err}</div>}
      </div>
    </Drawer>
  );
}

// ---------------------------------------------------------------- quotes (r235)
function QuoteDrawer({ customer, quoteId, onClose }: { customer: CustomerDetail; quoteId?: string; onClose: () => void }) {
  const q = useQuery({ queryKey: ["quote", quoteId], queryFn: () => api<QuoteDetail>(`/quotes/${quoteId}`), enabled: !!quoteId });
  if (quoteId && !q.data) return <Drawer title="Quote" onClose={onClose}><ListSkeleton rows={4} /></Drawer>;
  return <QuoteEditor key={q.data?.id ?? "new"} customer={customer} quote={q.data} onClose={onClose} />;
}

function QuoteEditor({ customer, quote, onClose }: { customer: CustomerDetail; quote?: QuoteDetail; onClose: () => void }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { can } = useSession();
  const editable = !quote || quote.status === "draft" || quote.status === "sent";
  const cur = quote?.currency || customer.currency || undefined;
  const [title, setTitle] = useState(quote?.title ?? "");
  const [scope, setScope] = useState(quote?.scope ?? "");
  const [validUntil, setValidUntil] = useState(quote?.valid_until ?? "");
  const [woId, setWoId] = useState(quote?.work_order_id ?? "");
  const [taxPct, setTaxPct] = useState("");
  const [lines, setLines] = useState<QuoteLine[]>(quote?.lines ?? [{ kind: "labor", description: "Labor (hours)", quantity: "1", unit_price: customer.labor_rate ?? "", taxable: true }]);
  const [err, setErr] = useState("");
  const [sending, setSending] = useState(false);
  const [link, setLink] = useState("");
  const sub = lines.reduce((s, l) => s + (Number(l.quantity) || 0) * (Number(l.unit_price) || 0), 0);
  const taxable = lines.filter((l) => l.taxable).reduce((s, l) => s + (Number(l.quantity) || 0) * (Number(l.unit_price) || 0), 0);
  const tax = taxPct !== "" ? taxable * (Number(taxPct) || 0) / 100 : Number(quote?.tax ?? 0);
  const refresh = () => { qc.invalidateQueries({ queryKey: ["quote", quote?.id] }); qc.invalidateQueries({ queryKey: ["customer", customer.id] }); };
  const save = useMutation({
    mutationFn: () => {
      const body = { title, scope, valid_until: validUntil || null, work_order_id: woId || null, lines, ...(taxPct !== "" ? { tax_pct: taxPct } : {}) };
      return quote ? api<QuoteDetail>(`/quotes/${quote.id}`, { method: "PATCH", body }) : api<QuoteDetail>("/quotes", { method: "POST", body: { ...body, customer_id: customer.id } });
    },
    onSuccess: () => { refresh(); toast("Quote saved"); onClose(); }, onError: (e) => setErr((e as ApiError).message),
  });
  const cancel = useMutation({ mutationFn: () => api(`/quotes/${quote?.id}/cancel`, { method: "POST", body: {} }), onSuccess: () => { refresh(); onClose(); }, onError: (e) => setErr((e as ApiError).message) });
  const setLine = (i: number, p: Partial<QuoteLine>) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...p } : l)));
  return (
    <Drawer title={quote ? `Quote Q-${quote.number}` : `New quote for ${customer.name}`} onClose={onClose} width={720}
      footer={<>
        {quote && <span className="grow row" style={{ gap: 6 }}><Pill tone={QUOTE_TONE[quote.status]}>{QUOTE_LABEL[quote.status]}</Pill>
          {quote.decided_by_name && <span className="small muted">by {quote.decided_by_name}</span>}</span>}
        {!quote && <span className="grow" />}
        <Button onClick={onClose}>Close</Button>
        {editable && can("quotes.manage") && <Button variant="primary" disabled={!title.trim() || !lines.length || save.isPending} onClick={() => save.mutate()}>Save</Button>}
      </>}>
      <div className="stack" style={{ gap: 12 }}>
        {quote && <div className="row wrap" style={{ gap: 6 }}>
          {editable && can("quotes.manage") && <Button size="sm" onClick={() => setSending(true)}><Send size={14} />{quote.status === "sent" ? "Send again" : "Send to customer"}</Button>}
          <a className="btn btn-sm" href={`/api/v1/quotes/${quote.id}/pdf`} target="_blank" rel="noopener noreferrer"><FileDown size={14} />PDF</a>
          {editable && can("quotes.manage") && <Button size="sm" variant="ghost" onClick={() => cancel.mutate()}><Ban size={14} />Cancel quote</Button>}
          {quote.sent_at && <span className="small faint">Sent {timeAgo(quote.sent_at)}</span>}
        </div>}
        {link && <div className="banner info row" style={{ gap: 8 }}><span className="grow small" style={{ wordBreak: "break-all" }}>{link}</span>
          <Button size="sm" onClick={async () => toast((await copyText(link)) ? "Link copied" : "Couldn't copy")}><Copy size={14} />Copy</Button></div>}
        {quote?.decision_comment && <div className="banner info">“{quote.decision_comment}” — {quote.decided_by_name}</div>}
        <Field label="Title">{(id) => <Input id={id} value={title} disabled={!editable} maxLength={255} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Replace rooftop unit compressor" />}</Field>
        <Field label="Scope of work">{(id) => <textarea id={id} className="input" rows={3} disabled={!editable} value={scope} onChange={(e) => setScope(e.target.value)} />}</Field>
        <div className="po-form-grid">
          <Field label="Valid until">{(id) => <Input id={id} type="date" disabled={!editable} value={validUntil} onChange={(e) => setValidUntil(e.target.value)} />}</Field>
          <Field label="Work order" hint="Approved quotes attach to it">{(id) => <Select id={id} disabled={!editable} value={woId} onChange={(e) => setWoId(e.target.value)}>
            <option value="">None</option>{customer.work_orders.map((w) => <option key={w.id} value={w.id}>#{w.number} {w.title}</option>)}</Select>}</Field>
          <Field label="Tax %" hint={quote ? "Leave empty to keep the current tax" : undefined}>{(id) => <Input id={id} disabled={!editable} inputMode="decimal" value={taxPct} onChange={(e) => setTaxPct(e.target.value)} />}</Field>
        </div>
        <section>
          <h3 className="sec-h">Lines</h3>
          {lines.map((l, i) => <div key={i} className="quote-line">
            <Select aria-label="Kind" disabled={!editable} value={l.kind} onChange={(e) => setLine(i, { kind: e.target.value as QuoteLine["kind"] })}>
              <option value="labor">Labor</option><option value="part">Part</option><option value="other">Other</option></Select>
            <Input aria-label="Description" disabled={!editable} value={l.description} onChange={(e) => setLine(i, { description: e.target.value })} />
            <Input aria-label="Quantity" disabled={!editable} inputMode="decimal" value={l.quantity} onChange={(e) => setLine(i, { quantity: e.target.value })} />
            <Input aria-label="Price" disabled={!editable} inputMode="decimal" value={l.unit_price} onChange={(e) => setLine(i, { unit_price: e.target.value })} />
            <Checkbox checked={l.taxable} disabled={!editable} onChange={(v) => setLine(i, { taxable: v })} label="Tax" />
            {editable ? <Button size="sm" variant="ghost" icon aria-label="Remove line" onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))}><Trash2 size={14} /></Button> : <span />}
          </div>)}
          {editable && <Button size="sm" variant="ghost" onClick={() => setLines((ls) => [...ls, { kind: "part", description: "", quantity: "1", unit_price: "", taxable: true }])}><Plus size={14} />Add line</Button>}
          <div className="po-sum"><span>Subtotal</span><b>{currency(sub, cur)}</b><span>Tax</span><b>{currency(tax, cur)}</b><span>Total</span><b>{currency(sub + tax, cur)}</b></div>
        </section>
        {quote && quote.comments.length > 0 && <section className="card">
          <div className="card-head"><h3 className="sec-h" style={{ margin: 0 }}>Conversation</h3></div>
          {quote.comments.map((c, i) => <div key={i} className="list-row" style={{ alignItems: "flex-start" }}><span className="grow">
            <span className="small"><b>{c.author}</b> <span className="faint">{timeAgo(c.created_at)}</span></span><span className="prewrap" style={{ display: "block" }}>{c.body}</span></span></div>)}
        </section>}
        {err && <div className="banner warning" role="alert">{err}</div>}
      </div>
      {sending && quote && <SendQuoteDialog quote={quote} customer={customer} onClose={() => setSending(false)} onSent={(url) => { setSending(false); setLink(url); refresh(); }} />}
    </Drawer>
  );
}

function SendQuoteDialog({ quote, customer, onClose, onSent }: { quote: QuoteDetail; customer: CustomerDetail; onClose: () => void; onSent: (url: string) => void }) {
  const [to, setTo] = useState(customer.billing_email || customer.email || "");
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");
  const m = useMutation({
    mutationFn: () => api<{ url: string }>(`/quotes/${quote.id}/send`, { method: "POST", body: { message: msg, to: to.split(/[,;\s]+/).filter(Boolean) } }),
    onSuccess: (r) => onSent(r.url), onError: (e) => setErr((e as ApiError).message),
  });
  return (
    <Modal title="Send quote" onClose={onClose} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={m.isPending} onClick={() => m.mutate()}><Send size={14} />Send</Button></>}>
      <p className="small muted">The customer gets a link to review the quote, ask questions and approve or reject it — no account needed. Sending again makes a new link and turns off the old one.</p>
      <Field label="To">{(id) => <Input id={id} value={to} onChange={(e) => setTo(e.target.value)} />}</Field>
      <Field label="Message">{(id) => <textarea id={id} className="input" rows={3} value={msg} onChange={(e) => setMsg(e.target.value)} />}</Field>
      {err && <div className="banner warning" role="alert">{err}</div>}
    </Modal>
  );
}
