// Receipts (MP-091): snap pages with the phone camera (auto-crop, straighten, read on the device), upload a picture
// or PDF, or forward to the receipts email address. Review the fields, then attach to a work order (adds a cost),
// a purchase order, a part restock or a general expense. Tax charged despite an exemption is flagged to reclaim.
import { useEffect, useMemo, useRef, useState } from "react";
import { DropZone } from "../../components/DropZone";
import { Link, useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, ArrowLeft, Camera, Check, Copy, FileUp, Mail, Plus, Search, Trash2, Wand2, X } from "lucide-react";
import { api, ApiError } from "../../lib/api";
import { useSession } from "../../lib/session";
import { useToast } from "../../components/Toast";
import { Button, Checkbox, EmptyState, Field, Input, ListSkeleton, Modal, Pill, Select } from "../../components/ui";
import { preparePage, readPages, type Page } from "./capture";
import { day, money, postForm, RECEIPT_STATUS, todayISO, type FinanceMe, type Paged, type Receipt } from "./types";

const FILTERS: [string, string][] = [["", "All"], ["new", "To review"], ["matched", "Matched"], ["to_reclaim", "Tax to reclaim"],
  ["requested", "Reimbursements"]];

export function ReceiptsTab({ me, id, single }: { me: FinanceMe; id?: string; single?: boolean }) {
  const [filter, setFilter] = useState("");
  const [q, setQ] = useState("");
  const [capture, setCapture] = useState(false);
  const nav = useNavigate();
  const params = new URLSearchParams();
  if (filter === "new" || filter === "matched") params.set("status", filter === "new" ? "new,duplicate" : "matched");
  if (filter === "to_reclaim") params.set("tax_reclaim", "to_reclaim");
  if (filter === "requested") params.set("reimbursement", "requested");
  if (q.trim()) params.set("q", q.trim());
  const list = useQuery({ queryKey: ["finance", "receipts", params.toString()], queryFn: () => api<Paged<Receipt>>(`/finance/receipts?${params}`) });
  const filters = me.can["finance.view"] ? FILTERS : FILTERS.filter(([k]) => k !== "to_reclaim" && k !== "requested");
  return (
    <div className={"split fin-split" + (id ? " has-detail" : "")}>
      <div className="split-list">
        <div className="list-tools">
          <div className="row" style={{ justifyContent: "space-between" }}>
            <h1>{single ? "My receipts" : "Receipts"}</h1>
            <Button variant="primary" onClick={() => setCapture(true)}><Plus size={16} />Add receipt</Button>
          </div>
          {me.receipts_address && <EmailIn address={me.receipts_address} />}
          <div className="seg fin-seg" role="tablist" aria-label="Filter">
            {filters.map(([k, l]) => <button key={k} type="button" role="tab" aria-selected={filter === k}
              className={"seg-btn" + (filter === k ? " on" : "")} onClick={() => setFilter(k)}>{l}</button>)}
          </div>
          <div className="search-in"><Search size={15} className="faint" />
            <Input placeholder="Search vendor or category" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search receipts" /></div>
        </div>
        <div className="list" aria-label="Receipts">
          {list.isLoading ? <ListSkeleton /> : !list.data?.items.length
            ? <EmptyState icon={<Camera size={28} />} title="No receipts yet">Snap a receipt with your phone, upload a picture or PDF{me.receipts_address ? ", or email it" : ""}.</EmptyState>
            : list.data.items.map((r) => <ReceiptRow key={r.id} r={r} active={r.id === id} />)}
        </div>
      </div>
      <div className="split-detail">
        {id ? <ReceiptDetail id={id} me={me} onBack={() => nav("/finance/receipts")} />
          : <EmptyState title="Pick a receipt">Or add one: the camera straightens and reads it right on your phone.</EmptyState>}
      </div>
      {capture && <CaptureModal onClose={() => setCapture(false)} onDone={(r) => { setCapture(false); nav(`/finance/receipts/${r.id}`); }} />}
    </div>
  );
}

function EmailIn({ address }: { address: string }) {
  const { toast } = useToast();
  return <button type="button" className="fin-email" onClick={() => { void navigator.clipboard?.writeText(address); toast("Address copied"); }}
    title="Forward receipts to this address"><Mail size={14} /><span className="grow">{address}</span><Copy size={13} /></button>;
}

function ReceiptRow({ r, active }: { r: Receipt; active: boolean }) {
  const [label, tone] = RECEIPT_STATUS[r.status];
  return (
    <Link to={`/finance/receipts/${r.id}`} className={"list-row" + (active ? " active" : "")}>
      <div className="fin-thumb" aria-hidden>{r.file?.thumb_url ? <img src={r.file.thumb_url} alt="" loading="lazy" /> : <FileUp size={18} />}</div>
      <div className="grow">
        <div className="t">{r.vendor?.name || r.vendor_name || "Receipt"}</div>
        <div className="s">{day(r.purchased_on || r.created_at)}{r.expense_category ? ` · ${r.expense_category}` : ""}{r.submitted_by ? ` · ${r.submitted_by.name}` : ""}</div>
        <div className="row wrap fin-pills">
          <Pill tone={tone}>{label}</Pill>
          {r.tax_reclaim_status === "to_reclaim" && <Pill tone="warning">Tax to reclaim</Pill>}
          {r.reimbursement_status && <Pill tone={r.reimbursement_status === "rejected" ? "danger" : "neutral"}>Reimbursement {r.reimbursement_status}</Pill>}
        </div>
      </div>
      <div className="fin-amt">{money(r.total, r.currency)}</div>
    </Link>
  );
}

// ---- capture -------------------------------------------------------------------------------------------------
export function CaptureModal({ onClose, onDone, workOrderId }: { onClose: () => void; onDone: (r: Receipt) => void; workOrderId?: string }) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const cam = useRef<HTMLInputElement>(null);
  const pick = useRef<HTMLInputElement>(null);
  const [pages, setPages] = useState<Page[]>([]);
  const [files, setFiles] = useState<File[]>([]); // PDFs and plain uploads, sent as they are
  const [busy, setBusy] = useState("");
  const [progress, setProgress] = useState(0);
  const [straighten, setStraighten] = useState(true);
  useEffect(() => () => pages.forEach((p) => URL.revokeObjectURL(p.url)), [pages]);

  const addPhotos = async (list: FileList | null) => {
    if (!list?.length) return;
    setBusy("Straightening…");
    const out: Page[] = [];
    for (const f of Array.from(list)) {
      if (f.type === "application/pdf") { setFiles((x) => [...x, f]); continue; }
      if (!f.type.startsWith("image/")) { toast(`${f.name} isn't a picture or PDF.`, { kind: "error" }); continue; }
      out.push(await preparePage(f, { crop: straighten, deskew: straighten }));
    }
    setPages((p) => [...p, ...out].slice(0, 20));
    setBusy("");
  };
  const save = useMutation({
    mutationFn: async () => {
      let text = "";
      if (pages.length) {
        setBusy("Reading the receipt…");
        try { text = await readPages(pages.map((p) => p.blob), (f) => setProgress(f)); } catch { text = ""; /* reader unavailable: type it in */ }
      }
      setBusy("Uploading…");
      const blobs: (File | Blob)[] = [...pages.map((p, i) => new File([p.blob], `receipt-page-${i + 1}.jpg`, { type: "image/jpeg" })), ...files];
      return postForm<Receipt>("/finance/receipts", { files: blobs, source: pages.length ? "camera" : "upload", ocr_text: text || undefined,
        work_order_id: workOrderId });
    },
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ["finance"] });
      toast(r.status === "duplicate" ? "Saved. It looks like a receipt you already added — check it." : "Receipt saved");
      onDone(r);
    },
    onError: (e) => { setBusy(""); toast((e as ApiError).message, { kind: "error" }); },
  });
  const count = pages.length + files.length;
  return (
    <Modal title="Add a receipt" onClose={onClose} width={560}
      footer={<><Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" disabled={!count || !!busy} onClick={() => save.mutate()}>{busy || "Save receipt"}</Button></>}>
      <div className="stack">
        <DropZone accept="image/*,application/pdf" label="Drop receipt pictures or PDFs" onFiles={(fs) => { const dt = new DataTransfer(); fs.forEach((f) => dt.items.add(f)); void addPhotos(dt.files); }}>
        <div className="fin-capture-btns">
          <Button size="lg" variant="primary" onClick={() => cam.current?.click()} disabled={!!busy}><Camera size={18} />{pages.length ? "Add a page" : "Take a photo"}</Button>
          <Button size="lg" onClick={() => pick.current?.click()} disabled={!!busy}><FileUp size={18} />Upload picture or PDF</Button>
        </div>
        </DropZone>
        <input ref={cam} type="file" accept="image/*" capture="environment" hidden onChange={(e) => { void addPhotos(e.target.files); e.target.value = ""; }} />
        <input ref={pick} type="file" accept="image/*,application/pdf" multiple hidden onChange={(e) => { void addPhotos(e.target.files); e.target.value = ""; }} />
        <Checkbox checked={straighten} onChange={setStraighten} label="Crop to the paper and straighten photos" />
        {count > 0 && (
          <div className="fin-pages" aria-label="Pages">
            {pages.map((p, i) => (
              <figure key={p.url} className="fin-page">
                <img src={p.url} alt={`Page ${i + 1}`} />
                <figcaption>Page {i + 1}{p.cropped || p.angle ? <span className="faint"> · <Wand2 size={11} /> {p.cropped ? "cropped" : ""}{p.cropped && p.angle ? ", " : ""}{p.angle ? `straightened ${p.angle}°` : ""}</span> : null}</figcaption>
                <button type="button" className="fin-page-x" aria-label={`Remove page ${i + 1}`} onClick={() => setPages((x) => x.filter((_, j) => j !== i))}><X size={14} /></button>
              </figure>
            ))}
            {files.map((f, i) => (
              <figure key={f.name + i} className="fin-page file"><FileUp size={22} /><figcaption>{f.name}</figcaption>
                <button type="button" className="fin-page-x" aria-label={`Remove ${f.name}`} onClick={() => setFiles((x) => x.filter((_, j) => j !== i))}><X size={14} /></button>
              </figure>
            ))}
          </div>
        )}
        {busy.startsWith("Reading") && <div className="fin-progress" role="progressbar" aria-valuenow={Math.round(progress * 100)} aria-valuemin={0} aria-valuemax={100}>
          <div style={{ width: `${Math.round(progress * 100)}%` }} /></div>}
        <p className="faint fin-small">Long receipt? Take one photo per section; they're kept as pages of the same receipt. Reading happens on this device.</p>
      </div>
    </Modal>
  );
}

// ---- detail ------------------------------------------------------------------------------------------------------
type Suggest = { purchase_orders: { id: string; number: string; total: string; vendor: { name: string } | null }[];
  work_orders: { id: string; number: number; title: string; status: string }[];
  card_transactions: { id: string; posted_on: string; merchant: string; amount: string }[] };

function ReceiptDetail({ id, me, onBack }: { id: string; me: FinanceMe; onBack: () => void }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const q = useQuery({ queryKey: ["finance", "receipt", id], queryFn: () => api<Receipt>(`/finance/receipts/${id}`) });
  const [f, setF] = useState<Record<string, string | boolean>>({});
  const r = q.data;
  useEffect(() => {
    if (!r) return;
    setF({ vendor_name: r.vendor?.name || r.vendor_name, purchased_on: r.purchased_on ?? "", subtotal: r.subtotal ?? "", tax: r.tax ?? "",
      total: r.total ?? "", card_last4: r.card_last4, region: r.region, expense_category: r.expense_category, paid_personally: r.paid_personally });
  }, [r]);
  const done = (x: Receipt, msg?: string) => { qc.setQueryData(["finance", "receipt", id], x); void qc.invalidateQueries({ queryKey: ["finance", "receipts"] });
    void qc.invalidateQueries({ queryKey: ["finance", "summary"] }); if (msg) toast(msg); };
  const err = (e: unknown) => toast((e as ApiError).message, { kind: "error" });
  const patch = useMutation({ mutationFn: (body: Record<string, unknown>) => api<Receipt>(`/finance/receipts/${id}`, { method: "PATCH", body }),
    onSuccess: (x) => done(x, "Saved"), onError: err });
  const act = useMutation({ mutationFn: ({ path, body }: { path: string; body?: unknown }) => api<Receipt>(`/finance/receipts/${id}/${path}`, { method: "POST", body: body ?? {} }),
    onSuccess: (x) => done(x), onError: err });
  const del = useMutation({ mutationFn: () => api(`/finance/receipts/${id}`, { method: "DELETE" }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ["finance"] }); onBack(); }, onError: err });
  if (q.isLoading) return <div className="detail"><ListSkeleton rows={4} /></div>;
  if (!r) return <div className="detail"><EmptyState title="Receipt not found" /></div>;
  const ro = r.locked;
  const set = (k: string) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }));
  const dirty = Object.entries(f).some(([k, v]) => String(v ?? "") !== String((k === "vendor_name" ? (r.vendor?.name || r.vendor_name) : (r as unknown as Record<string, unknown>)[k]) ?? ""));
  const [label, tone] = RECEIPT_STATUS[r.status];
  const mine = r.submitted_by?.id && !me.can["finance.view"];
  return (
    <div className="detail fin-detail">
      <div className="detail-head">
        <Button icon className="fin-back" aria-label="Back to receipts" onClick={onBack}><ArrowLeft size={18} /></Button>
        <h2 className="grow">{r.vendor?.name || r.vendor_name || "Receipt"}</h2>
        <Pill tone={tone}>{label}</Pill>
        {!ro && <Button icon aria-label="Delete receipt" title="Delete" onClick={() => { if (confirm("Delete this receipt?")) del.mutate(); }}><Trash2 size={16} /></Button>}
      </div>
      {r.status === "duplicate" && (
        <div className="fin-banner warn"><AlertTriangle size={16} /><span className="grow">This looks like a receipt that was already added
          {r.duplicate_of_id ? <> (<Link to={`/finance/receipts/${r.duplicate_of_id}`}>open it</Link>)</> : null}.</span>
          <Button size="sm" onClick={() => act.mutate({ path: "not-duplicate" })}>Not a duplicate</Button></div>
      )}
      {r.tax_flagged && (
        <div className="fin-banner warn"><AlertTriangle size={16} />
          <span className="grow">Sales tax of {money(r.tax, r.currency)} was charged, but a tax exemption certificate is on file with this vendor.
            {r.tax_reclaim_status === "to_reclaim" ? " Ask the vendor for a refund." : r.tax_reclaim_status ? ` Marked ${r.tax_reclaim_status}.` : ""}</span>
          {me.can["finance.view"] && r.tax_reclaim_status === "to_reclaim" && <>
            <Button size="sm" onClick={() => act.mutate({ path: "reclaim", body: { status: "reclaimed" } })}>Reclaimed</Button>
            <Button size="sm" variant="ghost" onClick={() => act.mutate({ path: "reclaim", body: { status: "waived" } })}>Waive</Button></>}
        </div>
      )}
      {ro && <div className="fin-banner"><Check size={16} />Approved for reimbursement — this receipt is read-only now.</div>}
      <div className="fin-receipt-grid">
        <div className="fin-images">
          {(r.pages ?? (r.file ? [r.file] : [])).map((p) => p.content_type.startsWith("image/")
            ? <a key={p.id} href={p.url} target="_blank" rel="noreferrer"><img src={p.url} alt={p.name} loading="lazy" /></a>
            : <a key={p.id} href={p.url} target="_blank" rel="noreferrer" className="fin-pdf"><FileUp size={20} />{p.name}</a>)}
          {!r.file && <EmptyState title="No picture">Typed in by hand.</EmptyState>}
        </div>
        <form className="stack" onSubmit={(e) => { e.preventDefault(); patch.mutate({ ...f, confirm: true }); }}>
          <div className="fin-form-grid">
            <Field label="Vendor">{(fid) => <Input id={fid} value={String(f.vendor_name ?? "")} onChange={set("vendor_name")} disabled={ro} />}</Field>
            <Field label="Date">{(fid) => <Input id={fid} type="date" max={todayISO()} value={String(f.purchased_on ?? "")} onChange={set("purchased_on")} disabled={ro} />}</Field>
            <Field label="Subtotal">{(fid) => <Input id={fid} inputMode="decimal" value={String(f.subtotal ?? "")} onChange={set("subtotal")} disabled={ro} />}</Field>
            <Field label="Tax">{(fid) => <Input id={fid} inputMode="decimal" value={String(f.tax ?? "")} onChange={set("tax")} disabled={ro} />}</Field>
            <Field label={`Total (${r.currency})`}>{(fid) => <Input id={fid} inputMode="decimal" value={String(f.total ?? "")} onChange={set("total")} disabled={ro} />}</Field>
            <Field label="Card (last 4)">{(fid) => <Input id={fid} inputMode="numeric" maxLength={4} value={String(f.card_last4 ?? "")} onChange={set("card_last4")} disabled={ro} />}</Field>
            <Field label="State / province" hint="Where it was bought">{(fid) => <Input id={fid} value={String(f.region ?? "")} onChange={set("region")} disabled={ro} />}</Field>
            <Field label="Category">{(fid) => <Select id={fid} value={String(f.expense_category ?? "")} onChange={set("expense_category")} disabled={ro}>
              <option value="">—</option>{[...new Set([...me.expense_categories, String(f.expense_category || "")])].filter(Boolean).map((c) => <option key={c}>{c}</option>)}</Select>}</Field>
          </div>
          <Checkbox checked={!!f.paid_personally} onChange={(v) => setF((x) => ({ ...x, paid_personally: v }))} disabled={ro} label="I paid with my own money" />
          {r.extracted && Object.keys(r.extracted).length > 0 && <p className="faint fin-small">Filled in from the {r.reader === "pdf_text" ? "PDF" : "photo"}: check the amounts.</p>}
          {!ro && <div className="row"><Button variant="primary" type="submit" disabled={patch.isPending}>{r.status === "new" ? "Confirm" : dirty ? "Save" : "Saved"}</Button></div>}
        </form>
      </div>
      <AttachPanel r={r} me={me} onDone={done} />
      <Reimbursement r={r} me={me} mine={!!mine} run={(action) => act.mutate({ path: "reimbursement", body: { action } })} />
    </div>
  );
}

function AttachPanel({ r, me, onDone }: { r: Receipt; me: FinanceMe; onDone: (x: Receipt, msg?: string) => void }) {
  const { toast } = useToast();
  const sug = useQuery({ queryKey: ["finance", "receipt", r.id, "suggest"], queryFn: () => api<Suggest>(`/finance/receipts/${r.id}/suggestions`) });
  const [target, setTarget] = useState<"work_order" | "purchase_order" | "part" | "expense">("work_order");
  const [woNumber, setWoNumber] = useState("");
  const [partQ, setPartQ] = useState("");
  const [qty, setQty] = useState("1");
  const [cat, setCat] = useState(r.expense_category);
  const attach = useMutation({ mutationFn: (body: Record<string, unknown>) => api<Receipt>(`/finance/receipts/${r.id}/attach`, { method: "POST", body }),
    onSuccess: (x) => onDone(x, "Attached"), onError: (e) => toast((e as ApiError).message, { kind: "error" }) });
  const parts = useQuery({ queryKey: ["finance", "parts", partQ], enabled: target === "part" && partQ.trim().length > 1,
    queryFn: () => api<{ items: { id: string; name: string; part_number: string }[] }>(`/parts?q=${encodeURIComponent(partQ.trim())}&per_page=8`) });
  const byNumber = async () => {
    try {
      const wo = await api<{ id: string }>(`/work-orders/${encodeURIComponent(woNumber.replace(/^#/, ""))}`);
      attach.mutate({ target: "work_order", id: wo.id });
    } catch (e) { toast((e as ApiError).message || "Work order not found", { kind: "error" }); }
  };
  const linked = r.work_order_id ? "a work order" : r.purchase_order_id ? "a purchase order" : r.part_id ? "a part restock" : r.status === "matched" && r.expense_category ? `${r.expense_category} expenses` : "";
  if (r.locked) return null;
  return (
    <section className="card card-pad stack">
      <div className="row"><h3 className="sec-h grow">What was it for?</h3>{linked && <Pill tone="success">Attached to {linked}</Pill>}</div>
      <div className="seg fin-seg" role="tablist" aria-label="Attach to">
        {([["work_order", "Work order"], ["purchase_order", "Purchase order"], ["part", "Part restock"], ["expense", "Expense"]] as const).map(([k, l]) =>
          <button key={k} type="button" role="tab" aria-selected={target === k} className={"seg-btn" + (target === k ? " on" : "")} onClick={() => setTarget(k)}>{l}</button>)}
      </div>
      {target === "work_order" && <>
        {!!sug.data?.work_orders.length && <div className="fin-chips">{sug.data.work_orders.map((w) =>
          <button key={w.id} type="button" className={"fin-chip" + (r.work_order_id === w.id ? " on" : "")} onClick={() => attach.mutate({ target: "work_order", id: w.id })}>
            #{w.number} {w.title}</button>)}</div>}
        <div className="row"><Input placeholder="Work order #" value={woNumber} onChange={(e) => setWoNumber(e.target.value)} aria-label="Work order number" inputMode="numeric" />
          <Button disabled={!woNumber.trim() || attach.isPending} onClick={() => void byNumber()}>Attach</Button></div>
        <p className="faint fin-small">Adds the total as a cost on the work order, with this receipt.</p>
      </>}
      {target === "purchase_order" && (sug.data?.purchase_orders.length
        ? <div className="fin-chips">{sug.data.purchase_orders.map((p) => <button key={p.id} type="button" className={"fin-chip" + (r.purchase_order_id === p.id ? " on" : "")}
          onClick={() => attach.mutate({ target: "purchase_order", id: p.id })}>{p.number} · {p.vendor?.name ?? ""} · {money(p.total, r.currency)}</button>)}</div>
        : <p className="muted">No purchase order matches this vendor and amount.</p>)}
      {target === "part" && <>
        <div className="row"><Input placeholder="Search parts" value={partQ} onChange={(e) => setPartQ(e.target.value)} aria-label="Search parts" />
          <Input style={{ width: 90 }} inputMode="decimal" value={qty} onChange={(e) => setQty(e.target.value)} aria-label="Quantity bought" /></div>
        <div className="fin-chips">{parts.data?.items.map((p) => <button key={p.id} type="button" className="fin-chip"
          onClick={() => attach.mutate({ target: "part", id: p.id, quantity: qty })}>{p.name}{p.part_number ? ` (${p.part_number})` : ""}</button>)}</div>
        <p className="faint fin-small">Restocks the part at the receipt's price (before tax).</p>
      </>}
      {target === "expense" && <div className="row">
        <Select value={cat} onChange={(e) => setCat(e.target.value)} aria-label="Expense category"><option value="">Pick a category</option>
          {me.expense_categories.map((c) => <option key={c}>{c}</option>)}</Select>
        <Button disabled={!cat || attach.isPending} onClick={() => attach.mutate({ target: "expense", category: cat })}>Save</Button></div>}
    </section>
  );
}

function Reimbursement({ r, me, mine, run }: { r: Receipt; me: FinanceMe; mine: boolean; run: (action: string) => void }) {
  const approver = me.can["finance.invoices.approve"];
  if (!r.paid_personally && !r.reimbursement_status) return null;
  return (
    <section className="card card-pad row wrap">
      <div className="grow"><h3 className="sec-h">Reimbursement</h3>
        <p className="muted">{({ "": "Not requested yet.", requested: "Waiting for approval.", approved: "Approved; it'll be in the next payout.",
          rejected: "Rejected.", exported: "Sent to payroll.", paid: "Paid." } as Record<string, string>)[r.reimbursement_status]}</p></div>
      {(r.reimbursement_status === "" || r.reimbursement_status === "rejected") && (mine || r.submitted_by) &&
        <Button variant="primary" onClick={() => run("request")}>Ask to be reimbursed</Button>}
      {approver && r.reimbursement_status === "requested" && <><Button onClick={() => run("reject")}>Reject</Button>
        <Button variant="primary" onClick={() => run("approve")}>Approve</Button></>}
      {approver && (r.reimbursement_status === "approved" || r.reimbursement_status === "exported") && <Button onClick={() => run("paid")}>Mark paid</Button>}
    </section>
  );
}

// ---- the Receipts section on a work order -------------------------------------------------------------------
export function WOReceipts({ woId }: { woId: string }) {
  const { can } = useSession();
  const [open, setOpen] = useState(false);
  const allowed = can("finance.receipts");
  const q = useQuery({ queryKey: ["finance", "wo-receipts", woId], enabled: allowed,
    queryFn: () => api<{ items: Receipt[] }>(`/finance/work-orders/${woId}/receipts`) });
  const qc = useQueryClient();
  const nav = useNavigate();
  const items = useMemo(() => q.data?.items ?? [], [q.data]);
  if (!allowed) return null;
  return (
    <section className="card">
      <div className="card-head"><h3 className="sec-h">Receipts</h3>
        <Button size="sm" onClick={() => setOpen(true)}><Camera size={15} />Add receipt</Button></div>
      {items.length > 0 && <div className="fin-wo-receipts">{items.map((r) => (
        <Link key={r.id} to={`/finance/receipts/${r.id}`} className="list-row">
          <div className="fin-thumb" aria-hidden>{r.file?.thumb_url ? <img src={r.file.thumb_url} alt="" loading="lazy" /> : <FileUp size={16} />}</div>
          <div className="grow"><div className="t">{r.vendor?.name || r.vendor_name || "Receipt"}</div><div className="s">{day(r.purchased_on || r.created_at)} · {RECEIPT_STATUS[r.status][0]}</div></div>
          <div className="fin-amt">{money(r.total, r.currency)}</div>
        </Link>))}</div>}
      {open && <CaptureModal workOrderId={woId} onClose={() => setOpen(false)} onDone={(r) => {
        setOpen(false); void qc.invalidateQueries({ queryKey: ["finance", "wo-receipts", woId] }); nav(`/finance/receipts/${r.id}`);
      }} />}
    </section>
  );
}
