// Automations (MaintainX Automations, 0.4.0 MP-117): panel view (list + detail) and a table view, filters by asset or
// meter, bulk on / off / delete, copy, and the builder. Links: /automations?new=1&meter=<id> or &asset=<id> open the
// builder prefilled; /automations?meter_id=<id> or ?asset_id=<id> filter the list.
import { useEffect, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Boxes, CheckSquare, Gauge, LayoutList, Plus, Power, PowerOff, Search, Table2, Trash2, Workflow, Wrench, X } from "lucide-react";
import "../../styles/automations.css";
import { api, ApiError } from "../../lib/api";
import type { Paged } from "../../lib/assets";
import { useSession } from "../../lib/session";
import { timeAgo } from "../../lib/format";
import { useToast } from "../../components/Toast";
import { Button, Checkbox, EmptyState, Input, ListSkeleton, Modal, Pill, Select } from "../../components/ui";
import { AssetPicker } from "../../components/assetPickers";
import { MultiPicker } from "../../components/pickers";
import { AutomationBuilder } from "./Builder";
import { AutomationDetail } from "./AutomationDetail";
import { TRIGGER_LABEL, emptyDoc, useMeterList, type Automation, type AutomationDoc, type TriggerType } from "./types";

type View = "panel" | "table";
const load = (): View => { try { return localStorage.getItem("auto.view") === "table" ? "table" : "panel"; } catch { return "panel"; } };

export function AutomationsPage() {
  const { id } = useParams();
  const [params, setParams] = useSearchParams();
  const { can } = useSession();
  const nav = useNavigate();
  const qc = useQueryClient();
  const { toast } = useToast();
  const manage = can("automations.manage");
  const [view, setViewState] = useState<View>(load);
  const setView = (v: View) => { setViewState(v); try { localStorage.setItem("auto.view", v); } catch { /* private mode */ } };
  const [q, setQ] = useState("");
  const [asset, setAsset] = useState<string[]>(() => (params.get("asset_id") ? [params.get("asset_id")!] : []));
  const [meter, setMeter] = useState<string[]>(() => (params.get("meter_id") ? [params.get("meter_id")!] : []));
  const [type, setType] = useState<"" | TriggerType>("");
  const [active, setActive] = useState<"" | "1" | "0">("");
  const [creating, setCreating] = useState<Partial<AutomationDoc> | null>(null);
  const [selecting, setSelecting] = useState(false);
  const [sel, setSel] = useState<string[]>([]);
  const [confirmDelete, setConfirmDelete] = useState(false);

  // ?new=1[&meter=<id>|&asset=<id>] opens the builder prefilled (links from the meter and asset pages)
  useEffect(() => {
    if (params.get("new") !== "1") return;
    const m = params.get("meter"), a = params.get("asset");
    if (manage) {
      if (m) setCreating({ ...emptyDoc("meter_reading"), targets: [m] });
      else if (a) setCreating({ ...emptyDoc("asset_status"), targets: [a] });
      else setCreating({});
    }
    ["new", "meter", "asset"].forEach((k) => params.delete(k));
    setParams(params, { replace: true });
  }, [params, setParams, manage]);

  const qs = `per_page=100&q=${encodeURIComponent(q)}${asset[0] ? `&asset_id=${asset[0]}` : ""}${meter[0] ? `&meter_id=${meter[0]}` : ""}${type ? `&type=${type}` : ""}${active ? `&active=${active}` : ""}`;
  const list = useInfiniteQuery({
    queryKey: ["automations", qs], initialPageParam: 1, placeholderData: (p) => p,
    queryFn: ({ pageParam }) => api<Paged<Automation>>(`/automations?${qs}&page=${pageParam}`),
    getNextPageParam: (l: Paged<Automation>) => (l.page * l.per_page < l.total ? l.page + 1 : undefined),
  });
  const items = list.data?.pages.flatMap((p) => p.items) ?? [];
  const total = list.data?.pages[0]?.total;
  useEffect(() => { setSel([]); }, [qs]);
  const filtered = !!(q || asset.length || meter.length || type || active);
  const clear = () => { setQ(""); setAsset([]); setMeter([]); setType(""); setActive(""); };

  const bulk = useMutation({
    mutationFn: (action: "enable" | "disable" | "delete") => api<{ done: string[] }>("/automations/bulk", { method: "POST", body: { ids: sel, action } }),
    onSuccess: (r, action) => {
      qc.invalidateQueries({ queryKey: ["automations"] }); qc.invalidateQueries({ queryKey: ["automation"] });
      const n = r.done.length, s = n === 1 ? "" : "s";
      toast(action === "delete" ? `Deleted ${n} automation${s}` : action === "enable" ? `Turned on ${n} automation${s}` : `Turned off ${n} automation${s}`);
      setSel([]); setConfirmDelete(false);
      if (action === "delete" && id && r.done.includes(id)) nav("/automations");
    },
    onError: (e) => toast((e as ApiError).message, { kind: "error" }),
  });
  const toggleOne = useMutation({
    mutationFn: (a: Automation) => api(`/automations/${a.id}`, { method: "PATCH", body: { active: !a.active } }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["automations"] }); qc.invalidateQueries({ queryKey: ["automation"] }); },
    onError: (e) => toast((e as ApiError).message, { kind: "error" }),
  });
  const onSelect = (aid: string, c: boolean) => setSel((s) => (c ? [...s, aid] : s.filter((x) => x !== aid)));

  const tools = (
    <div className="list-tools wo-list-tools auto-tools">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h1 style={{ fontSize: "var(--fs-lg)" }}>Automations</h1>
        <div className="row">
          <div className="seg" role="tablist" aria-label="View">
            <button type="button" role="tab" aria-selected={view === "panel"} aria-label="Panel view" title="Panel view" className={"seg-btn" + (view === "panel" ? " on" : "")} onClick={() => setView("panel")}><LayoutList size={15} /></button>
            <button type="button" role="tab" aria-selected={view === "table"} aria-label="Table view" title="Table view" className={"seg-btn" + (view === "table" ? " on" : "")} onClick={() => setView("table")}><Table2 size={15} /></button>
          </div>
          {manage && <Button variant="primary" onClick={() => setCreating({})} aria-label="New automation"><Plus size={16} />New</Button>}
        </div>
      </div>
      <div className="search-in"><Search size={15} className="faint" />
        <Input placeholder="Search automations" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search automations" /></div>
      <div className={"auto-filters" + (view === "table" ? " wide" : "")}>
        <AssetPicker value={asset} onChange={(v) => { setAsset(v); if (v.length) setMeter([]); }} placeholder="All assets" />
        <MeterFilter value={meter} onChange={(v) => { setMeter(v); if (v.length) setAsset([]); }} />
        <Select aria-label="Trigger" value={type} onChange={(e) => setType(e.target.value as typeof type)}>
          <option value="">All triggers</option>{(Object.keys(TRIGGER_LABEL) as TriggerType[]).map((k) => <option key={k} value={k}>{TRIGGER_LABEL[k]}</option>)}</Select>
        <Select aria-label="On or off" value={active} onChange={(e) => setActive(e.target.value as typeof active)}>
          <option value="">On and off</option><option value="1">On</option><option value="0">Off</option></Select>
      </div>
      <div className="row small muted" style={{ justifyContent: "space-between" }}>
        <span>{total === undefined ? " " : `${total} automation${total === 1 ? "" : "s"}`}{filtered && <> · <button className="linkbtn small" onClick={clear}>Clear</button></>}</span>
        <span className="row" style={{ gap: 8 }}>
          {selecting && items.length > 0 && <Checkbox checked={sel.length === items.length} indeterminate={sel.length > 0 && sel.length < items.length}
            onChange={(c) => setSel(c ? items.map((m) => m.id) : [])} label="All" />}
          {manage && view === "panel" && <Button size="sm" variant={selecting ? "primary" : "ghost"} aria-pressed={selecting} onClick={() => { setSelecting((s) => !s); setSel([]); }}><CheckSquare size={14} />Select</Button>}
        </span>
      </div>
    </div>
  );

  const empty = (
    <EmptyState icon={<Workflow size={26} />} title={filtered ? "No automations match" : "No automations yet"}
      action={!filtered && manage ? <Button variant="primary" onClick={() => setCreating({})}><Plus size={15} />New automation</Button> : undefined}>
      {filtered ? "Try clearing the filters." : "Create work orders, change asset statuses or send emails automatically when a meter reading, asset status or work order status changes."}
    </EmptyState>);

  const bulkBar = sel.length > 0 && (
    <div className="bulkbar" role="toolbar" aria-label="Bulk actions">
      <span className="small"><b>{sel.length}</b> selected</span>
      <Button size="sm" onClick={() => bulk.mutate("enable")} disabled={bulk.isPending}><Power size={14} />Turn on</Button>
      <Button size="sm" onClick={() => bulk.mutate("disable")} disabled={bulk.isPending}><PowerOff size={14} />Turn off</Button>
      <Button size="sm" onClick={() => setConfirmDelete(true)}><Trash2 size={14} />Delete</Button>
      <span className="grow" /><Button size="sm" variant="ghost" icon aria-label="Clear selection" onClick={() => setSel([])}><X size={14} /></Button>
    </div>);

  return (
    <div className="wo-page">
      {view === "panel" ? (
        <div className={"split wo-split" + (id ? " has-detail" : "")}>
          <div className="split-list">
            {tools}
            <div className="list" role="list">
              {list.isLoading ? <ListSkeleton /> : items.length === 0 ? empty : items.map((a) => (
                <AutomationRow key={a.id} a={a} active={a.id === id} selecting={selecting} selected={sel.includes(a.id)} onSelect={(c) => onSelect(a.id, c)} />))}
              {list.hasNextPage && <div style={{ padding: 12, textAlign: "center" }}><Button size="sm" onClick={() => list.fetchNextPage()} disabled={list.isFetchingNextPage}>Load more</Button></div>}
            </div>
            {bulkBar}
          </div>
          <div className="split-detail">
            {id ? <AutomationDetail id={id} key={id} /> : <EmptyState icon={<Workflow size={28} />} title="Select an automation">Pick one from the list to see what it does and when it ran.</EmptyState>}
          </div>
        </div>
      ) : (
        <div className="wo-scroll auto-table-view">
          {tools}
          {list.isLoading ? <ListSkeleton /> : items.length === 0 ? empty : (
            <div className="table-wrap card"><table className="table auto-table">
              <thead><tr>
                {manage && <th style={{ width: 36 }}><Checkbox checked={sel.length === items.length} indeterminate={sel.length > 0 && sel.length < items.length}
                  onChange={(c) => setSel(c ? items.map((m) => m.id) : [])} label={<span className="sr-only">Select all</span>} /></th>}
                <th>Name</th><th className="desktop-only">Trigger</th><th className="desktop-only">Watching</th><th>Ran</th><th className="desktop-only">Last run</th><th>On</th>
              </tr></thead>
              <tbody>{items.map((a) => (
                <tr key={a.id}>
                  {manage && <td><Checkbox checked={sel.includes(a.id)} onChange={(c) => onSelect(a.id, c)} label={<span className="sr-only">Select {a.name}</span>} /></td>}
                  <td><Link to={`/automations/${a.id}`} onClick={() => setView("panel")}><b>{a.name}</b></Link><div className="small muted auto-clamp">{a.summary}</div></td>
                  <td className="small desktop-only">{TRIGGER_LABEL[a.trigger.type]}</td>
                  <td className="small desktop-only">{watching(a)}</td>
                  <td className="small tnum">{a.run_count}{a.fail_count > 0 && <div><Pill tone="danger">{a.fail_count} failed</Pill></div>}</td>
                  <td className="small desktop-only">{a.last_run_at ? timeAgo(a.last_run_at) : <span className="faint">Never</span>}</td>
                  <td>{manage ? <input type="checkbox" role="switch" className="switch" checked={a.active} aria-label={`${a.name} on`} onChange={() => toggleOne.mutate(a)} />
                    : a.active ? "On" : "Off"}</td>
                </tr>))}</tbody></table></div>)}
          {list.hasNextPage && <div style={{ padding: 12, textAlign: "center" }}><Button size="sm" onClick={() => list.fetchNextPage()} disabled={list.isFetchingNextPage}>Load more</Button></div>}
          {bulkBar && <div className="auto-bulk-float">{bulkBar}</div>}
        </div>
      )}
      {creating && <AutomationBuilder init={creating} onClose={() => setCreating(null)} onSaved={(a) => { setCreating(null); setView("panel"); nav(`/automations/${a.id}`); }} />}
      {confirmDelete && <Modal title={`Delete ${sel.length} automation${sel.length === 1 ? "" : "s"}?`} onClose={() => setConfirmDelete(false)}
        footer={<><Button onClick={() => setConfirmDelete(false)}>Cancel</Button><Button variant="danger" disabled={bulk.isPending} onClick={() => bulk.mutate("delete")}>Delete</Button></>}>
        <p>They stop running. Work orders they already created are kept.</p></Modal>}
    </div>
  );
}

function watching(a: Automation): string {
  if (!a.targets.length) return "Any asset";
  const more = a.targets.length - a.target_names.slice(0, 2).length;
  return a.target_names.slice(0, 2).join(", ") + (more > 0 ? ` +${more}` : "");
}

function AutomationRow({ a, active, selecting, selected, onSelect }: { a: Automation; active: boolean; selecting: boolean; selected: boolean; onSelect: (v: boolean) => void }) {
  const Icon = a.trigger.type === "meter_reading" ? Gauge : a.trigger.type === "asset_status" ? Boxes : Wrench;
  return (
    <Link to={`/automations/${a.id}`} className={"list-row auto-row" + (active ? " active" : "") + (a.active ? "" : " off")} role="listitem">
      {selecting && <span onClick={(e) => e.stopPropagation()}><Checkbox checked={selected} onChange={onSelect} label={<span className="sr-only">Select {a.name}</span>} /></span>}
      <span className={"auto-row-ic" + (a.active ? "" : " off")} aria-hidden="true"><Icon size={16} /></span>
      <div className="grow" style={{ minWidth: 0 }}>
        <div className="t">{a.name}</div>
        <div className="s">{watching(a)}</div>
      </div>
      <div className="auto-row-side">
        {a.active ? <Pill tone="success">On</Pill> : <Pill>Off</Pill>}
        <span className="small faint">{a.fail_count ? <span style={{ color: "var(--c-danger)" }}>{a.fail_count} failed</span> : a.last_run_at ? `Ran ${timeAgo(a.last_run_at)}` : "Not run yet"}</span>
      </div>
    </Link>
  );
}

function MeterFilter({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) {
  const meters = useMeterList();
  const opts = (meters.data?.items ?? []).map((m) => ({ key: m.id, label: m.name, sub: m.asset?.name, icon: <Gauge size={14} className="faint" /> }));
  return <MultiPicker label="Meter" single placeholder="All meters" options={opts} value={value} onChange={onChange} searchPlaceholder="Search meters"
    renderValue={(s) => <span className="chip"><Gauge size={12} />{s[0].label}</span>} />;
}
