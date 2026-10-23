// Purchase Orders (0.5.0, MP-042–044): MaintainX list + detail. Status tabs (Open, Awaiting approval, Overdue,
// Completed, All), search, vendor filter, a restock suggestions view (low stock → POs), CSV export.
// Mobile (r232): the list and the detail take the whole screen in turn. "Order this part" lands here with
// ?new=1&part_id=…&vendor_id=…&quantity=… and opens the form prefilled.
import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, FileSpreadsheet, Lightbulb, MoreHorizontal, Plus, Search, Settings2, ShoppingCart } from "lucide-react";
import { api, ApiError, type ExportItem } from "../../lib/api";
import { useSession } from "../../lib/session";
import { currency, timeAgo } from "../../lib/format";
import { useToast } from "../../components/Toast";
import { Button, Dropdown, EmptyState, Input, ListSkeleton, Select } from "../../components/ui";
import { PODetailView, POStatusPill } from "./PODetail";
import { POForm, useVendorsLite, type POPrefill } from "./POForm";
import { q as fmtQ, usePOOptions, type POList, type Suggestion } from "./types";
import "./purchasing.css";

const TABS: [string, string][] = [["open", "Open"], ["awaiting_me", "Awaiting my approval"], ["overdue", "Overdue"], ["complete", "Completed"], ["", "All"]];

export function PurchaseOrdersPage() {
  const { id } = useParams();
  const [params, setParams] = useSearchParams();
  const nav = useNavigate();
  const { toast } = useToast();
  const opts = usePOOptions();
  const can = opts.data?.can;
  const [tab, setTab] = useState(() => { try { return sessionStorage.getItem("po.tab") ?? "open"; } catch { return "open"; } });
  const [search, setSearch] = useState("");
  const [vendorId, setVendorId] = useState("");
  const [prefill, setPrefill] = useState<POPrefill | null>(null);
  useEffect(() => { try { sessionStorage.setItem("po.tab", tab); } catch { /* private mode */ } }, [tab]);
  useEffect(() => {
    if (params.get("new") !== "1") return;
    setPrefill({ part_id: params.get("part_id") ?? undefined, vendor_id: params.get("vendor_id") ?? undefined, quantity: params.get("quantity") ?? undefined,
      work_order_id: params.get("work_order_id") ?? undefined });
    const p = new URLSearchParams(params);
    ["new", "part_id", "vendor_id", "quantity", "work_order_id"].forEach((k) => p.delete(k));
    setParams(p, { replace: true });
  }, [params, setParams]);
  const exportCsv = useMutation({
    mutationFn: () => api<ExportItem>("/purchase-orders/export", { method: "POST", body: {} }),
    onSuccess: () => toast("Export started. It'll be in the Download Center in a moment.", { action: { label: "Open", run: () => nav("/downloads") } }),
    onError: (e) => toast((e as ApiError).message, { kind: "error" }),
  });
  const canCreate = !!(can?.manage || can?.request);
  const suggestionsView = id === "suggestions";

  return (
    <div className="wo-page">
      <div className={"split wo-split" + (id ? " has-detail" : "")}>
        <div className="split-list">
          <div className="list-tools wo-list-tools">
            <div className="row" style={{ justifyContent: "space-between" }}>
              <h1>Purchase Orders</h1>
              <div className="row">
                <Dropdown trigger={(_, t) => <Button icon aria-label="More" onClick={t}><MoreHorizontal size={18} /></Button>} width={250}>
                  {(close) => <>
                    {canCreate && <Link className="menu-item" to="/purchase-orders/suggestions" onClick={close}><Lightbulb size={15} />Restock suggestions</Link>}
                    {can?.export && <><button className="menu-item" onClick={() => { close(); exportCsv.mutate(); }}><Download size={15} />Export to CSV</button>
                      <Link className="menu-item" to="/downloads" onClick={close}><FileSpreadsheet size={15} />Download Center</Link></>}
                    {can?.settings && <><div className="menu-sep" /><Link className="menu-item" to="/settings/purchasing" onClick={close}><Settings2 size={15} />Purchasing settings</Link></>}
                  </>}
                </Dropdown>
                {canCreate && <Button variant="primary" onClick={() => setPrefill({})} aria-label="New Purchase Order"><Plus size={16} />New</Button>}
              </div>
            </div>
            <div className="seg po-tabs" role="tablist" aria-label="Status">
              {TABS.map(([k, l]) => <button key={k} type="button" role="tab" aria-selected={tab === k} className={"seg-btn" + (tab === k ? " on" : "")} onClick={() => setTab(k)}>{l}</button>)}
            </div>
            <div className="row" style={{ gap: 6 }}>
              <div className="search-in grow"><Search size={15} className="faint" />
                <Input placeholder="Search number, title, vendor or item" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search purchase orders" /></div>
              <VendorFilter value={vendorId} onChange={setVendorId} />
            </div>
          </div>
          <div className="list" aria-label="Purchase orders"><POListView status={tab} q={search} vendorId={vendorId} activeId={id} /></div>
        </div>
        <div className="split-detail">
          {suggestionsView ? <SuggestionsView />
            : id ? <PODetailView key={id} id={id} />
              : <EmptyState icon={<ShoppingCart size={28} />} title="Select a purchase order">Pick one from the list to see its items, approvals and what's arrived.</EmptyState>}
        </div>
      </div>
      {prefill && <POForm prefill={prefill} onClose={() => setPrefill(null)} onSaved={(po) => { setPrefill(null); nav(`/purchase-orders/${po.id}`); }} />}
    </div>
  );
}

function VendorFilter({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const v = useVendorsLite();
  if (!(v.data?.items ?? []).length) return null;
  return <Select aria-label="Vendor" value={value} onChange={(e) => onChange(e.target.value)} style={{ maxWidth: 160 }}>
    <option value="">All vendors</option>{(v.data?.items ?? []).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</Select>;
}

function POListView({ status, q, vendorId, activeId }: { status: string; q: string; vendorId: string; activeId?: string }) {
  const [page, setPage] = useState(1);
  const { session } = useSession();
  const qs = useMemo(() => new URLSearchParams(Object.entries({ status, q, vendor_id: vendorId, page: String(page), per_page: "50" }).filter(([, v]) => v)).toString(), [status, q, vendorId, page]);
  useEffect(() => setPage(1), [status, q, vendorId]);
  const list = useQuery({ queryKey: ["pos", qs], queryFn: () => api<POList>(`/purchase-orders?${qs}`), placeholderData: (p) => p });
  if (list.isLoading) return <ListSkeleton />;
  if (list.isError) return <EmptyState title="Couldn't load purchase orders">{(list.error as ApiError).message}</EmptyState>;
  const items = list.data?.items ?? [];
  const total = list.data?.total ?? 0;
  if (!items.length) return q || vendorId || status ? <EmptyState title="Nothing here">{status === "awaiting_me" ? "No purchase orders are waiting for you." : "No purchase orders match."}</EmptyState>
    : <EmptyState icon={<ShoppingCart size={26} />} title="No purchase orders yet">Order parts and services from your vendors. Press New to start.</EmptyState>;
  return (
    <>
      <div className="small muted" style={{ padding: "6px 16px" }}>{total} purchase order{total === 1 ? "" : "s"}</div>
      {items.map((p) => (
        <Link key={p.id} to={`/purchase-orders/${p.id}`} className={"list-row po-row" + (p.id === activeId ? " active" : "")}>
          <span className="grow" style={{ minWidth: 0 }}>
            <span className="row" style={{ gap: 6 }}><span className="mono small faint">{p.display_number}</span><span className="t grow">{p.title}</span></span>
            <span className="s">{[p.vendor?.name, p.due_on && `Due ${new Date(p.due_on + "T00:00").toLocaleDateString()}`, timeAgo(p.created_at)].filter(Boolean).join(" · ")}</span>
            <span className="row" style={{ gap: 6, marginTop: 4 }}><POStatusPill status={p.status} label={p.status_label} overdue={p.overdue} /></span>
          </span>
          {p.total !== null && <span className="po-row-total">{currency(p.total, p.currency || session.org?.currency)}</span>}
        </Link>))}
      {total > page * 50 && <div className="card-body"><Button size="sm" onClick={() => setPage(page + 1)}>Next page</Button></div>}
      {page > 1 && <div className="card-body" style={{ paddingTop: 0 }}><Button size="sm" variant="ghost" onClick={() => setPage(page - 1)}>Previous page</Button></div>}
    </>
  );
}

// ---------------------------------------------------------------- restock suggestions (MP-044)
function SuggestionsView() {
  const qc = useQueryClient();
  const nav = useNavigate();
  const { toast } = useToast();
  const { session } = useSession();
  const s = useQuery({ queryKey: ["po-suggestions"], queryFn: () => api<{ groups: Suggestion[] }>("/purchase-orders/suggestions") });
  const [picked, setPicked] = useState<Record<string, string[]>>({});
  const make = useMutation({
    mutationFn: (g: Suggestion) => api<{ id: string; display_number: string }>("/purchase-orders/from-suggestions", { method: "POST",
      body: { vendor_id: g.vendor_id, part_ids: picked[g.vendor_id ?? ""] ?? g.lines.map((l) => l.part_id) } }),
    onSuccess: (po) => { qc.invalidateQueries({ queryKey: ["po-suggestions"] }); qc.invalidateQueries({ queryKey: ["pos"] }); toast(`Created ${po.display_number}`); nav(`/purchase-orders/${po.id}`); },
    onError: (e) => toast((e as ApiError).message, { kind: "error" }),
  });
  if (s.isLoading) return <div className="detail"><ListSkeleton /></div>;
  if (s.isError) return <EmptyState title="Can't show suggestions">{(s.error as ApiError).message}</EmptyState>;
  const groups = s.data?.groups ?? [];
  return (
    <div className="detail">
      <Link to="/purchase-orders" className="small mobile-only">All purchase orders</Link>
      <div><h1 className="wo-title">Restock suggestions</h1>
        <p className="muted small">Parts below their minimum, grouped by preferred vendor. Quantities fill each location back to its maximum, minus what's already on order.</p></div>
      {groups.length === 0 && <EmptyState icon={<Lightbulb size={26} />} title="Nothing to restock">Every part with a minimum has enough in stock or on order.</EmptyState>}
      {groups.map((g) => {
        const key = g.vendor_id ?? "";
        const sel = picked[key] ?? g.lines.map((l) => l.part_id);
        return (
          <section key={key} className="card">
            <div className="card-head"><h3 className="sec-h" style={{ margin: 0 }}>{g.vendor_name ?? "No vendor"}</h3>
              <Button size="sm" variant="primary" disabled={!sel.length || make.isPending} onClick={() => make.mutate(g)}><ShoppingCart size={14} />Create PO ({sel.length})</Button></div>
            <div className="table-wrap"><table className="table">
              <thead><tr><th /><th>Part</th><th>Location</th><th className="num">In stock</th><th className="num">Min / Max</th><th className="num">On order</th><th className="num">Order</th><th className="num">Unit cost</th></tr></thead>
              <tbody>{g.lines.map((l) => <tr key={l.part_id + (l.location_id ?? "")}>
                <td><input type="checkbox" aria-label={`Include ${l.name}`} checked={sel.includes(l.part_id)}
                  onChange={(e) => setPicked((p) => ({ ...p, [key]: e.target.checked ? [...sel, l.part_id] : sel.filter((x) => x !== l.part_id) }))} /></td>
                <td><Link to={`/parts/${l.part_id}`}>{l.name}</Link>{(l.vendor_part_number || l.part_number) && <span className="small faint mono" style={{ display: "block" }}>{l.vendor_part_number || l.part_number}</span>}</td>
                <td>{l.location_name ?? <span className="faint">—</span>}</td>
                <td className="num">{fmtQ(l.on_hand)}</td><td className="num">{fmtQ(l.min_qty)} / {fmtQ(l.max_qty)}</td><td className="num">{fmtQ(l.ordered)}</td>
                <td className="num"><b>{fmtQ(l.quantity)}</b> <span className="small faint">{l.unit}</span></td>
                <td className="num">{l.unit_cost === null ? "—" : currency(l.unit_cost, session.org?.currency)}</td>
              </tr>)}</tbody></table></div>
          </section>);
      })}
    </div>
  );
}
