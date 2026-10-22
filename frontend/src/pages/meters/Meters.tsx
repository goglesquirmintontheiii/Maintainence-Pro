// Meters: list + detail split like Work Orders (MaintainX Meters), with bulk edit and monitoring points.
import { useEffect, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { CheckSquare, Clock, Gauge, MoreHorizontal, Pencil, Plus, Radio, Search, Trash2, X } from "lucide-react";
import "../../styles/meters.css";
import { api, ApiError } from "../../lib/api";
import type { Meter, Paged } from "../../lib/assets";
import { useSession } from "../../lib/session";
import { timeAgo } from "../../lib/format";
import { shortDate } from "../../lib/wo";
import { useToast } from "../../components/Toast";
import { Button, Checkbox, Dropdown, EmptyState, Input, ListSkeleton, Modal, Pill, Select } from "../../components/ui";
import { AssetPicker } from "../../components/assetPickers";
import { MeterDetail, LevelBadge } from "./MeterDetail";
import { BulkMeterDialog, MeterForm, MonitoringPointsDialog } from "./MeterForms";
import { fmtNum } from "./MeterChart";

export function MetersPage() {
  const { id } = useParams();
  const [params, setParams] = useSearchParams();
  const { can } = useSession();
  const nav = useNavigate();
  const qc = useQueryClient();
  const { toast } = useToast();
  const [q, setQ] = useState("");
  // Filters can come from links, e.g. the Overview's "/meters?overdue=1"
  const [asset, setAsset] = useState<string[]>(() => (params.get("asset_id") ? [params.get("asset_id")!] : []));
  const [status, setStatus] = useState<"" | "overdue" | "warning" | "alarm">(() =>
    params.get("overdue") === "1" ? "overdue" : params.get("level") === "alarm" ? "alarm" : params.get("level") === "warning" ? "warning" : "");
  const [creating, setCreating] = useState(false);
  const [points, setPoints] = useState(false);
  const [selecting, setSelecting] = useState(false);
  const [sel, setSel] = useState<string[]>([]);
  const [bulk, setBulk] = useState<null | "edit" | "delete">(null);
  useEffect(() => { if (params.get("new") === "1") { setCreating(true); params.delete("new"); setParams(params, { replace: true }); } }, [params, setParams]);
  const qs = `per_page=50&q=${encodeURIComponent(q)}${asset[0] ? `&asset_id=${asset[0]}` : ""}${status === "overdue" ? "&overdue=1" : status ? `&level=${status}` : ""}`;
  const list = useInfiniteQuery({
    queryKey: ["meters", qs], initialPageParam: 1,
    queryFn: ({ pageParam }) => api<Paged<Meter>>(`/meters?${qs}&page=${pageParam}`),
    getNextPageParam: (l: Paged<Meter>) => (l.page * l.per_page < l.total ? l.page + 1 : undefined),
    placeholderData: (p) => p,
  });
  const items = list.data?.pages.flatMap((p) => p.items) ?? [];
  const total = list.data?.pages[0]?.total;
  useEffect(() => { setSel([]); }, [qs]);
  const del = useMutation({
    mutationFn: () => api<{ done: string[]; failed: { name: string; message: string }[] }>("/meters/bulk", { method: "POST", body: { ids: sel, action: "delete" } }),
    onSuccess: (r) => { qc.invalidateQueries({ queryKey: ["meters"] }); setBulk(null); setSel([]); toast(`Deleted ${r.done.length} meter${r.done.length === 1 ? "" : "s"}`); if (id && r.done.includes(id)) nav("/meters"); },
    onError: (e) => toast((e as ApiError).message, { kind: "error" }),
  });
  const filtered = !!(q || asset.length || status);
  return (
    <div className="wo-page">
      <div className={"split wo-split" + (id ? " has-detail" : "")}>
        <div className="split-list">
          <div className="list-tools wo-list-tools">
            <div className="row" style={{ justifyContent: "space-between" }}>
              <h1 style={{ fontSize: "var(--fs-lg)" }}>Meters</h1>
              <div className="row">
                <Dropdown trigger={(_, t) => <Button icon aria-label="More" onClick={t}><MoreHorizontal size={18} /></Button>} width={230}>
                  {(close) => <button className="menu-item" onClick={() => { close(); setPoints(true); }}><Radio size={15} />Monitoring points…</button>}
                </Dropdown>
                {can("meters.manage") && <Button variant="primary" onClick={() => setCreating(true)} aria-label="New meter"><Plus size={16} />New</Button>}
              </div>
            </div>
            <div className="search-in"><Search size={15} className="faint" />
              <Input placeholder="Search meters" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search meters" /></div>
            <div className="row" style={{ gap: 6 }}>
              <div className="grow" style={{ minWidth: 0 }}><AssetPicker value={asset} onChange={setAsset} placeholder="All assets" /></div>
              <Select aria-label="Show" value={status} onChange={(e) => setStatus(e.target.value as typeof status)} style={{ width: 150 }}>
                <option value="">All meters</option><option value="overdue">Reading overdue</option><option value="warning">In warning</option><option value="alarm">In alarm</option></Select>
            </div>
            <div className="row small muted" style={{ justifyContent: "space-between" }}>
              <span>{total === undefined ? " " : `${total} meter${total === 1 ? "" : "s"}`}{filtered && <> · <button className="linkbtn small" onClick={() => { setQ(""); setAsset([]); setStatus(""); }}>Clear</button></>}</span>
              <span className="row" style={{ gap: 8 }}>
                {selecting && items.length > 0 && <Checkbox checked={sel.length === items.length} indeterminate={sel.length > 0 && sel.length < items.length}
                  onChange={(c) => setSel(c ? items.map((m) => m.id) : [])} label="All" />}
                {can("meters.manage") && <Button size="sm" variant={selecting ? "primary" : "ghost"} aria-pressed={selecting} onClick={() => { setSelecting((s) => !s); setSel([]); }}><CheckSquare size={14} />Select</Button>}
              </span>
            </div>
          </div>
          <div className="list" role="list">
            {list.isLoading ? <ListSkeleton /> : items.length === 0 ? (
              <EmptyState icon={<Gauge size={26} />} title={filtered ? "No meters match" : "No meters yet"}>
                {filtered ? "Try clearing the filters." : "Meters track run hours, miles, temperatures and other readings, and can create work automatically."}
              </EmptyState>
            ) : items.map((m) => <MeterRow key={m.id} m={m} active={m.id === id} selecting={selecting} selected={sel.includes(m.id)}
              onSelect={(c) => setSel((s) => (c ? [...s, m.id] : s.filter((x) => x !== m.id)))} />)}
            {list.hasNextPage && <div style={{ padding: 12, textAlign: "center" }}><Button size="sm" onClick={() => list.fetchNextPage()} disabled={list.isFetchingNextPage}>Load more</Button></div>}
          </div>
          {sel.length > 0 && (
            <div className="bulkbar" role="toolbar" aria-label="Bulk actions">
              <span className="small"><b>{sel.length}</b> selected</span>
              <Button size="sm" onClick={() => setBulk("edit")}><Pencil size={14} />Edit</Button>
              {can("meters.delete") && <Button size="sm" onClick={() => setBulk("delete")}><Trash2 size={14} />Delete</Button>}
              <span className="grow" /><Button size="sm" variant="ghost" icon aria-label="Clear selection" onClick={() => setSel([])}><X size={14} /></Button>
            </div>)}
        </div>
        <div className="split-detail">
          {id ? <MeterDetail id={id} key={id} /> : <EmptyState icon={<Gauge size={28} />} title="Select a meter">Pick one from the list to see its readings, chart and triggers.</EmptyState>}
        </div>
      </div>
      {creating && <MeterForm onClose={() => setCreating(false)} onSaved={(m) => { setCreating(false); nav(`/meters/${m.id}`); }} />}
      {points && <MonitoringPointsDialog onClose={() => setPoints(false)} />}
      {bulk === "edit" && <BulkMeterDialog ids={sel} onClose={() => setBulk(null)} onDone={() => { setBulk(null); setSel([]); }} />}
      {bulk === "delete" && <Modal title={`Delete ${sel.length} meter${sel.length === 1 ? "" : "s"}?`} onClose={() => setBulk(null)}
        footer={<><Button onClick={() => setBulk(null)}>Cancel</Button><Button variant="danger" disabled={del.isPending} onClick={() => del.mutate()}>Delete</Button></>}>
        <p>Their triggers stop too. Readings are kept.</p></Modal>}
    </div>
  );
}

function MeterRow({ m, active, selecting, selected, onSelect }: { m: Meter; active: boolean; selecting: boolean; selected: boolean; onSelect: (v: boolean) => void }) {
  return (
    <Link to={`/meters/${m.id}`} className={"list-row meter-row" + (active ? " active" : "")} role="listitem">
      {selecting && <span onClick={(e) => e.stopPropagation()}><Checkbox checked={selected} onChange={onSelect} label={<span className="sr-only">Select {m.name}</span>} /></span>}
      <span className={"mrow-ic " + (m.level || "ok")} aria-hidden="true"><Gauge size={16} /></span>
      <div className="grow" style={{ minWidth: 0 }}>
        <div className="t">{m.name}</div>
        <div className="s">{[m.asset?.name, m.location?.name].filter(Boolean).join(" · ") || "No asset"}</div>
      </div>
      <div className="mrow-side">
        <span className="tnum mrow-val">{m.last_value === null ? <span className="faint">—</span> : <>{fmtNum(m.last_value)} <span className="small muted">{m.unit}</span></>}</span>
        <span className="row" style={{ gap: 4 }}>
          <LevelBadge level={m.level} />
          {m.overdue ? <Pill tone="warning"><Clock size={11} />Overdue</Pill>
            : m.next_reading_due ? <span className="small faint" title="Next reading due">Next {shortDate(m.next_reading_due)}</span>
            : m.last_reading_at ? <span className="small faint">{timeAgo(m.last_reading_at)}</span> : null}
        </span>
      </div>
    </Link>
  );
}
