// The transactions log (r223): every stock change from the ledger, filterable and exportable.
import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useInfiniteQuery, useMutation } from "@tanstack/react-query";
import { ArrowLeft, Download } from "lucide-react";
import { api, ApiError, type ExportItem } from "../../lib/api";
import { useSession } from "../../lib/session";
import { dateTime } from "../../lib/format";
import { useToast } from "../../components/Toast";
import { Button, EmptyState, Input, ListSkeleton, Select } from "../../components/ui";
import { LocationPicker } from "../../components/assetPickers";
import { qsOf, type Txn } from "./types";
import "./parts.css";

const KINDS: [string, string][] = [["", "All changes"], ["restock,receive", "Restocks and receipts"], ["use,return", "Used and returned"], ["adjust,count", "Adjustments and counts"],
  ["transfer_out,transfer_in", "Moves"], ["initial", "Opening stock"]];

export function TxnTable({ filters, hidePart }: { filters: Record<string, string>; hidePart?: boolean }) {
  const { session } = useSession();
  const tz = session.org?.timezone;
  const qs = qsOf(filters);
  const q = useInfiniteQuery({
    queryKey: ["part-txns", qs],
    queryFn: ({ pageParam }) => api<{ items: Txn[]; next_cursor: string | null }>(`/parts/transactions?limit=50&${qs}${pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : ""}`),
    initialPageParam: "",
    getNextPageParam: (last) => last.next_cursor ?? undefined,
  });
  if (q.isLoading) return <ListSkeleton rows={4} />;
  if (q.isError) return <div className="banner warning">{(q.error as ApiError).message}</div>;
  const rows = (q.data?.pages ?? []).flatMap((p) => p.items);
  if (!rows.length) return <EmptyState title="No transactions yet">Restocks, parts used on work orders, adjustments and moves show here.</EmptyState>;
  return (
    <section className="card">
      <div className="table-wrap">
        <table className="table part-txn-table">
          <thead><tr><th>When</th>{!hidePart && <th>Part</th>}<th>Change</th><th className="num">Quantity</th><th className="num">After</th><th>Location</th><th>By</th><th>Details</th></tr></thead>
          <tbody>{rows.map((t) => (
            <tr key={t.id}>
              <td className="small" style={{ whiteSpace: "nowrap" }}>{dateTime(t.at, tz)}</td>
              {!hidePart && <td>{t.part ? <Link to={`/parts/${t.part.id}`}>{t.part.name}</Link> : <span className="faint">—</span>}</td>}
              <td><span className={"part-kind k-" + t.kind}>{t.kind_label}</span></td>
              <td className={"num " + (t.direction === "in" ? "part-in" : t.direction === "out" ? "part-out" : "")}>{t.direction === "in" ? "+" : ""}{t.quantity}</td>
              <td className="num">{t.after ?? "—"}</td>
              <td>{t.location?.name ?? <span className="faint">—</span>}</td>
              <td className="small">{t.user?.name ?? <span className="faint">System</span>}</td>
              <td className="small">{t.work_order ? <Link to={`/work-orders/${t.work_order.id}`}>#{t.work_order.number} {t.work_order.title}</Link> : null}
                {t.purchase_order_id && <Link to={`/purchase-orders/${t.purchase_order_id}`}>Purchase order</Link>}
                {t.note && <span className="faint">{t.work_order || t.purchase_order_id ? " · " : ""}{t.note}</span>}</td>
            </tr>))}</tbody>
        </table>
      </div>
      {q.hasNextPage && <div className="card-body"><Button size="sm" disabled={q.isFetchingNextPage} onClick={() => q.fetchNextPage()}>Load more</Button></div>}
    </section>
  );
}

export function TransactionsPage() {
  const { can } = useSession();
  const { toast } = useToast();
  const nav = useNavigate();
  const [kind, setKind] = useState("");
  const [loc, setLoc] = useState<string | null>(null);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const filters: Record<string, string> = { kind, location_id: loc ?? "", from: from ? new Date(from).toISOString() : "", to: to ? new Date(to + "T23:59:59").toISOString() : "" };
  const exp = useMutation({
    mutationFn: () => api<ExportItem>("/parts/export", { method: "POST", body: { report: "transactions", query: Object.fromEntries(Object.entries(filters).filter(([, v]) => v)) } }),
    onSuccess: () => toast("Export started. It'll be in the Download Center in a moment.", { action: { label: "Open", run: () => nav("/downloads") } }),
    onError: (e) => toast((e as ApiError).message, { kind: "error" }),
  });
  return (
    <div className="wo-page"><div className="wo-scroll page-narrow">
      <Link to="/parts" className="row small"><ArrowLeft size={14} />Parts</Link>
      <div className="row" style={{ justifyContent: "space-between", margin: "8px 0 12px" }}>
        <h1>Transactions</h1>
        {can("exports.use") && <Button onClick={() => exp.mutate()} disabled={exp.isPending}><Download size={15} />Export CSV</Button>}
      </div>
      <div className="asset-filters part-filters" style={{ marginBottom: 12 }}>
        <Select aria-label="Kind of change" value={kind} onChange={(e) => setKind(e.target.value)}>{KINDS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select>
        <div className="asset-filter-loc"><LocationPicker value={loc} onChange={setLoc} placeholder="Any location" /></div>
        <label className="row small" style={{ gap: 6 }}>From<Input type="date" aria-label="From" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
        <label className="row small" style={{ gap: 6 }}>To<Input type="date" aria-label="To" value={to} onChange={(e) => setTo(e.target.value)} /></label>
      </div>
      <TxnTable filters={filters} />
    </div></div>
  );
}
