// One purchase order (MP-042/043, r229–r259): status actions, items with what arrived, taxes and costs, addresses,
// approvals, receipts, files and comments. Receive and Send open their own dialogs.
import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Ban, Check, CheckCheck, Copy, FileDown, Link2, Mail, MoreHorizontal, PackageCheck, Pencil, RotateCcw, ShoppingCart, Trash2, X } from "lucide-react";
import { api, ApiError, type CommentItem } from "../../lib/api";
import { useSession } from "../../lib/session";
import { absoluteUrl, copyText } from "../../lib/wo";
import { currency, dateTime, timeAgo } from "../../lib/format";
import { useToast } from "../../components/Toast";
import { Avatar, Button, Dropdown, EmptyState, Field, Input, ListSkeleton, Modal, Pill } from "../../components/ui";
import { LocationPicker } from "../../components/assetPickers";
import { FilesSection } from "../assets/shared";
import { POForm } from "./POForm";
import { addrLines, PO_TONE, q, type PODetail as PD, type POLine, type VendorAck } from "./types";

export function usePO(id: string | undefined) {
  return useQuery({ queryKey: ["po", id], queryFn: () => api<PD>(`/purchase-orders/${id}`), enabled: !!id });
}

export function POStatusPill({ status, label, overdue }: { status: PD["status"]; label: string; overdue?: boolean }) {
  return <span className="row" style={{ gap: 4, display: "inline-flex" }}><Pill tone={PO_TONE[status]}>{label}</Pill>{overdue && <Pill tone="danger">Overdue</Pill>}</span>;
}

type Dlg = "edit" | "receive" | "send" | "reject" | "cancel" | "delete" | null;

export function PODetailView({ id }: { id: string }) {
  const po = usePO(id);
  const qc = useQueryClient();
  const nav = useNavigate();
  const { session } = useSession();
  const { toast } = useToast();
  const [dlg, setDlg] = useState<Dlg>(null);
  const refresh = () => { qc.invalidateQueries({ queryKey: ["po", id] }); qc.invalidateQueries({ queryKey: ["pos"] }); qc.invalidateQueries({ queryKey: ["parts"] }); };
  const err = (e: unknown) => toast((e as ApiError).message, { kind: "error" });
  const act = useMutation({
    mutationFn: ({ a, body }: { a: string; body?: unknown }) => api<PD>(`/purchase-orders/${id}/${a}`, { method: "POST", body: body ?? {} }),
    onSuccess: (d, v) => {
      refresh();
      if (v.a === "duplicate") { toast(`Copied to ${d.display_number}`); nav(`/purchase-orders/${d.id}`); }
      else toast({ approve: "Approved", complete: "Marked complete", reopen: "Reopened" }[v.a] ?? "Done");
    },
    onError: err,
  });
  if (po.isError) return <EmptyState icon={<ShoppingCart size={28} />} title="Purchase order not found">It may have been deleted, or you don't have access.</EmptyState>;
  const p = po.data;
  if (!p) return <div className="detail"><ListSkeleton rows={6} /></div>;
  const tz = session.org?.timezone;
  const cur = p.currency || session.org?.currency || "USD";
  const can = p.can;
  const pending = p.approvals.filter((a) => a.status === "pending");

  return (
    <div className="detail po-detail">
      <Link to="/purchase-orders" className="row small mobile-only"><ArrowLeft size={14} />All purchase orders</Link>
      <div className="wo-head">
        <div className="grow">
          <div className="small muted"><Link to="/purchase-orders">Purchase Orders</Link> · <span className="mono">{p.display_number}</span></div>
          <h1 className="wo-title">{p.title}</h1>
          <div className="row wrap" style={{ marginTop: 6, gap: 6 }}>
            <POStatusPill status={p.status} label={p.status_label} overdue={p.overdue} />
            {p.vendor && <Link className="chip" to={`/vendors/${p.vendor.id}`}>{p.vendor.name}</Link>}
            {p.tax_exempt && <Pill tone="success">Tax exempt</Pill>}
            {p.sent_at && <span className="small faint">Sent {timeAgo(p.sent_at)}</span>}
          </div>
        </div>
        <div className="row po-actions">
          {can.decide && <>
            <Button variant="primary" onClick={() => act.mutate({ a: "approve" })} disabled={act.isPending}><Check size={15} />Approve</Button>
            <Button onClick={() => setDlg("reject")}><X size={15} /><span className="desktop-only">Reject</span></Button>
          </>}
          {can.receive && <Button variant={can.decide ? "default" : "primary"} onClick={() => setDlg("receive")}><PackageCheck size={15} />Receive</Button>}
          {can.edit && <Button icon aria-label="Edit purchase order" title="Edit" onClick={() => setDlg("edit")}><Pencil size={15} /></Button>}
          <Dropdown trigger={(_, t) => <Button icon aria-label="More actions" onClick={t}><MoreHorizontal size={18} /></Button>} width={250}>
            {(close) => <>
              {can.send && <button className="menu-item" onClick={() => { close(); setDlg("send"); }}><Mail size={15} />Send to vendor</button>}
              {can.costs && <a className="menu-item" href={`/api/v1/purchase-orders/${p.id}/pdf`} target="_blank" rel="noopener noreferrer" onClick={close}><FileDown size={15} />Download PDF</a>}
              {can.complete && <button className="menu-item" onClick={() => { close(); act.mutate({ a: "complete" }); }}><CheckCheck size={15} />Mark complete</button>}
              {can.reopen && <button className="menu-item" onClick={() => { close(); act.mutate({ a: "reopen" }); }}><RotateCcw size={15} />Reopen</button>}
              <button className="menu-item" onClick={() => { close(); act.mutate({ a: "duplicate" }); }}><Copy size={15} />Duplicate</button>
              <button className="menu-item" onClick={async () => { close(); toast((await copyText(absoluteUrl(`/purchase-orders/${p.id}`))) ? "Link copied" : "Couldn't copy the link"); }}><Link2 size={15} />Copy link</button>
              {(can.cancel || can.delete) && <div className="menu-sep" />}
              {can.cancel && <button className="menu-item" onClick={() => { close(); setDlg("cancel"); }}><Ban size={15} />Cancel order</button>}
              {can.delete && <button className="menu-item" style={{ color: "var(--c-danger)" }} onClick={() => { close(); setDlg("delete"); }}><Trash2 size={15} />Delete</button>}
            </>}
          </Dropdown>
        </div>
      </div>

      {p.status === "rejected" && p.rejected_reason && <div className="banner warning"><X size={18} /><div>Rejected: {p.rejected_reason}</div></div>}
      {pending.length > 0 && <div className="banner info po-approvals">
        <div className="grow"><b>Waiting for approval</b>
          {pending.map((a) => <div key={a.id} className="small">{a.approvers.filter(Boolean).length ? `From ${a.approvers.filter(Boolean).join(" or ")}` : "From someone who can approve purchase orders"}</div>)}</div>
      </div>}
      {p.budget && p.budget.level !== "ok" && <div className={"banner " + (p.budget.level === "over" ? "warning" : "info")}>
        {p.budget.level === "over" ? "Over budget" : "Close to budget"}: {p.budget.name} has {currency(p.budget.remaining, cur)} left of {currency(p.budget.amount, cur)} after this order.</div>}
      {p.warnings?.map((w) => <div key={w} className="banner warning">{w}</div>)}

      <section className="card">
        <div className="card-head"><h3 className="sec-h" style={{ margin: 0 }}>Items</h3><span className="small muted">{p.lines.length} item{p.lines.length === 1 ? "" : "s"}</span></div>
        <div className="table-wrap"><table className="table po-lines-table">
          <thead><tr><th>Item</th><th className="num">Ordered</th><th className="num">Received</th>{can.costs && <><th className="num">Unit cost</th><th className="num">Amount</th></>}</tr></thead>
          <tbody>{p.lines.map((l) => <LineRow key={l.id} l={l} costs={can.costs} cur={cur} />)}</tbody>
        </table></div>
        {can.costs && <div className="po-totals">
          <div><span>Subtotal</span><span>{currency(p.subtotal, cur)}</span></div>
          {p.costs.map((c) => <div key={c.id}><span>{c.label}{c.kind === "percent" ? ` (${q(c.value)}%)` : ""}</span><span>{currency(c.amount, cur)}</span></div>)}
          <div className="tot"><span>Total</span><span>{currency(p.total, cur)}</span></div>
        </div>}
      </section>

      <dl className="meta-grid card card-pad">
        <div><dt>Vendor</dt><dd>{p.vendor ? <Link to={`/vendors/${p.vendor.id}`}>{p.vendor.name}</Link> : <span className="faint">None</span>}</dd></div>
        <div><dt>Due</dt><dd>{p.due_on ? new Date(p.due_on + "T00:00").toLocaleDateString() : <span className="faint">—</span>}</dd></div>
        <div><dt>Requested by</dt><dd>{p.requested_by ?? "—"}</dd></div>
        <div><dt>Approved by</dt><dd>{p.approved_by ? `${p.approved_by}${p.approved_at ? ", " + dateTime(p.approved_at, tz) : ""}` : <span className="faint">—</span>}</dd></div>
        <div><dt>Ship to</dt><dd className="prewrap small">{addrLines(p.shipping_address).join("\n") || <span className="faint">—</span>}</dd></div>
        <div><dt>Bill to</dt><dd className="prewrap small">{addrLines(p.billing_address).join("\n") || <span className="faint">—</span>}</dd></div>
        {p.work_order_id && <div><dt>Work order</dt><dd><Link to={`/work-orders/${p.work_order_id}`}>Open work order</Link></dd></div>}
        {p.budget && <div><dt>Budget</dt><dd>{p.budget.name}</dd></div>}
        <div><dt>Created</dt><dd className="small">{dateTime(p.created_at, tz)}</dd></div>
        {p.notes && <div className="span2"><dt>Notes</dt><dd className="prewrap">{p.notes}</dd></div>}
      </dl>

      {p.vendor_ack && <VendorAckCard a={p.vendor_ack} tz={tz} />}
      {p.receipts.length > 0 && <section className="card">
        <div className="card-head"><h3 className="sec-h" style={{ margin: 0 }}>Received</h3></div>
        {p.receipts.map((r) => <div key={r.id} className="list-row" style={{ alignItems: "flex-start" }}>
          <PackageCheck size={16} className="faint" />
          <span className="grow"><span className="t">{r.lines.map((x) => `${q(x.quantity)} × ${p.lines.find((l) => l.id === x.line_id)?.description ?? "item"}`).join(", ")}</span>
            <span className="s">{[r.received_by, dateTime(r.received_at, tz), r.packing_slip && `Packing slip ${r.packing_slip}`, r.note].filter(Boolean).join(" · ")}</span></span>
          {r.total !== null && <span className="small">{currency(r.total, cur)}</span>}
        </div>)}
      </section>}

      <FilesSection files={p.files} entityType="purchase_order" entityId={p.id} editable={can.edit || can.send} queryKey={["po", p.id]} role="file" />
      <Comments id={p.id} />

      {dlg === "edit" && <POForm edit={p} onClose={() => setDlg(null)} onSaved={(d) => { setDlg(null); refresh(); if (d.warnings?.length) toast(d.warnings.join(" ")); }} />}
      {dlg === "receive" && <ReceiveDialog p={p} onClose={() => setDlg(null)} onDone={(w) => { setDlg(null); refresh(); toast(w.length ? w.join(" ") : "Received", w.length ? { kind: "error" } : undefined); }} />}
      {dlg === "send" && <SendDialog p={p} onClose={() => setDlg(null)} onDone={(to) => { setDlg(null); refresh(); toast(`Sent to ${to.join(", ")}`); }} />}
      {dlg === "reject" && <ReasonDialog title="Reject purchase order" label="Why is it rejected?" required button="Reject" onClose={() => setDlg(null)}
        onSubmit={(reason) => act.mutateAsync({ a: "reject", body: { reason } }).then(() => setDlg(null))} />}
      {dlg === "cancel" && <ReasonDialog title="Cancel purchase order" label="Reason (optional)" button="Cancel order" onClose={() => setDlg(null)}
        onSubmit={(reason) => act.mutateAsync({ a: "cancel", body: { reason } }).then(() => setDlg(null))} />}
      {dlg === "delete" && <Modal title="Delete purchase order?" onClose={() => setDlg(null)} footer={<><Button onClick={() => setDlg(null)}>Keep it</Button>
        <Button variant="danger" onClick={() => api(`/purchase-orders/${p.id}`, { method: "DELETE" }).then(() => { setDlg(null); refresh(); nav("/purchase-orders"); toast("Deleted"); }, err)}>Delete</Button></>}>
        <p>{p.display_number} will be removed. Parts on it stop counting as on order.</p></Modal>}
    </div>
  );
}

function LineRow({ l, costs, cur }: { l: POLine; costs: boolean; cur: string }) {
  const done = Number(l.received) >= Number(l.quantity);
  return (
    <tr>
      <td>{l.part ? <Link to={`/parts/${l.part.id}`} className="t">{l.description}</Link> : <span className="t">{l.description}</span>}
        {(l.part_number || l.part?.part_number) && <span className="small faint mono" style={{ display: "block" }}>{l.part_number || l.part?.part_number}</span>}</td>
      <td className="num">{q(l.quantity)} <span className="small faint">{l.unit}</span></td>
      <td className={"num" + (done ? " po-done" : Number(l.received) > 0 ? " po-part" : "")}>{q(l.received)}</td>
      {costs && <><td className="num">{currency(l.unit_cost, cur)}</td><td className="num">{currency(l.amount, cur)}</td></>}
    </tr>
  );
}

function ReasonDialog({ title, label, button, required, onClose, onSubmit }: { title: string; label: string; button: string; required?: boolean; onClose: () => void; onSubmit: (r: string) => Promise<unknown> }) {
  const [r, setR] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <Modal title={title} onClose={onClose} footer={<><Button onClick={onClose}>Back</Button>
      <Button variant="danger" disabled={busy || (required && !r.trim())} onClick={() => { setBusy(true); onSubmit(r).finally(() => setBusy(false)); }}>{button}</Button></>}>
      <Field label={label}>{(id) => <textarea id={id} className="input" rows={3} autoFocus value={r} maxLength={4000} onChange={(e) => setR(e.target.value)} />}</Field>
    </Modal>
  );
}

function ReceiveDialog({ p, onClose, onDone }: { p: PD; onClose: () => void; onDone: (warnings: string[]) => void }) {
  const open = p.lines.map((l) => ({ l, left: Math.max(0, Number(l.quantity) - Number(l.received)) }));
  const [rows, setRows] = useState(() => Object.fromEntries(open.map(({ l, left }) => [l.id, { qty: left ? String(+left.toFixed(4)) : "", cost: l.unit_cost ?? "", loc: l.location_id }])));
  const [slip, setSlip] = useState("");
  const [note, setNote] = useState("");
  const [err, setErr] = useState("");
  const m = useMutation({
    mutationFn: () => api<PD>(`/purchase-orders/${p.id}/receive`, { method: "POST", body: {
      packing_slip: slip, note,
      lines: Object.entries(rows).filter(([, r]) => r.qty.trim() && Number(r.qty) !== 0).map(([line_id, r]) => ({ line_id, quantity: r.qty, ...(p.can.costs && r.cost !== "" ? { unit_cost: r.cost } : {}), location_id: r.loc })),
    } }),
    onSuccess: (d) => onDone(d.warnings ?? []),
    onError: (e) => setErr((e as ApiError).message),
  });
  const set = (id: string, patch: Partial<{ qty: string; cost: string; loc: string | null }>) => setRows((r) => ({ ...r, [id]: { ...r[id], ...patch } }));
  return (
    <Modal title={`Receive ${p.display_number}`} width={720} onClose={onClose}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={m.isPending} onClick={() => m.mutate()}>Receive</Button></>}>
      <p className="small muted">Enter what arrived. Parts go into stock at the location you pick. Use a negative number to correct an earlier receipt.</p>
      <div className="po-receive">
        {open.map(({ l, left }) => <div key={l.id} className="po-receive-row">
          <div className="grow"><span className="t">{l.description}</span>
            <span className="small faint" style={{ display: "block" }}>{q(l.received)} of {q(l.quantity)} {l.unit} received{left ? ` · ${q(String(left))} to go` : ""}</span></div>
          <Input aria-label={`Quantity of ${l.description}`} inputMode="decimal" value={rows[l.id].qty} onChange={(e) => set(l.id, { qty: e.target.value })} />
          {p.can.costs && <Input aria-label={`Unit cost of ${l.description}`} inputMode="decimal" value={rows[l.id].cost} onChange={(e) => set(l.id, { cost: e.target.value })} />}
          {l.part && <div className="po-receive-loc"><LocationPicker value={rows[l.id].loc} onChange={(v) => set(l.id, { loc: v })} placeholder="Main location" /></div>}
        </div>)}
      </div>
      <div className="po-form-grid">
        <Field label="Packing slip">{(id) => <Input id={id} value={slip} maxLength={120} onChange={(e) => setSlip(e.target.value)} />}</Field>
        <Field label="Note">{(id) => <Input id={id} value={note} maxLength={4000} onChange={(e) => setNote(e.target.value)} />}</Field>
      </div>
      {err && <div className="banner warning" role="alert">{err}</div>}
    </Modal>
  );
}

function SendDialog({ p, onClose, onDone }: { p: PD; onClose: () => void; onDone: (to: string[]) => void }) {
  const [to, setTo] = useState("");
  const [cc, setCc] = useState("");
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");
  const list = (s: string) => s.split(/[,;\s]+/).map((x) => x.trim()).filter(Boolean);
  const m = useMutation({
    mutationFn: () => api<PD & { sent: { sent_to: string[] } }>(`/purchase-orders/${p.id}/send`, { method: "POST", body: { message: msg, ...(to.trim() ? { to: list(to) } : {}), ...(cc.trim() ? { cc: list(cc) } : {}) } }),
    onSuccess: (d) => onDone(d.sent.sent_to),
    onError: (e) => setErr((e as ApiError).message),
  });
  return (
    <Modal title={`Send ${p.display_number}`} onClose={onClose} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={m.isPending} onClick={() => m.mutate()}><Mail size={15} />Send</Button></>}>
      <p className="small muted">The purchase order goes out as a PDF attachment. A copy is kept in its files.</p>
      <Field label="To" hint="Leave empty to use the vendor's purchase order contact">{(id) => <Input id={id} type="text" value={to} onChange={(e) => setTo(e.target.value)} placeholder="orders@vendor.com" />}</Field>
      <Field label="CC" hint="Leave empty for the vendor's CC contacts and your default CC list">{(id) => <Input id={id} value={cc} onChange={(e) => setCc(e.target.value)} />}</Field>
      <Field label="Message">{(id) => <textarea id={id} className="input" rows={3} value={msg} maxLength={4000} onChange={(e) => setMsg(e.target.value)} />}</Field>
      {err && <div className="banner warning" role="alert">{err}</div>}
    </Modal>
  );
}

function Comments({ id }: { id: string }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { session } = useSession();
  const c = useQuery({ queryKey: ["po-comments", id], queryFn: () => api<{ items: CommentItem[] }>(`/purchase-orders/${id}/comments`) });
  const [body, setBody] = useState("");
  const add = useMutation({ mutationFn: () => api(`/purchase-orders/${id}/comments`, { method: "POST", body: { body } }),
    onSuccess: () => { setBody(""); qc.invalidateQueries({ queryKey: ["po-comments", id] }); }, onError: (e) => toast((e as ApiError).message, { kind: "error" }) });
  const del = useMutation({ mutationFn: (cid: string) => api(`/purchase-orders/${id}/comments/${cid}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["po-comments", id] }), onError: (e) => toast((e as ApiError).message, { kind: "error" }) });
  return (
    <section className="card">
      <div className="card-head"><h3 className="sec-h" style={{ margin: 0 }}>Comments</h3></div>
      {(c.data?.items ?? []).map((x) => <div key={x.id} className="list-row" style={{ alignItems: "flex-start" }}>
        <Avatar name={x.author?.name ?? "?"} initials={x.author?.initials} src={x.author?.avatar_url} size="sm" />
        <span className="grow"><span className="small"><b>{x.author?.name ?? "Someone"}</b> <span className="faint">{timeAgo(x.created_at)}</span></span>
          <span className="prewrap" style={{ display: "block" }}>{x.body}</span></span>
        {x.author?.id === session.user?.id && <Button size="sm" variant="ghost" icon aria-label="Delete comment" onClick={() => del.mutate(x.id)}><Trash2 size={13} /></Button>}
      </div>)}
      <div className="card-body row" style={{ gap: 8, alignItems: "flex-end" }}>
        <textarea className="input grow" rows={2} aria-label="Write a comment" placeholder="Write a comment" value={body} maxLength={10000} onChange={(e) => setBody(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && body.trim()) add.mutate(); }} />
        <Button variant="primary" disabled={!body.trim() || add.isPending} onClick={() => add.mutate()}>Send</Button>
      </div>
    </section>
  );
}

/** What the vendor said through the emailed link (r261). */
function VendorAckCard({ a, tz }: { a: VendorAck; tz?: string }) {
  const tone = a.response === "declined" ? "danger" : a.response === "proposed_date" ? "warning" : a.response ? "success" : "neutral";
  return <section className="card" aria-label="Vendor's answer">
    <div className="card-head"><h3 className="sec-h" style={{ margin: 0 }}>Vendor's answer</h3><Pill tone={tone}>{a.response_label}</Pill></div>
    <div className="card-body small stack" style={{ gap: 4 }}>
      {a.response ? <>
        <div><b>{a.responder_name}</b>{a.responded_at && <span className="faint"> · {dateTime(a.responded_at, tz)}</span>}</div>
        {a.proposed_date && <div>Can deliver by <b>{new Date(a.proposed_date + "T00:00").toLocaleDateString()}</b></div>}
        {a.note && <div className="prewrap">“{a.note}”</div>}
      </> : <div className="muted">{a.last_viewed_at ? `The vendor opened the order ${dateTime(a.last_viewed_at, tz)} but hasn't answered yet.` : "The vendor hasn't opened the link in the email yet."}</div>}
      {a.status === "replaced" && <div className="faint">This was an earlier send; the latest email has a new link.</div>}
    </div>
  </section>;
}
