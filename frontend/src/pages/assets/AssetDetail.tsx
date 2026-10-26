// One asset: header, status, and the Details / Work Orders / Insights / Photos / Downtime / Lifecycle / History tabs.
import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Boxes, ClipboardList, Copy, ExternalLink, Link2, MoreHorizontal, Pencil, Plus, Printer, QrCode, RotateCcw, Trash2, X } from "lucide-react";
import { api, ApiError, type WOList } from "../../lib/api";
import { useAssetOptions, type Asset, type AssetDetail as AD, type Insights, type Paged, type PhotoItem, type StatusChange } from "../../lib/assets";
import { useSession } from "../../lib/session";
import { absoluteUrl, copyText, money, shortDate } from "../../lib/wo";
import { currency, dateTime, show } from "../../lib/format";
import { useToast } from "../../components/Toast";
import { Button, Checkbox, Dropdown, EmptyState, Field, Input, ListSkeleton, Modal, Pill, Select } from "../../components/ui";
import { ClearableDate } from "../../components/assetPickers";
import { LabelDialog } from "../../components/LabelDialog";
import { QuickTemplateItems } from "../../components/QuickTemplates";
import { WORow } from "../workorders/WorkOrders";
import { AssetForm } from "./AssetForm";
import { AssetStatusPill, BarChart2, Crumbs, FilesSection, fmtSeconds, HistoryList, Lightbox, TeamChips } from "./shared";
import { WarrantyFiles } from "./WarrantyFiles";
import { AssetPackageSuggestions } from "./AssetHub";
import { SparePartsTab } from "../suppliers/SpareParts";
import { ScanHistory } from "../scan/ScanHistory";

export const ASSET_TABS = [["details", "Details"], ["work-orders", "Work Orders"], ["insights", "Insights"], ["photos", "Photos"], ["downtime", "Downtime"],
  ["spare-parts", "Spare Parts"], ["lifecycle", "Lifecycle"], ["history", "History"]] as const;
export type AssetTab = (typeof ASSET_TABS)[number][0];

export function useAsset(id: string | undefined) {
  return useQuery({ queryKey: ["asset", id], queryFn: () => api<AD>(`/assets/${id}`), enabled: !!id });
}

export function AssetDetailView({ id, tab, onTab }: { id: string; tab: AssetTab; onTab: (t: AssetTab) => void }) {
  const q = useAsset(id);
  const { can, session } = useSession();
  const qc = useQueryClient();
  const nav = useNavigate();
  const { toast } = useToast();
  const [editing, setEditing] = useState(false);
  const [statusOpen, setStatusOpen] = useState(false);
  const [labels, setLabels] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [addSub, setAddSub] = useState(false);
  const err = (e: unknown) => toast((e as ApiError).message, { kind: "error" });
  const refresh = () => { qc.invalidateQueries({ queryKey: ["asset", id] }); qc.invalidateQueries({ queryKey: ["assets"] }); qc.invalidateQueries({ queryKey: ["asset-tree"] }); };
  const dup = useMutation({ mutationFn: () => api<AD>(`/assets/${id}/duplicate`, { method: "POST" }), onSuccess: (a) => { refresh(); toast("Duplicated"); nav(`/assets/${a.id}`); }, onError: err });
  const del = useMutation({ mutationFn: () => api(`/assets/${id}`, { method: "DELETE" }), onSuccess: () => { refresh(); setConfirmDelete(false); toast("Asset deleted"); }, onError: (e) => { setConfirmDelete(false); err(e); } });
  const restore = useMutation({ mutationFn: () => api(`/assets/${id}/restore`, { method: "POST" }), onSuccess: () => { refresh(); toast("Restored"); }, onError: err });
  if (q.isError) return <EmptyState icon={<Boxes size={28} />} title="Asset not found">It may have been deleted, or you don't have access.</EmptyState>;
  const a = q.data;
  if (!a) return <div className="detail"><ListSkeleton rows={5} /></div>;
  const tz = session.org?.timezone;
  const manage = (a.you?.edit ?? can("assets.manage")) && !a.deleted;

  return (
    <div className="detail asset-detail">
      <Link to="/assets" className="row small mobile-only"><ArrowLeft size={14} />All assets</Link>
      {a.deleted && <div className="banner warning"><Trash2 size={18} /><div className="grow">This asset was deleted.</div>
        {can("assets.delete") && <Button size="sm" onClick={() => restore.mutate()}><RotateCcw size={14} />Restore</Button>}</div>}
      {!a.deleted && <AssetPackageSuggestions assetId={a.id} />}
      <div className="wo-head">
        {a.thumb_url ? <img className="asset-hero" src={a.thumb_url} alt="" /> : <span className="asset-hero ph" aria-hidden="true"><Boxes size={26} /></span>}
        <div className="grow">
          <Crumbs path={a.path} base="/assets" baseLabel="Assets" />
          <h1 className="wo-title">{a.name}</h1>
          <div className="row wrap" style={{ marginTop: 6 }}>
            <AssetStatusPill status={a.status} reason={a.status_reason} />
            {a.downtime_type && <Pill tone={a.downtime_type === "planned" ? "info" : "danger"}>{a.downtime_type === "planned" ? "Planned downtime" : "Unplanned downtime"}</Pill>}
            {a.criticality && <Pill tone={a.criticality === "critical" ? "danger" : a.criticality === "important" ? "warning" : "neutral"}>{a.criticality_label}</Pill>}
            {a.location && <Link className="small" to={`/locations/${a.location.id}`}>{a.location.name}</Link>}
            <span className="small faint">since {dateTime(a.status_changed_at, tz)}{a.status_changed_by ? ` · ${a.status_changed_by.name}` : ""}</span>
          </div>
        </div>
        <div className="row">
          {can("assets.status") && !a.deleted && <Button onClick={() => setStatusOpen(true)}>Change status</Button>}
          {manage && <Button icon aria-label="Edit asset" title="Edit" onClick={() => setEditing(true)}><Pencil size={15} /></Button>}
          <Dropdown trigger={(_, t) => <Button icon aria-label="More actions" onClick={t}><MoreHorizontal size={18} /></Button>} width={240}>
            {(close) => <>
              {can("wo.create") && !a.deleted && <button className="menu-item" onClick={() => { close(); nav(`/work-orders?new=1&asset=${a.id}`); }}><ClipboardList size={15} />New work order</button>}
              {!a.deleted && <QuickTemplateItems assetId={a.id} close={close} label="From a template" />}
              <div className="menu-sep" />
              {manage && <button className="menu-item" onClick={() => { close(); setAddSub(true); }}><Plus size={15} />Add sub-asset</button>}
              {manage && <button className="menu-item" onClick={() => { close(); dup.mutate(); }}><Copy size={15} />Duplicate</button>}
              <button className="menu-item" onClick={() => { close(); setLabels(true); }}><Printer size={15} />Print QR label</button>
              <button className="menu-item" onClick={async () => { close(); toast((await copyText(absoluteUrl(`/assets/${a.id}`))) ? "Link copied" : "Couldn't copy the link"); }}><Link2 size={15} />Copy link</button>
              {can("assets.delete") && !a.deleted && <><div className="menu-sep" /><button className="menu-item" style={{ color: "var(--c-danger)" }} onClick={() => { close(); setConfirmDelete(true); }}><Trash2 size={15} />Delete</button></>}
            </>}
          </Dropdown>
        </div>
      </div>

      <div className="tabs asset-tabs" role="tablist" aria-label="Asset sections" ref={(el) => el?.querySelector<HTMLElement>("[aria-selected=true]")?.scrollIntoView({ block: "nearest", inline: "nearest" })}>
        {ASSET_TABS.map(([k, l]) => <button key={k} type="button" role="tab" className="tab" aria-selected={tab === k} onClick={() => onTab(k)}>{l}</button>)}
      </div>
      {tab === "details" && <DetailsTab a={a} tz={tz} />}
      {tab === "work-orders" && <WorkOrdersTab id={a.id} />}
      {tab === "insights" && <InsightsTab id={a.id} />}
      {tab === "photos" && <PhotosTab id={a.id} />}
      {tab === "downtime" && <DowntimeTab a={a} tz={tz} />}
      {tab === "spare-parts" && <SparePartsTab assetId={a.id} canEdit={manage} />}
      {tab === "lifecycle" && <LifecycleTab a={a} />}
      {tab === "history" && <><ScanHistory entityType="asset" entityId={a.id} /><HistoryList path={`/assets/${a.id}/history`} tz={tz} /></>}

      {editing && <AssetForm edit={a} onClose={() => setEditing(false)} onSaved={() => { setEditing(false); refresh(); }} />}
      {addSub && <AssetForm parentId={a.id} onClose={() => setAddSub(false)} onSaved={(n) => { setAddSub(false); refresh(); nav(`/assets/${n.id}`); }} />}
      {statusOpen && <StatusModal assets={[a]} onClose={() => setStatusOpen(false)} onDone={() => { setStatusOpen(false); refresh(); qc.invalidateQueries({ queryKey: ["asset-status", a.id] }); }} />}
      {labels && <LabelDialog entityType="asset" ids={[a.id]} onClose={() => { setLabels(false); refresh(); }} />}
      {confirmDelete && <Modal title="Delete asset?" onClose={() => setConfirmDelete(false)} footer={<><Button onClick={() => setConfirmDelete(false)}>Cancel</Button>
        <Button variant="danger" onClick={() => del.mutate()} disabled={del.isPending}>Delete</Button></>}>
        <p>{a.name} will be removed from lists. Work orders keep their history, and an administrator can restore it.</p></Modal>}
    </div>
  );
}

// ---------------------------------------------------------------- status
export function StatusModal({ assets, onClose, onDone }: { assets: Pick<Asset, "id" | "name" | "status" | "child_count">[]; onClose: () => void; onDone: () => void }) {
  const opts = useAssetOptions();
  const { toast } = useToast();
  const one = assets.length === 1 ? assets[0] : null;
  const [status, setStatus] = useState<string>(one?.status === "online" ? "offline" : "online");
  const [reason, setReason] = useState("");
  const [downtime, setDowntime] = useState<"unplanned" | "planned">("unplanned");
  const [note, setNote] = useState("");
  const [children, setChildren] = useState(false);
  const [at, setAt] = useState("");
  const [err, setErr] = useState("");
  const reasons = opts.data?.statuses.find((s) => s.id === status)?.reasons ?? [];
  const body = { status, reason, downtime_type: status === "offline" ? downtime : "", note };
  const m = useMutation({
    mutationFn: async () => {
      if (one) return api(`/assets/${one.id}/status`, { method: "POST", body: { ...body, apply_to_children: children, at: at ? new Date(at).toISOString() : undefined } });
      const r = await api<{ done: string[]; failed: { name: string; message: string }[] }>("/assets/bulk", { method: "POST", body: { ids: assets.map((x) => x.id), action: "status", patch: body } });
      if (r.failed.length) toast(`${r.failed.length} couldn't change: ${r.failed[0].message}`, { kind: "error" });
      return r;
    },
    onSuccess: () => { toast("Status changed"); onDone(); },
    onError: (e) => setErr((e as ApiError).message),
  });
  return (
    <Modal title={one ? `Change status of ${one.name}` : `Change status of ${assets.length} assets`} onClose={onClose}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" onClick={() => m.mutate()} disabled={m.isPending}>Change status</Button></>}>
      <div className="seg asset-status-seg" role="radiogroup" aria-label="Status">
        {(opts.data?.statuses ?? []).map((s) => <button key={s.id} type="button" role="radio" aria-checked={status === s.id} className={"seg-btn st-" + s.id + (status === s.id ? " on" : "")}
          onClick={() => { setStatus(s.id); setReason(""); }}><span className={"astat-dot " + s.id} />{s.label}</button>)}
      </div>
      {status === "offline" && <div className="seg" role="radiogroup" aria-label="Downtime type">
        {(["unplanned", "planned"] as const).map((d) => <button key={d} type="button" role="radio" aria-checked={downtime === d} className={"seg-btn" + (downtime === d ? " on" : "")}
          onClick={() => setDowntime(d)}>{d === "planned" ? "Planned downtime" : "Unplanned downtime"}</button>)}</div>}
      {reasons.length > 0 && <Field label="Reason">{(id) => <Select id={id} value={reason} onChange={(e) => setReason(e.target.value)}><option value="">No reason</option>
        {reasons.map((r) => <option key={r}>{r}</option>)}</Select>}</Field>}
      <Field label="Note">{(id) => <textarea id={id} className="textarea" rows={2} value={note} maxLength={2000} onChange={(e) => setNote(e.target.value)} placeholder="What happened?" />}</Field>
      {one && <Field label="When" hint="Leave empty for now. Set it to record a change that happened earlier.">{(id) =>
        <ClearableDate id={id} type="datetime-local" label="time" value={at} max={new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16)} onChange={setAt} />}</Field>}
      {one && (one.child_count ?? 0) > 0 && <Checkbox checked={children} onChange={setChildren} label={`Also change its sub-assets (${one.child_count} direct)`} />}
      {err && <div className="banner warning" role="alert">{err}</div>}
    </Modal>
  );
}

// ---------------------------------------------------------------- tabs
function DetailsTab({ a, tz }: { a: AD; tz?: string }) {
  const { can, session } = useSession();
  const subs = useQuery({ queryKey: ["assets", "children", a.id], queryFn: () => api<Paged<Asset>>(`/assets?parent_id=${a.id}&per_page=200`) });
  const cf = a.custom_fields.filter((f) => a.custom[f.id] !== undefined && a.custom[f.id] !== "");
  return (
    <div className="stack" style={{ gap: 16 }}>
      {a.description && <section className="card card-pad prewrap">{a.description}</section>}
      <dl className="meta-grid card card-pad">
        <div><dt>Location</dt><dd>{a.location ? <Link to={`/locations/${a.location.id}`}>{a.location.name}</Link> : <span className="faint">None</span>}</dd></div>
        <div><dt>Parent asset</dt><dd>{a.path.length ? <Link to={`/assets/${a.path[a.path.length - 1].id}`}>{a.path[a.path.length - 1].name}</Link> : <span className="faint">None</span>}</dd></div>
        <div><dt>Criticality</dt><dd>{a.criticality_label || <span className="faint">None</span>}</dd></div>
        <div><dt>Asset types</dt><dd>{a.types.length ? <span className="row wrap" style={{ gap: 4 }}>{a.types.map((t) => <span key={t.id} className="chip"><span className="sw lg" style={{ background: t.color }} />{t.name}</span>)}</span> : <span className="faint">None</span>}</dd></div>
        <div><dt>Manufacturer</dt><dd>{show(a.manufacturer)}</dd></div>
        <div><dt>Model</dt><dd>{show(a.model)}</dd></div>
        <div><dt>Serial number</dt><dd className="mono">{show(a.serial_number)}</dd></div>
        <div><dt>Year</dt><dd>{show(a.year)}</dd></div>
        <div><dt>Barcode</dt><dd className="mono">{show(a.barcode)}</dd></div>
        <div><dt>Warranty</dt><dd>{a.warranty.end ? <>{a.warranty_active ? "Until" : "Ended"} {shortDate(a.warranty.end)}</> : <span className="faint">None</span>}</dd></div>
        <div className="span2"><dt>Teams in charge</dt><dd><TeamChips teams={a.teams} /></dd></div>
        <div><dt>Open work orders</dt><dd>{a.open_work_orders}</dd></div>
        <div><dt>Availability (30 days)</dt><dd>{a.downtime_30d.availability === null ? <span className="faint">—</span> : `${a.downtime_30d.availability}%`}</dd></div>
        {cf.map((f) => <div key={f.id}><dt>{f.name}</dt><dd>{f.type === "checkbox" ? (a.custom[f.id] ? "Yes" : "No") : f.type === "link"
          ? <a href={String(a.custom[f.id])} target="_blank" rel="noopener noreferrer">{String(a.custom[f.id])}</a>
          : f.type === "currency" ? currency(a.custom[f.id], session.org?.currency) : String(a.custom[f.id])}</dd></div>)}
        <div><dt>Created</dt><dd className="small">{dateTime(a.created_at, tz)}</dd></div>
        <div><dt>Updated</dt><dd className="small">{dateTime(a.updated_at, tz)}</dd></div>
      </dl>
      <CodesCard a={a} />
      <section className="card">
        <div className="card-head"><h3 className="sec-h" style={{ margin: 0 }}>Sub-assets</h3><span className="small muted">{subs.data?.total ?? ""}</span></div>
        {!subs.data ? <ListSkeleton rows={2} /> : subs.data.items.length === 0 ? <div className="card-body small faint">No sub-assets. Add parts of this asset (motors, pumps, panels) to track them separately.</div>
          : subs.data.items.map((s) => <Link key={s.id} to={`/assets/${s.id}`} className="list-row"><span className={"astat-dot " + s.status} /><span className="grow t">{s.name}</span>
            {s.child_count > 0 && <span className="small faint">{s.child_count} sub</span>}<AssetStatusPill status={s.status} /></Link>)}
      </section>
      <FilesSection files={a.files} entityType="asset" entityId={a.id} editable={can("assets.manage") && !a.deleted} queryKey={["asset", a.id]} />
    </div>
  );
}

const SYMBOLOGIES = [["qr", "QR code"], ["code128", "Code 128"], ["datamatrix", "Data Matrix"], ["code39", "Code 39"], ["ean13", "EAN-13"], ["upca", "UPC-A"], ["other", "Other"]] as const;

function CodesCard({ a }: { a: AD }) {
  const { can } = useSession();
  const qc = useQueryClient();
  const { toast } = useToast();
  const [linking, setLinking] = useState(false);
  const [value, setValue] = useState("");
  const [sym, setSym] = useState("other");
  const may = can("qr.manage") && can("assets.manage") && !a.deleted;
  const done = () => qc.invalidateQueries({ queryKey: ["asset", a.id] });
  const make = useMutation({ mutationFn: () => api("/qr-codes", { method: "POST", body: { entity_type: "asset", entity_id: a.id } }), onSuccess: () => { done(); toast("QR code created"); },
    onError: (e) => toast((e as ApiError).message, { kind: "error" }) });
  const link = useMutation({ mutationFn: () => api("/qr-codes", { method: "POST", body: { entity_type: "asset", entity_id: a.id, value, symbology: sym } }),
    onSuccess: () => { done(); setLinking(false); setValue(""); toast("Barcode linked"); }, onError: (e) => toast((e as ApiError).message, { kind: "error" }) });
  const retire = useMutation({ mutationFn: (cid: string) => api(`/qr-codes/${cid}/retire`, { method: "POST" }), onSuccess: () => { done(); toast("Code retired"); },
    onError: (e) => toast((e as ApiError).message, { kind: "error" }) });
  return (
    <section className="card">
      <div className="card-head"><h3 className="sec-h" style={{ margin: 0 }}>QR codes and barcodes</h3>
        {may && <div className="row">{!a.codes.some((c) => c.kind === "mpro") && <Button size="sm" onClick={() => make.mutate()}><QrCode size={14} />Create QR code</Button>}
          <Button size="sm" onClick={() => setLinking(true)}><Link2 size={14} />Link existing</Button></div>}</div>
      {a.codes.length === 0 ? <div className="card-body small faint">No codes yet. Print a label from the menu, or link a barcode that's already on the equipment (for example a MaintainX label).</div>
        : a.codes.map((c) => (
          <div key={c.id} className="list-row" style={{ borderLeft: 0 }}>
            <QrCode size={16} className="faint" />
            <div className="grow"><div className="t mono">{c.value}</div><div className="s">{c.kind === "mpro" ? "MPro QR code" : `Linked ${SYMBOLOGIES.find(([k]) => k === c.symbology)?.[1] ?? c.symbology}`}</div></div>
            {c.url && <a className="btn ghost sm icon" href={c.url} target="_blank" rel="noopener noreferrer" aria-label="Open the code's link"><ExternalLink size={14} /></a>}
            {may && <Button size="sm" variant="ghost" icon aria-label={`Retire ${c.value}`} title="Retire" onClick={() => retire.mutate(c.id)}><X size={14} /></Button>}
          </div>))}
      {linking && <Modal title="Link an existing code" onClose={() => setLinking(false)} footer={<><Button onClick={() => setLinking(false)}>Cancel</Button>
        <Button variant="primary" disabled={!value.trim() || link.isPending} onClick={() => link.mutate()}>Link</Button></>}>
        <p className="small muted">Type or scan the value printed in the code. Scanning it later opens this asset.</p>
        <Field label="Code value">{(id) => <Input id={id} value={value} maxLength={200} onChange={(e) => setValue(e.target.value)} autoFocus />}</Field>
        <Field label="Type">{(id) => <Select id={id} value={sym} onChange={(e) => setSym(e.target.value)}>{SYMBOLOGIES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select>}</Field>
      </Modal>}
    </section>
  );
}

function WorkOrdersTab({ id }: { id: string }) {
  const [tab, setTab] = useState<"open" | "done" | "all">("open");
  const [children, setChildren] = useState(true);
  const { session } = useSession();
  const q = useQuery({ queryKey: ["asset-wos", id, tab, children], queryFn: () => api<WOList>(`/assets/${id}/work-orders?tab=${tab}&children=${children ? 1 : 0}&per_page=50`) });
  return (
    <section className="card">
      <div className="card-head wrap">
        <div className="seg" role="tablist" aria-label="Work orders">{(["open", "done", "all"] as const).map((t) => (
          <button key={t} type="button" role="tab" aria-selected={tab === t} className={"seg-btn" + (tab === t ? " on" : "")} onClick={() => setTab(t)}>{t === "open" ? "Open" : t === "done" ? "Done" : "All"}</button>))}</div>
        <Checkbox checked={children} onChange={setChildren} label="Include sub-assets" />
      </div>
      {!q.data ? <ListSkeleton rows={3} /> : q.data.items.length === 0 ? <EmptyState icon={<ClipboardList size={24} />} title="No work orders">Work on this asset shows here.</EmptyState>
        : q.data.items.map((w) => <WORow key={w.id} w={w} tz={session.org?.timezone} />)}
    </section>
  );
}

function InsightsTab({ id }: { id: string }) {
  const [days, setDays] = useState(90);
  const { session } = useSession();
  const q = useQuery({ queryKey: ["asset-insights", id, days], queryFn: () => api<Insights>(`/assets/${id}/insights?days=${days}`) });
  const cur = session.org?.currency;
  const d = q.data;
  return (
    <div className="stack" style={{ gap: 16 }}>
      <div className="row" style={{ justifyContent: "space-between" }}><span className="small muted">Including sub-assets</span>
        <div className="seg" role="radiogroup" aria-label="Period">{[30, 90, 365].map((n) => <button key={n} type="button" role="radio" aria-checked={days === n}
          className={"seg-btn" + (days === n ? " on" : "")} onClick={() => setDays(n)}>{n === 365 ? "1 year" : `${n} days`}</button>)}</div></div>
      {!d ? <ListSkeleton rows={4} /> : <>
        <div className="tiles">
          <div className="card tile"><div className="k">Availability</div><div className="v">{d.downtime.availability === null ? "—" : `${d.downtime.availability}%`}</div></div>
          <div className="card tile"><div className="k">Downtime</div><div className="v">{fmtSeconds(d.downtime.offline_seconds)}</div>
            <div className="small muted">{fmtSeconds(d.downtime.unplanned_seconds)} unplanned · {fmtSeconds(d.downtime.planned_seconds)} planned</div></div>
          <div className="card tile"><div className="k">Work orders</div><div className="v">{d.created}</div><div className="small muted">{d.completed} completed · {d.open} open</div></div>
          <div className="card tile"><div className="k">Costs</div><div className="v">{d.costs.total_cents !== undefined ? money(d.costs.total_cents, cur) : money(d.costs.other_cents, cur)}</div>
            <div className="small muted">{Math.round(d.costs.minutes / 6) / 10} h logged{d.costs.labor_cents !== undefined ? ` · ${money(d.costs.labor_cents, cur)} labor` : ""}</div></div>
        </div>
        <section className="card card-pad"><h3 className="sec-h">Work orders created vs completed</h3>
          <BarChart2 data={d.weeks.map((w) => ({ k: w.week, a: w.created, b: w.completed }))} aLabel="Created" bLabel="Completed"
            labelFor={(k) => new Date(k + "T00:00").toLocaleDateString(undefined, { month: "short", day: "numeric" })} /></section>
      </>}
    </div>
  );
}

function PhotosTab({ id }: { id: string }) {
  const q = useQuery({ queryKey: ["asset-photos", id], queryFn: () => api<{ items: PhotoItem[] }>(`/assets/${id}/photos`) });
  const [view, setView] = useState<PhotoItem | null>(null);
  if (!q.data) return <ListSkeleton rows={3} />;
  if (!q.data.items.length) return <EmptyState title="No photos yet">Photos of this asset, and photos added to its work orders and their comments, show here newest first so you can see its condition over time.</EmptyState>;
  const groups = new Map<string, PhotoItem[]>();
  for (const p of q.data.items) {
    const k = new Date(p.taken_at).toLocaleDateString(undefined, { month: "long", year: "numeric" });
    groups.set(k, [...(groups.get(k) ?? []), p]);
  }
  return (
    <div className="stack" style={{ gap: 16 }}>
      {[...groups.entries()].map(([month, items]) => (
        <section key={month} className="card card-pad"><h3 className="sec-h">{month}</h3>
          <div className="thumbs">{items.map((p) => (
            <figure key={p.id + (p.link_id ?? "")} className="photo-cell">
              <div className="thumb"><button type="button" onClick={() => setView(p)} aria-label={`Open ${p.name}`}><img src={p.thumb_url ?? p.url} alt={p.name} loading="lazy" /></button></div>
              <figcaption className="small faint">{shortDate(p.taken_at)}{p.source.work_order && <> · <Link to={`/work-orders/${p.source.work_order.id}`}>#{p.source.work_order.number}</Link></>}</figcaption>
            </figure>))}</div>
        </section>))}
      {view && <Lightbox file={view} files={q.data.items} onClose={() => setView(null)} />}
    </div>
  );
}

function DowntimeTab({ a, tz }: { a: AD; tz?: string }) {
  const q = useQuery({ queryKey: ["asset-status", a.id], queryFn: () => api<{ items: StatusChange[] }>(`/assets/${a.id}/status-history`) });
  if (!q.data) return <ListSkeleton rows={4} />;
  const items = q.data.items;
  return (
    <section className="card">
      <div className="card-head"><h3 className="sec-h" style={{ margin: 0 }}>Status history</h3>
        <span className="small muted">Last 30 days: {fmtSeconds(a.downtime_30d.offline_seconds)} offline{a.downtime_30d.availability !== null ? ` · ${a.downtime_30d.availability}% available` : ""}</span></div>
      <div className="table-wrap"><table className="table">
        <thead><tr><th>Status</th><th>Reason</th><th>From</th><th>Duration</th><th>By</th></tr></thead>
        <tbody>{items.map((c, i) => {
          const end = i === 0 ? Date.now() : new Date(items[i - 1].at).getTime();
          return <tr key={c.id}>
            <td><AssetStatusPill status={c.to} />{c.downtime_type && <span className="small faint"> {c.downtime_type}</span>}</td>
            <td>{c.reason || <span className="faint">—</span>}{c.note && <div className="small muted prewrap">{c.note}</div>}
              {c.work_order_id && <div className="small"><Link to={`/work-orders/${c.work_order_id}`}>From a work order</Link></div>}</td>
            <td className="small">{dateTime(c.at, tz)}</td>
            <td className="small">{fmtSeconds(Math.max(0, (end - new Date(c.at).getTime()) / 1000))}{i === 0 && <span className="faint"> so far</span>}</td>
            <td className="small">{c.actor ?? "—"}</td>
          </tr>; })}</tbody>
      </table></div>
    </section>
  );
}

function LifecycleTab({ a }: { a: AD }) {
  const { session, can } = useSession();
  const canEdit = can("assets.manage") && !a.deleted;
  const cur = session.org?.currency;
  const l = a.lifecycle, w = a.warranty, f = a.financials;
  const lifePct = l.expected_life_years ? Math.min(100, Math.round((l.age_years / l.expected_life_years) * 100)) : null;
  return (
    <div className="stack" style={{ gap: 16 }}>
      <section className="card card-pad stack">
        <h3 className="sec-h" style={{ margin: 0 }}>Lifecycle</h3>
        <dl className="meta-grid">
          <div><dt>Age</dt><dd>{l.age_years} years</dd></div>
          <div><dt>Commissioned</dt><dd>{l.commissioned_on ? shortDate(l.commissioned_on) : <span className="faint">—</span>}</dd></div>
          <div><dt>Expected life</dt><dd>{l.expected_life_years ? `${l.expected_life_years} years` : <span className="faint">—</span>}</dd></div>
          <div><dt>Planned replacement</dt><dd>{l.replacement_year ?? <span className="faint">—</span>}</dd></div>
          {l.disposed_on && <div><dt>Disposed</dt><dd>{shortDate(l.disposed_on)} {l.disposal_method && `(${l.disposal_method})`}</dd></div>}
        </dl>
        {lifePct !== null && <div><div className="row small" style={{ justifyContent: "space-between" }}><span className="muted">Life used</span><b>{lifePct}%</b></div>
          <div className={"progress life" + (lifePct >= 90 ? " late" : lifePct >= 70 ? " mid" : "")} role="progressbar" aria-valuenow={lifePct} aria-valuemin={0} aria-valuemax={100} aria-label="Life used"><span style={{ width: `${lifePct}%` }} /></div></div>}
        {l.disposal_notes && <p className="small prewrap">{l.disposal_notes}</p>}
      </section>
      <section className="card card-pad stack">
        <h3 className="sec-h" style={{ margin: 0 }}>Warranty</h3>
        {!w.end ? <span className="small faint">No warranty recorded.</span> : <>
          <div className="row wrap">{w.days_left !== null && (w.days_left >= 0
            ? <Pill tone={w.days_left <= 60 ? "warning" : "success"}>{w.days_left} days left</Pill> : <Pill tone="neutral">Ended {-w.days_left} days ago</Pill>)}
            <span className="small muted">{w.start ? `${shortDate(w.start)} – ` : "Until "}{shortDate(w.end)}{w.provider && ` · ${w.provider}`}</span></div>
          {w.terms && <p className="small prewrap" style={{ margin: 0 }}>{w.terms}</p>}</>}
        {(w.files?.length || canEdit) ? <WarrantyFiles assetId={a.id} files={w.files ?? []} editable={canEdit} /> : null}
      </section>
      {f && <section className="card">
        <div className="card-head"><h3 className="sec-h" style={{ margin: 0 }}>Financials</h3><span className="small muted">Straight-line depreciation</span></div>
        <dl className="meta-grid card-body">
          <div><dt>Purchase price</dt><dd>{money(f.purchase_price_cents, cur)}</dd></div>
          <div><dt>Purchased</dt><dd>{f.purchase_date ? shortDate(f.purchase_date) : "—"}</dd></div>
          <div><dt>Salvage value</dt><dd>{money(f.salvage_value_cents, cur)}</dd></div>
          <div><dt>Replacement cost</dt><dd>{money(f.replacement_cost_cents, cur)}</dd></div>
          {f.depreciation && <><div><dt>Book value today</dt><dd><b>{money(f.depreciation.book_value_cents, cur)}</b></dd></div>
            <div><dt>Depreciated so far</dt><dd>{money(f.depreciation.accumulated_cents, cur)}{f.depreciation.fully_depreciated && " (fully)"}</dd></div></>}
        </dl>
        {f.depreciation ? <div className="table-wrap"><table className="table">
          <thead><tr><th>Year</th><th>Starts</th><th className="num">Depreciation</th><th className="num">Book value at end</th></tr></thead>
          <tbody>{f.depreciation.schedule.map((r) => <tr key={r.year}><td>{r.year}</td><td>{shortDate(r.starts)}</td><td className="num">{money(r.depreciation_cents, cur)}</td>
            <td className="num">{money(r.book_value_cents, cur)}</td></tr>)}</tbody></table></div>
          : <div className="card-body small faint">Add a purchase price, purchase date and useful life to see the depreciation schedule.</div>}
      </section>}
    </div>
  );
}
