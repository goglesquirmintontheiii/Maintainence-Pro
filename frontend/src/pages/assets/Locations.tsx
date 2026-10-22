// Locations: tree (list + detail) with sub-locations, the assets and work in each, floor plans and history.
import { useEffect, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Boxes, ChevronDown, ChevronRight, ClipboardList, ExternalLink, Link2, MapPin, MoreHorizontal, Pencil, Plus, RotateCcw, Search, Trash2 } from "lucide-react";
import { api, ApiError, type FileItem, type WOList } from "../../lib/api";
import { useAssetOptions, type Asset, type Location, type LocationDetail, type Paged } from "../../lib/assets";
import { useSession } from "../../lib/session";
import { absoluteUrl, copyText, filtersParam } from "../../lib/wo";
import { dateTime } from "../../lib/format";
import { useToast } from "../../components/Toast";
import { Button, Dropdown, Drawer, EmptyState, Field, Input, ListSkeleton, Modal } from "../../components/ui";
import { LocationPicker } from "../../components/assetPickers";
import { CustomInput } from "../workorders/Form";
import { WORow } from "../workorders/WorkOrders";
import { AssetStatusPill, Crumbs, FilesSection, HistoryList, PhotoPicker, TeamChips, TeamsPicker } from "./shared";
import { FloorPlans } from "./FloorPlans";

const TABS = [["details", "Details"], ["assets", "Assets"], ["sub-locations", "Sub-locations"], ["work-orders", "Work Orders"], ["floor-plans", "Floor plans"], ["history", "History"]] as const;
type Tab = (typeof TABS)[number][0];

export function LocationsPage() {
  const { id, tab } = useParams();
  const [params, setParams] = useSearchParams();
  const { can } = useSession();
  const nav = useNavigate();
  const [q, setQ] = useState("");
  const [creating, setCreating] = useState<{ parent?: string } | null>(params.get("new") === "1" ? {} : null);
  useEffect(() => { if (params.get("new") === "1") { setCreating({}); const p = new URLSearchParams(params); p.delete("new"); setParams(p, { replace: true }); } }, [params, setParams]);
  return (
    <div className="wo-page">
      <div className={"split wo-split" + (id ? " has-detail" : "")}>
        <div className="split-list">
          <div className="list-tools wo-list-tools">
            <div className="wo-toolbar compact">
              <div className="row" style={{ justifyContent: "space-between" }}><h1>Locations</h1>
                {can("locations.manage") && <Button variant="primary" onClick={() => setCreating({})} aria-label="New Location"><Plus size={16} />New</Button>}</div>
              <div className="search-in"><Search size={15} className="faint" /><Input placeholder="Search locations" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search locations" /></div>
            </div>
          </div>
          <div className="list" role="tree" aria-label="Locations">{q.trim() ? <LocFlat q={q.trim()} activeId={id} /> : <LocTree activeId={id} />}</div>
        </div>
        <div className="split-detail">
          {id ? <LocationDetailView key={id} id={id} tab={(TABS.some(([k]) => k === tab) ? tab : "details") as Tab}
            onTab={(t) => nav(t === "details" ? `/locations/${id}` : `/locations/${id}/${t}`, { replace: true })} onAddChild={(p) => setCreating({ parent: p })} />
            : <EmptyState icon={<MapPin size={28} />} title="Select a location">Pick a site, building or room to see its assets, work orders and floor plans.</EmptyState>}
        </div>
      </div>
      {creating && <LocationForm parentId={creating.parent} onClose={() => setCreating(null)} onSaved={(l) => { setCreating(null); nav(`/locations/${l.id}`); }} />}
    </div>
  );
}

function LocTree({ activeId }: { activeId?: string }) {
  const roots = useQuery({ queryKey: ["locations", "tree", "root"], queryFn: () => api<Paged<Location>>("/locations?parent_id=root&per_page=500") });
  const { can } = useSession();
  if (roots.isLoading) return <ListSkeleton />;
  const items = roots.data?.items ?? [];
  if (!items.length) return <EmptyState icon={<MapPin size={26} />} title="No locations yet">{can("locations.manage") ? "Add your sites first, then buildings, floors and rooms inside them." : "Locations your team adds show here."}</EmptyState>;
  return <>{items.map((l) => <LocNode key={l.id} l={l} depth={0} activeId={activeId} />)}</>;
}

function LocNode({ l, depth, activeId }: { l: Location; depth: number; activeId?: string }) {
  const [open, setOpen] = useState(depth === 0);
  const kids = useQuery({ queryKey: ["locations", "tree", l.id], queryFn: () => api<Paged<Location>>(`/locations?parent_id=${l.id}&per_page=500`), enabled: open && l.child_count > 0 });
  return (
    <div role="treeitem" aria-expanded={l.child_count ? open : undefined} aria-selected={l.id === activeId}>
      <div className={"tree-row" + (l.id === activeId ? " active" : "")} style={{ paddingLeft: 8 + depth * 18 }}>
        {l.child_count > 0 ? <button type="button" className="tree-tog" aria-label={open ? `Collapse ${l.name}` : `Expand ${l.name}`} onClick={() => setOpen((o) => !o)}>
          {open ? <ChevronDown size={15} /> : <ChevronRight size={15} />}</button> : <span className="tree-tog" />}
        <LocRowBody l={l} />
      </div>
      {open && (kids.data?.items ?? []).map((c) => <LocNode key={c.id} l={c} depth={depth + 1} activeId={activeId} />)}
    </div>
  );
}

function LocRowBody({ l, showPath }: { l: Location; showPath?: boolean }) {
  return (
    <Link to={`/locations/${l.id}`} className="tree-link">
      <span className="asset-thumb ph" aria-hidden="true"><MapPin size={15} /></span>
      <span className="grow" style={{ minWidth: 0 }}><span className="t">{l.name}</span>
        <span className="s">{[showPath && l.path.length ? l.path.map((p) => p.name).join(" › ") : "", l.city, l.asset_count ? `${l.asset_count} asset${l.asset_count === 1 ? "" : "s"}` : ""].filter(Boolean).join(" · ") || " "}</span></span>
      {l.open_work_orders > 0 && <span className="wo-count" title={`${l.open_work_orders} open work orders`}>{l.open_work_orders}</span>}
    </Link>
  );
}

function LocFlat({ q, activeId }: { q: string; activeId?: string }) {
  const r = useQuery({ queryKey: ["locations", "search", q], queryFn: () => api<Paged<Location>>(`/locations?per_page=200&q=${encodeURIComponent(q)}`), placeholderData: (p) => p });
  if (r.isLoading) return <ListSkeleton />;
  const items = r.data?.items ?? [];
  if (!items.length) return <EmptyState title="No locations match" />;
  return <>{items.map((l) => <div key={l.id} className={"tree-row" + (l.id === activeId ? " active" : "")} style={{ paddingLeft: 12 }}><LocRowBody l={l} showPath /></div>)}</>;
}

function LocationDetailView({ id, tab, onTab, onAddChild }: { id: string; tab: Tab; onTab: (t: Tab) => void; onAddChild: (parent: string) => void }) {
  const q = useQuery({ queryKey: ["location", id], queryFn: () => api<LocationDetail>(`/locations/${id}`) });
  const { can, session } = useSession();
  const qc = useQueryClient();
  const nav = useNavigate();
  const { toast } = useToast();
  const [editing, setEditing] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const refresh = () => { qc.invalidateQueries({ queryKey: ["location", id] }); qc.invalidateQueries({ queryKey: ["locations"] }); qc.invalidateQueries({ queryKey: ["location-pick"] }); };
  const del = useMutation({ mutationFn: () => api(`/locations/${id}`, { method: "DELETE" }), onSuccess: () => { refresh(); setConfirm(false); toast("Location deleted"); },
    onError: (e) => { setConfirm(false); toast((e as ApiError).message, { kind: "error" }); } });
  const restore = useMutation({ mutationFn: () => api(`/locations/${id}/restore`, { method: "POST" }), onSuccess: () => { refresh(); toast("Restored"); },
    onError: (e) => toast((e as ApiError).message, { kind: "error" }) });
  if (q.isError) return <EmptyState icon={<MapPin size={28} />} title="Location not found" />;
  const l = q.data;
  if (!l) return <div className="detail"><ListSkeleton rows={5} /></div>;
  const tz = session.org?.timezone;
  const manage = can("locations.manage") && !l.deleted;
  return (
    <div className="detail asset-detail">
      <Link to="/locations" className="row small mobile-only"><ArrowLeft size={14} />All locations</Link>
      {l.deleted && <div className="banner warning"><Trash2 size={18} /><div className="grow">This location was deleted.</div>
        {can("locations.delete") && <Button size="sm" onClick={() => restore.mutate()}><RotateCcw size={14} />Restore</Button>}</div>}
      <div className="wo-head">
        <span className="asset-hero ph" aria-hidden="true"><MapPin size={26} /></span>
        <div className="grow">
          <Crumbs path={l.path} base="/locations" baseLabel="Locations" />
          <h1 className="wo-title">{l.name}</h1>
          <div className="row wrap small muted" style={{ marginTop: 4 }}>
            {l.address && <span>{l.address}</span>}
            {l.maps_url && <a href={l.maps_url} target="_blank" rel="noopener noreferrer" className="row" style={{ gap: 4 }}><ExternalLink size={13} />Open in maps</a>}
          </div>
        </div>
        <div className="row">
          {manage && <Button onClick={() => setEditing(true)} aria-label="Edit location"><Pencil size={15} /><span className="desktop-only">Edit</span></Button>}
          <Dropdown trigger={(_, t) => <Button icon aria-label="More actions" onClick={t}><MoreHorizontal size={18} /></Button>} width={240}>
            {(close) => <>
              {can("wo.create") && !l.deleted && <button className="menu-item" onClick={() => { close(); nav(`/work-orders?new=1&location=${l.id}`); }}><ClipboardList size={15} />New work order</button>}
              {manage && <button className="menu-item" onClick={() => { close(); onAddChild(l.id); }}><Plus size={15} />Add sub-location</button>}
              {can("assets.manage") && !l.deleted && <button className="menu-item" onClick={() => { close(); nav("/assets?new=1"); }}><Boxes size={15} />New asset</button>}
              <button className="menu-item" onClick={async () => { close(); toast((await copyText(absoluteUrl(`/locations/${l.id}`))) ? "Link copied" : "Couldn't copy the link"); }}><Link2 size={15} />Copy link</button>
              {can("locations.delete") && !l.deleted && <><div className="menu-sep" /><button className="menu-item" style={{ color: "var(--c-danger)" }} onClick={() => { close(); setConfirm(true); }}><Trash2 size={15} />Delete</button></>}
            </>}
          </Dropdown>
        </div>
      </div>
      <div className="tabs asset-tabs" role="tablist" aria-label="Location sections" ref={(el) => el?.querySelector<HTMLElement>("[aria-selected=true]")?.scrollIntoView({ block: "nearest", inline: "nearest" })}>
        {TABS.map(([k, label]) => <button key={k} type="button" role="tab" className="tab" aria-selected={tab === k} onClick={() => onTab(k)}>{label}
          {k === "assets" && l.asset_count > 0 && <span className="tab-count">{l.asset_count}</span>}{k === "sub-locations" && l.child_count > 0 && <span className="tab-count">{l.child_count}</span>}</button>)}
      </div>
      {tab === "details" && <div className="stack" style={{ gap: 16 }}>
        {l.description && <section className="card card-pad prewrap">{l.description}</section>}
        <dl className="meta-grid card card-pad">
          <div className="span2"><dt>Address</dt><dd>{l.address || <span className="faint">None</span>}</dd></div>
          <div><dt>Coordinates</dt><dd>{l.latitude !== null && l.longitude !== null ? <span className="mono">{l.latitude.toFixed(5)}, {l.longitude.toFixed(5)}</span> : <span className="faint">None</span>}</dd></div>
          <div className="span2"><dt>Teams in charge</dt><dd><TeamChips teams={l.teams} /></dd></div>
          <div><dt>Assets (incl. sub-locations)</dt><dd>{l.asset_count}</dd></div>
          <div><dt>Open work orders</dt><dd>{l.open_work_orders}</dd></div>
          <LocCustom l={l} />
          <div><dt>Created</dt><dd className="small">{dateTime(l.created_at, tz)}</dd></div>
        </dl>
        <FilesSection files={l.files} entityType="location" entityId={l.id} editable={manage} queryKey={["location", l.id]} />
      </div>}
      {tab === "assets" && <LocAssets id={l.id} />}
      {tab === "sub-locations" && <SubLocations id={l.id} onAdd={manage ? () => onAddChild(l.id) : undefined} />}
      {tab === "work-orders" && <LocWorkOrders id={l.id} />}
      {tab === "floor-plans" && <FloorPlans loc={l} editable={manage} />}
      {tab === "history" && <HistoryList path={`/locations/${l.id}/history`} tz={tz} />}
      {editing && <LocationForm edit={l} onClose={() => setEditing(false)} onSaved={() => { setEditing(false); refresh(); }} />}
      {confirm && <Modal title="Delete location?" onClose={() => setConfirm(false)} footer={<><Button onClick={() => setConfirm(false)}>Cancel</Button>
        <Button variant="danger" onClick={() => del.mutate()} disabled={del.isPending}>Delete</Button></>}>
        <p>{l.name} will be removed. Locations with sub-locations or assets can't be deleted until those are moved.</p></Modal>}
    </div>
  );
}

function LocCustom({ l }: { l: LocationDetail }) {
  const opts = useAssetOptions();
  const defs = (opts.data?.location_custom_fields ?? []).filter((f) => l.custom[f.id] !== undefined && l.custom[f.id] !== "");
  return <>{defs.map((f) => <div key={f.id}><dt>{f.name}</dt><dd>{f.type === "checkbox" ? (l.custom[f.id] ? "Yes" : "No") : String(l.custom[f.id])}</dd></div>)}</>;
}

function LocAssets({ id }: { id: string }) {
  const q = useQuery({ queryKey: ["assets", "at-location", id], queryFn: () => api<Paged<Asset>>(`/assets?location_id=${id}&per_page=200&sort=name`) });
  if (!q.data) return <ListSkeleton rows={4} />;
  if (!q.data.items.length) return <EmptyState icon={<Boxes size={24} />} title="No assets here">Assets in this location and its sub-locations show here.</EmptyState>;
  return (
    <section className="card">
      <div className="card-head"><span className="small muted">{q.data.total} asset{q.data.total === 1 ? "" : "s"}, including sub-locations</span></div>
      {q.data.items.map((a) => <Link key={a.id} to={`/assets/${a.id}`} className="list-row"><span className={"astat-dot " + a.status} />
        <span className="grow"><span className="t" style={{ display: "block" }}>{a.name}</span><span className="s">{[a.location?.name, a.manufacturer, a.model].filter(Boolean).join(" · ")}</span></span>
        <AssetStatusPill status={a.status} /></Link>)}
    </section>
  );
}

function SubLocations({ id, onAdd }: { id: string; onAdd?: () => void }) {
  const q = useQuery({ queryKey: ["locations", "tree", id], queryFn: () => api<Paged<Location>>(`/locations?parent_id=${id}&per_page=500`) });
  return (
    <section className="card">
      <div className="card-head"><span className="small muted">{q.data?.total ?? ""} sub-location{q.data?.total === 1 ? "" : "s"}</span>{onAdd && <Button size="sm" onClick={onAdd}><Plus size={14} />Add sub-location</Button>}</div>
      {!q.data ? <ListSkeleton rows={3} /> : q.data.items.length === 0 ? <div className="card-body small faint">No sub-locations yet.</div>
        : q.data.items.map((l) => <Link key={l.id} to={`/locations/${l.id}`} className="list-row"><MapPin size={16} className="faint" /><span className="grow t">{l.name}</span>
          <span className="small faint">{l.asset_count} assets · {l.child_count} sub</span></Link>)}
    </section>
  );
}

function LocWorkOrders({ id }: { id: string }) {
  const [tab, setTab] = useState<"todo" | "done" | "all">("todo");
  const { session } = useSession();
  const q = useQuery({ queryKey: ["work-orders", "location", id, tab], queryFn: () => api<WOList>(`/work-orders?tab=${tab}&per_page=50&sort=-created_at${filtersParam([{ field: "location", op: "within", value: [id] }])}`) });
  return (
    <section className="card">
      <div className="card-head"><div className="seg" role="tablist" aria-label="Work orders">{(["todo", "done", "all"] as const).map((t) => (
        <button key={t} type="button" role="tab" aria-selected={tab === t} className={"seg-btn" + (tab === t ? " on" : "")} onClick={() => setTab(t)}>{t === "todo" ? "To Do" : t === "done" ? "Done" : "All"}</button>))}</div>
        <span className="small muted">{q.data?.total ?? ""}</span></div>
      {!q.data ? <ListSkeleton rows={3} /> : q.data.items.length === 0 ? <EmptyState icon={<ClipboardList size={24} />} title="No work orders">Work at this location and its sub-locations shows here.</EmptyState>
        : q.data.items.map((w) => <WORow key={w.id} w={w} tz={session.org?.timezone} />)}
    </section>
  );
}

// ---------------------------------------------------------------- form
const ADDR = [["address_line1", "Address line 1", "full"], ["address_line2", "Address line 2", "full"], ["city", "City", ""], ["region", "State / region", ""],
  ["postal_code", "Postal code", ""], ["country", "Country", ""]] as const;

function LocationForm({ edit, parentId, onClose, onSaved }: { edit?: LocationDetail; parentId?: string; onClose: () => void; onSaved: (l: LocationDetail) => void }) {
  const opts = useAssetOptions();
  const qc = useQueryClient();
  const { toast } = useToast();
  const [f, setF] = useState<Record<string, string>>(() => ({
    name: edit?.name ?? "", description: edit?.description ?? "", address_line1: edit?.address_line1 ?? "", address_line2: edit?.address_line2 ?? "", city: edit?.city ?? "",
    region: edit?.region ?? "", postal_code: edit?.postal_code ?? "", country: edit?.country ?? "",
    latitude: edit?.latitude?.toString() ?? "", longitude: edit?.longitude?.toString() ?? "" }));
  const [parent, setParent] = useState<string | null>(edit?.parent_id ?? parentId ?? null);
  const [teams, setTeams] = useState<string[]>(edit?.teams.map((t) => t.id) ?? []);
  const [custom, setCustom] = useState<Record<string, unknown>>(edit?.custom ?? {});
  const [files, setFiles] = useState<FileItem[]>([]);
  const [err, setErr] = useState("");
  const set = (k: string, v: string) => setF((x) => ({ ...x, [k]: v }));
  const body = () => ({ ...f, latitude: f.latitude.trim() === "" ? null : Number(f.latitude), longitude: f.longitude.trim() === "" ? null : Number(f.longitude),
    parent_id: parent, teams, custom, ...(edit ? {} : { file_ids: files.map((x) => x.id) }) });
  const m = useMutation({
    mutationFn: () => edit ? api<LocationDetail>(`/locations/${edit.id}`, { method: "PATCH", body: body() }) : api<LocationDetail>("/locations", { method: "POST", body: body() }),
    onSuccess: (l) => { qc.invalidateQueries({ queryKey: ["locations"] }); qc.invalidateQueries({ queryKey: ["location-pick"] }); qc.setQueryData(["location", l.id], l);
      toast(edit ? "Location saved" : `Location ${l.name} created`); onSaved(l); },
    onError: (e) => setErr((e as ApiError).message),
  });
  const useMyPosition = () => {
    if (!navigator.geolocation) { toast("This browser can't share its location.", { kind: "error" }); return; }
    navigator.geolocation.getCurrentPosition((p) => { set("latitude", p.coords.latitude.toFixed(6)); set("longitude", p.coords.longitude.toFixed(6)); },
      () => toast("Couldn't get your position. Check the browser's location permission.", { kind: "error" }), { enableHighAccuracy: true, timeout: 10000 });
  };
  return (
    <Drawer title={edit ? "Edit location" : "New location"} onClose={onClose} width={580}
      footer={<><Button onClick={onClose}>Cancel</Button><span className="grow" /><Button variant="primary" disabled={!f.name.trim() || m.isPending} onClick={() => { setErr(""); m.mutate(); }}>{m.isPending ? "Saving…" : edit ? "Save" : "Create location"}</Button></>}>
      <form className="form-grid" onSubmit={(e) => { e.preventDefault(); m.mutate(); }}>
        <Field label="Location name *" className="full">{(id) => <Input id={id} value={f.name} maxLength={255} autoFocus onChange={(e) => set("name", e.target.value)} placeholder="e.g. Building A, Floor 2, Room 214" />}</Field>
        <Field label="Description" className="full">{(id) => <textarea id={id} className="textarea" rows={2} value={f.description} onChange={(e) => set("description", e.target.value)} />}</Field>
        <Field label="Parent location" className="full">{(id) => <LocationPicker id={id} value={parent} onChange={setParent} exclude={edit ? [edit.id] : []} placeholder="None (top level)" />}</Field>
        {ADDR.map(([k, label, cls]) => <Field key={k} label={label} className={cls}>{(id) => <Input id={id} value={f[k]} onChange={(e) => set(k, e.target.value)} autoComplete="off" />}</Field>)}
        <Field label="Latitude">{(id) => <Input id={id} inputMode="decimal" value={f.latitude} onChange={(e) => set("latitude", e.target.value)} placeholder="39.7589" />}</Field>
        <Field label="Longitude">{(id) => <Input id={id} inputMode="decimal" value={f.longitude} onChange={(e) => set("longitude", e.target.value)} placeholder="-84.1916" />}</Field>
        <div className="full"><button type="button" className="linkbtn small" onClick={useMyPosition}><MapPin size={13} /> Use my current position</button></div>
        <Field label="Teams in charge" className="full">{(id) => <TeamsPicker id={id} value={teams} onChange={setTeams} />}</Field>
        {(opts.data?.location_custom_fields ?? []).map((c) => <CustomInput key={c.id} def={c} value={custom[c.id]} onChange={(v) => setCustom((x) => ({ ...x, [c.id]: v }))} />)}
        {!edit && <PhotoPicker files={files} setFiles={setFiles} />}
        {err && <div className="banner warning full" role="alert">{err}</div>}
      </form>
    </Drawer>
  );
}
