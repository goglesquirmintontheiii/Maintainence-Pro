// Documents vault (MP-094): every finance document in one searchable index — receipts, vendor and customer invoices,
// certificates. Kept for the retention period (7 years by default); approved documents are read-only; a legal hold
// stops deletion. The accountant export is a monthly ZIP (PDFs + CSV) or CSV for QuickBooks Online, Xero, NetSuite, Sage.
import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, FileText, Lock, Search, ShieldAlert } from "lucide-react";
import { api, ApiError } from "../../lib/api";
import { useToast } from "../../components/Toast";
import { Button, EmptyState, Field, Input, ListSkeleton, Modal, Pill, Select } from "../../components/ui";
import { day, money, type FinanceMe, type FinDoc, type Paged } from "./types";

const KINDS: [string, string][] = [["", "All"], ["receipt", "Receipts"], ["vendor_invoice", "Vendor invoices"], ["customer_invoice", "Customer invoices"],
  ["certificate", "Certificates"]];
const LINK: Record<string, string> = { receipt: "receipts", vendor_invoice: "vendor-invoices", customer_invoice: "customer-invoices", tax_certificate: "certificates" };

export function DocumentsTab({ me }: { me: FinanceMe }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [kind, setKind] = useState("");
  const [q, setQ] = useState("");
  const [hold, setHold] = useState(false);
  const [exporting, setExporting] = useState(false);
  const params = new URLSearchParams({ per_page: "100" });
  if (kind) params.set("kind", kind);
  if (q.trim()) params.set("q", q.trim());
  if (hold) params.set("hold", "1");
  const list = useQuery({ queryKey: ["finance", "documents", params.toString()], queryFn: () => api<Paged<FinDoc>>(`/finance/documents?${params}`) });
  const setHoldM = useMutation({ mutationFn: ({ id, on }: { id: string; on: boolean }) => api(`/finance/documents/${id}/hold`, { method: "POST", body: { hold: on } }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["finance", "documents"] }), onError: (e) => toast((e as ApiError).message, { kind: "error" }) });
  return (
    <div className="fin-wide stack">
      <div className="row wrap" style={{ justifyContent: "space-between" }}>
        <h1>Documents</h1>
        {me.can["finance.export"] && <Button variant="primary" onClick={() => setExporting(true)}><Download size={16} />Accountant export</Button>}
      </div>
      <div className="row wrap">
        <div className="seg fin-seg" role="tablist" aria-label="Kind">{KINDS.map(([k, l]) => <button key={k} type="button" role="tab" aria-selected={kind === k}
          className={"seg-btn" + (kind === k ? " on" : "")} onClick={() => setKind(k)}>{l}</button>)}</div>
        <button type="button" className={"fin-chip" + (hold ? " on" : "")} onClick={() => setHold(!hold)}><ShieldAlert size={13} />On legal hold</button>
      </div>
      <div className="search-in"><Search size={15} className="faint" /><Input placeholder="Search vendor, number, text…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search documents" /></div>
      <section className="card">
        {list.isLoading ? <ListSkeleton /> : !list.data?.items.length ? <EmptyState icon={<FileText size={28} />} title="Nothing found" /> : (
          <div className="fin-docs">{list.data.items.map((d) => (
            <div key={d.id} className="list-row fin-doc">
              <FileText size={18} className="faint" />
              <div className="grow">
                <div className="t">{d.record_id && LINK[d.record_type] ? <Link to={`/finance/${LINK[d.record_type]}/${d.record_id}`}>{d.title}</Link> : d.title}</div>
                <div className="s">{day(d.doc_date || d.created_at)}{d.amount ? ` · ${money(d.amount, d.currency)}` : ""}{d.retain_until ? ` · keep until ${day(d.retain_until)}` : ""}</div>
                <div className="row wrap fin-pills">{d.locked && <Pill><Lock size={11} /> Read-only</Pill>}{d.legal_hold && <Pill tone="danger">Legal hold</Pill>}</div>
              </div>
              {d.file && d.kind !== "certificate" && <a className="btn sm ghost" href={d.file.url} target="_blank" rel="noreferrer">Open</a>}
              {me.can["finance.export"] && <Button size="sm" variant="ghost" onClick={() => setHoldM.mutate({ id: d.id, on: !d.legal_hold })}>{d.legal_hold ? "Release hold" : "Legal hold"}</Button>}
            </div>))}</div>
        )}
      </section>
      {exporting && <ExportModal onClose={() => setExporting(false)} />}
    </div>
  );
}

function ExportModal({ onClose }: { onClose: () => void }) {
  const nav = useNavigate();
  const { toast } = useToast();
  const now = new Date();
  const last = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const [month, setMonth] = useState(`${last.getFullYear()}-${String(last.getMonth() + 1).padStart(2, "0")}`);
  const [format, setFormat] = useState("zip");
  const go = useMutation({ mutationFn: () => api("/finance/exports", { method: "POST", body: { kind: "accounting", month, format } }),
    onSuccess: () => { onClose(); toast("Export started. It'll be in the Download Center in a moment.", { action: { label: "Open", run: () => nav("/downloads") } }); },
    onError: (e) => toast((e as ApiError).message, { kind: "error" }) });
  return (
    <Modal title="Accountant export" onClose={onClose} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" onClick={() => go.mutate()}>Export</Button></>}>
      <div className="stack">
        <div className="fin-form-grid">
          <Field label="Month">{(fid) => <Input id={fid} type="month" value={month} onChange={(e) => setMonth(e.target.value)} />}</Field>
          <Field label="Format">{(fid) => <Select id={fid} value={format} onChange={(e) => setFormat(e.target.value)}>
            <option value="zip">ZIP: PDFs and CSV</option><option value="qbo">QuickBooks Online (CSV)</option><option value="xero">Xero (CSV)</option>
            <option value="netsuite">NetSuite (CSV)</option><option value="sage">Sage (CSV)</option></Select>}</Field>
        </div>
        <p className="faint fin-small">Approved and paid vendor bills, sent customer invoices, receipts and payments for the month.</p>
      </div>
    </Modal>
  );
}
