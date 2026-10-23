// Finance reports: vendor spend and on-time (paid / delivered), receivables ageing, tax to reclaim, and the
// exempt-purchases report for tax audits. Each one exports to the Download Center.
import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Download } from "lucide-react";
import { api, ApiError } from "../../lib/api";
import { useToast } from "../../components/Toast";
import { Button, EmptyState, Input, ListSkeleton } from "../../components/ui";
import { day, money, todayISO, type FinanceMe, type Paged, type Receipt } from "./types";

type Spend = { vendor: { id: string; name: string } | null; invoices: number; spend: string; paid_on_time_pct: number | null;
  delivered_on_time_pct: number | null; deliveries: number };
type Ageing = { customer: { id: string; name: string } | null; current: string; d1_30: string; d31_60: string; d61_90: string; d90_plus: string; total: string };
type Exempt = { certificate: string; certificate_id: string | null; jurisdiction: string; kind: string; reference: string; record_id: string;
  vendor: string; date: string; amount: string | null; tax_charged: string | null; currency: string };

export function ReportsTab({ me }: { me: FinanceMe }) {
  const [start, setStart] = useState(`${new Date().getFullYear()}-01-01`);
  const [end, setEnd] = useState(todayISO());
  const cur = me.currency;
  const nav = useNavigate();
  const { toast } = useToast();
  const range = `start=${start}&end=${end}`;
  const spend = useQuery({ queryKey: ["finance", "r-spend", range], queryFn: () => api<{ items: Spend[] }>(`/finance/reports/vendor-spend?${range}`) });
  const ageing = useQuery({ queryKey: ["finance", "r-ageing"], queryFn: () => api<{ as_of: string; items: Ageing[] }>("/finance/reports/ageing") });
  const reclaim = useQuery({ queryKey: ["finance", "r-reclaim"], queryFn: () => api<Paged<Receipt> & { tax_total: string }>("/finance/reports/tax-reclaim?per_page=200") });
  const exempt = useQuery({ queryKey: ["finance", "r-exempt", range], enabled: me.can["finance.tax_certificates"],
    queryFn: () => api<{ items: Exempt[] }>(`/finance/reports/exempt-purchases?${range}`) });
  const exp = useMutation({ mutationFn: (kind: string) => api("/finance/exports", { method: "POST", body: { kind, start, end } }),
    onSuccess: () => toast("Export started. It'll be in the Download Center in a moment.", { action: { label: "Open", run: () => nav("/downloads") } }),
    onError: (e) => toast((e as ApiError).message, { kind: "error" }) });
  const ExportBtn = ({ kind }: { kind: string }) => me.can["finance.export"]
    ? <Button size="sm" onClick={() => exp.mutate(kind)}><Download size={14} />CSV</Button> : null;
  return (
    <div className="fin-wide stack">
      <div className="row wrap" style={{ justifyContent: "space-between" }}>
        <h1>Reports</h1>
        <div className="row"><Input type="date" value={start} onChange={(e) => setStart(e.target.value)} aria-label="From" />
          <span className="faint">to</span><Input type="date" value={end} onChange={(e) => setEnd(e.target.value)} aria-label="To" /></div>
      </div>

      <section className="card">
        <div className="card-head"><h3 className="sec-h">Vendor spend and on-time</h3><ExportBtn kind="vendor_spend" /></div>
        {spend.isLoading ? <ListSkeleton rows={3} /> : !spend.data?.items.length ? <EmptyState title="No approved invoices in this period" /> : (
          <div className="table-wrap"><table className="table fin-table">
            <thead><tr><th>Vendor</th><th className="num">Invoices</th><th className="num">Spend</th><th className="num">Paid on time</th><th className="num">Delivered on time</th></tr></thead>
            <tbody>{spend.data.items.map((r, i) => <tr key={r.vendor?.id ?? i}><td>{r.vendor?.name ?? "(no vendor)"}</td><td className="num">{r.invoices}</td>
              <td className="num">{money(r.spend, cur)}</td><td className="num">{r.paid_on_time_pct === null ? "—" : `${r.paid_on_time_pct}%`}</td>
              <td className="num">{r.delivered_on_time_pct === null ? "—" : `${r.delivered_on_time_pct}% of ${r.deliveries}`}</td></tr>)}</tbody>
          </table></div>)}
      </section>

      <section className="card">
        <div className="card-head"><h3 className="sec-h">Receivables ageing</h3><ExportBtn kind="ageing" /></div>
        {ageing.isLoading ? <ListSkeleton rows={3} /> : !ageing.data?.items.length ? <EmptyState title="Nothing outstanding" /> : (
          <div className="table-wrap"><table className="table fin-table">
            <thead><tr><th>Customer</th><th className="num">Current</th><th className="num">1–30</th><th className="num">31–60</th><th className="num">61–90</th><th className="num">90+</th><th className="num">Total</th></tr></thead>
            <tbody>{ageing.data.items.map((r, i) => <tr key={r.customer?.id ?? i}><td>{r.customer?.name}</td>
              {(["current", "d1_30", "d31_60", "d61_90", "d90_plus", "total"] as const).map((k) => <td key={k} className={"num" + (k === "d90_plus" && Number(r[k]) > 0 ? " fin-bad-text" : "")}>{money(r[k], cur)}</td>)}</tr>)}</tbody>
          </table></div>)}
      </section>

      <section className="card">
        <div className="card-head"><h3 className="sec-h">Tax to reclaim{reclaim.data ? ` · ${money(reclaim.data.tax_total, cur)}` : ""}</h3></div>
        {reclaim.isLoading ? <ListSkeleton rows={2} /> : !reclaim.data?.items.length ? <EmptyState title="Nothing to reclaim">Receipts charged tax despite an exemption show up here.</EmptyState> : (
          <div className="table-wrap"><table className="table fin-table">
            <thead><tr><th>Date</th><th>Vendor</th><th className="num">Tax</th><th className="num">Total</th></tr></thead>
            <tbody>{reclaim.data.items.map((r) => <tr key={r.id}><td>{day(r.purchased_on)}</td><td><Link to={`/finance/receipts/${r.id}`}>{r.vendor?.name || r.vendor_name}</Link></td>
              <td className="num">{money(r.tax, r.currency)}</td><td className="num">{money(r.total, r.currency)}</td></tr>)}</tbody>
          </table></div>)}
      </section>

      {me.can["finance.tax_certificates"] && <section className="card">
        <div className="card-head"><h3 className="sec-h">Exempt purchases</h3><ExportBtn kind="exempt_purchases" /></div>
        {exempt.isLoading ? <ListSkeleton rows={2} /> : !exempt.data?.items.length ? <EmptyState title="No exempt purchases in this period" /> : (
          <div className="table-wrap"><table className="table fin-table">
            <thead><tr><th>Certificate</th><th>Date</th><th>Reference</th><th>Vendor</th><th className="num">Amount</th><th className="num">Tax charged</th></tr></thead>
            <tbody>{exempt.data.items.map((r) => <tr key={r.kind + r.record_id}><td>{r.certificate}</td><td>{day(r.date)}</td>
              <td>{r.kind === "purchase_order" ? <Link to={`/purchase-orders/${r.record_id}`}>{r.reference}</Link> : <Link to={`/finance/receipts/${r.record_id}`}>Receipt</Link>}</td>
              <td>{r.vendor}</td><td className="num">{money(r.amount, r.currency)}</td><td className={"num" + (Number(r.tax_charged) > 0 ? " fin-bad-text" : "")}>{money(r.tax_charged, r.currency)}</td></tr>)}</tbody>
          </table></div>)}
      </section>}
    </div>
  );
}
