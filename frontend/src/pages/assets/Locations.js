import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
// Locations: tree (list + detail) with sub-locations, the assets and work in each, floor plans and history.
import { useEffect, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Boxes, ChevronDown, ChevronRight, ClipboardList, ExternalLink, Link2, MapPin, MoreHorizontal, Pencil, Plus, RotateCcw, Search, Trash2 } from "lucide-react";
import { api } from "../../lib/api";
import { useAssetOptions } from "../../lib/assets";
import { useSession } from "../../lib/session";
import { absoluteUrl, copyText, filtersParam } from "../../lib/wo";
import { currency, dateTime } from "../../lib/format";
import { useToast } from "../../components/Toast";
import { Button, Dropdown, Drawer, EmptyState, Field, Input, ListSkeleton, Modal } from "../../components/ui";
import { LocationPicker } from "../../components/assetPickers";
import { CustomInput } from "../workorders/Form";
import { WORow } from "../workorders/WorkOrders";
import { AssetStatusPill, Crumbs, FilesSection, HistoryList, PhotoPicker, TeamChips, TeamsPicker } from "./shared";
import { FloorPlans } from "./FloorPlans";
const TABS = [["details", "Details"], ["assets", "Assets"], ["sub-locations", "Sub-locations"], ["work-orders", "Work Orders"], ["floor-plans", "Floor plans"], ["history", "History"]];
export function LocationsPage() {
    const { id, tab } = useParams();
    const [params, setParams] = useSearchParams();
    const { can } = useSession();
    const nav = useNavigate();
    const [q, setQ] = useState("");
    const [creating, setCreating] = useState(params.get("new") === "1" ? {} : null);
    useEffect(() => { if (params.get("new") === "1") {
        setCreating({});
        const p = new URLSearchParams(params);
        p.delete("new");
        setParams(p, { replace: true });
    } }, [params, setParams]);
    return (_jsxs("div", { className: "wo-page", children: [_jsxs("div", { className: "split wo-split" + (id ? " has-detail" : ""), children: [_jsxs("div", { className: "split-list", children: [_jsx("div", { className: "list-tools wo-list-tools", children: _jsxs("div", { className: "wo-toolbar compact", children: [_jsxs("div", { className: "row", style: { justifyContent: "space-between" }, children: [_jsx("h1", { children: "Locations" }), can("locations.manage") && _jsxs(Button, { variant: "primary", onClick: () => setCreating({}), "aria-label": "New Location", children: [_jsx(Plus, { size: 16 }), "New"] })] }), _jsxs("div", { className: "search-in", children: [_jsx(Search, { size: 15, className: "faint" }), _jsx(Input, { placeholder: "Search locations", value: q, onChange: (e) => setQ(e.target.value), "aria-label": "Search locations" })] })] }) }), _jsx("div", { className: "list", role: "tree", "aria-label": "Locations", children: q.trim() ? _jsx(LocFlat, { q: q.trim(), activeId: id }) : _jsx(LocTree, { activeId: id }) })] }), _jsx("div", { className: "split-detail", children: id ? _jsx(LocationDetailView, { id: id, tab: (TABS.some(([k]) => k === tab) ? tab : "details"), onTab: (t) => nav(t === "details" ? `/locations/${id}` : `/locations/${id}/${t}`, { replace: true }), onAddChild: (p) => setCreating({ parent: p }) }, id)
                            : _jsx(EmptyState, { icon: _jsx(MapPin, { size: 28 }), title: "Select a location", children: "Pick a site, building or room to see its assets, work orders and floor plans." }) })] }), creating && _jsx(LocationForm, { parentId: creating.parent, onClose: () => setCreating(null), onSaved: (l) => { setCreating(null); nav(`/locations/${l.id}`); } })] }));
}
function LocTree({ activeId }) {
    const roots = useQuery({ queryKey: ["locations", "tree", "root"], queryFn: () => api("/locations?parent_id=root&per_page=500") });
    const { can } = useSession();
    if (roots.isLoading)
        return _jsx(ListSkeleton, {});
    const items = roots.data?.items ?? [];
    if (!items.length)
        return _jsx(EmptyState, { icon: _jsx(MapPin, { size: 26 }), title: "No locations yet", children: can("locations.manage") ? "Add your sites first, then buildings, floors and rooms inside them." : "Locations your team adds show here." });
    return _jsx(_Fragment, { children: items.map((l) => _jsx(LocNode, { l: l, depth: 0, activeId: activeId }, l.id)) });
}
function LocNode({ l, depth, activeId }) {
    const [open, setOpen] = useState(depth === 0);
    const kids = useQuery({ queryKey: ["locations", "tree", l.id], queryFn: () => api(`/locations?parent_id=${l.id}&per_page=500`), enabled: open && l.child_count > 0 });
    return (_jsxs("div", { role: "treeitem", "aria-expanded": l.child_count ? open : undefined, "aria-selected": l.id === activeId, children: [_jsxs("div", { className: "tree-row" + (l.id === activeId ? " active" : ""), style: { paddingLeft: 8 + depth * 18 }, children: [l.child_count > 0 ? _jsx("button", { type: "button", className: "tree-tog", "aria-label": open ? `Collapse ${l.name}` : `Expand ${l.name}`, onClick: () => setOpen((o) => !o), children: open ? _jsx(ChevronDown, { size: 15 }) : _jsx(ChevronRight, { size: 15 }) }) : _jsx("span", { className: "tree-tog" }), _jsx(LocRowBody, { l: l })] }), open && (kids.data?.items ?? []).map((c) => _jsx(LocNode, { l: c, depth: depth + 1, activeId: activeId }, c.id))] }));
}
function LocRowBody({ l, showPath }) {
    return (_jsxs(Link, { to: `/locations/${l.id}`, className: "tree-link", children: [_jsx("span", { className: "asset-thumb ph", "aria-hidden": "true", children: _jsx(MapPin, { size: 15 }) }), _jsxs("span", { className: "grow", style: { minWidth: 0 }, children: [_jsx("span", { className: "t", children: l.name }), _jsx("span", { className: "s", children: [showPath && l.path.length ? l.path.map((p) => p.name).join(" › ") : "", l.city, l.asset_count ? `${l.asset_count} asset${l.asset_count === 1 ? "" : "s"}` : ""].filter(Boolean).join(" · ") || " " })] }), l.open_work_orders > 0 && _jsx("span", { className: "wo-count", title: `${l.open_work_orders} open work orders`, children: l.open_work_orders })] }));
}
function LocFlat({ q, activeId }) {
    const r = useQuery({ queryKey: ["locations", "search", q], queryFn: () => api(`/locations?per_page=200&q=${encodeURIComponent(q)}`), placeholderData: (p) => p });
    if (r.isLoading)
        return _jsx(ListSkeleton, {});
    const items = r.data?.items ?? [];
    if (!items.length)
        return _jsx(EmptyState, { title: "No locations match" });
    return _jsx(_Fragment, { children: items.map((l) => _jsx("div", { className: "tree-row" + (l.id === activeId ? " active" : ""), style: { paddingLeft: 12 }, children: _jsx(LocRowBody, { l: l, showPath: true }) }, l.id)) });
}
function LocationDetailView({ id, tab, onTab, onAddChild }) {
    const q = useQuery({ queryKey: ["location", id], queryFn: () => api(`/locations/${id}`) });
    const { can, session } = useSession();
    const qc = useQueryClient();
    const nav = useNavigate();
    const { toast } = useToast();
    const [editing, setEditing] = useState(false);
    const [confirm, setConfirm] = useState(false);
    const refresh = () => { qc.invalidateQueries({ queryKey: ["location", id] }); qc.invalidateQueries({ queryKey: ["locations"] }); qc.invalidateQueries({ queryKey: ["location-pick"] }); };
    const del = useMutation({ mutationFn: () => api(`/locations/${id}`, { method: "DELETE" }), onSuccess: () => { refresh(); setConfirm(false); toast("Location deleted"); },
        onError: (e) => { setConfirm(false); toast(e.message, { kind: "error" }); } });
    const restore = useMutation({ mutationFn: () => api(`/locations/${id}/restore`, { method: "POST" }), onSuccess: () => { refresh(); toast("Restored"); },
        onError: (e) => toast(e.message, { kind: "error" }) });
    if (q.isError)
        return _jsx(EmptyState, { icon: _jsx(MapPin, { size: 28 }), title: "Location not found" });
    const l = q.data;
    if (!l)
        return _jsx("div", { className: "detail", children: _jsx(ListSkeleton, { rows: 5 }) });
    const tz = session.org?.timezone;
    const manage = can("locations.manage") && !l.deleted;
    return (_jsxs("div", { className: "detail asset-detail", children: [_jsxs(Link, { to: "/locations", className: "row small mobile-only", children: [_jsx(ArrowLeft, { size: 14 }), "All locations"] }), l.deleted && _jsxs("div", { className: "banner warning", children: [_jsx(Trash2, { size: 18 }), _jsx("div", { className: "grow", children: "This location was deleted." }), can("locations.delete") && _jsxs(Button, { size: "sm", onClick: () => restore.mutate(), children: [_jsx(RotateCcw, { size: 14 }), "Restore"] })] }), _jsxs("div", { className: "wo-head", children: [_jsx("span", { className: "asset-hero ph", "aria-hidden": "true", children: _jsx(MapPin, { size: 26 }) }), _jsxs("div", { className: "grow", children: [_jsx(Crumbs, { path: l.path, base: "/locations", baseLabel: "Locations" }), _jsx("h1", { className: "wo-title", children: l.name }), _jsxs("div", { className: "row wrap small muted", style: { marginTop: 4 }, children: [l.address && _jsx("span", { children: l.address }), l.maps_url && _jsxs("a", { href: l.maps_url, target: "_blank", rel: "noopener noreferrer", className: "row", style: { gap: 4 }, children: [_jsx(ExternalLink, { size: 13 }), "Open in maps"] })] })] }), _jsxs("div", { className: "row", children: [manage && _jsxs(Button, { onClick: () => setEditing(true), "aria-label": "Edit location", children: [_jsx(Pencil, { size: 15 }), _jsx("span", { className: "desktop-only", children: "Edit" })] }), _jsx(Dropdown, { trigger: (_, t) => _jsx(Button, { icon: true, "aria-label": "More actions", onClick: t, children: _jsx(MoreHorizontal, { size: 18 }) }), width: 240, children: (close) => _jsxs(_Fragment, { children: [can("wo.create") && !l.deleted && _jsxs("button", { className: "menu-item", onClick: () => { close(); nav(`/work-orders?new=1&location=${l.id}`); }, children: [_jsx(ClipboardList, { size: 15 }), "New work order"] }), manage && _jsxs("button", { className: "menu-item", onClick: () => { close(); onAddChild(l.id); }, children: [_jsx(Plus, { size: 15 }), "Add sub-location"] }), can("assets.manage") && !l.deleted && _jsxs("button", { className: "menu-item", onClick: () => { close(); nav("/assets?new=1"); }, children: [_jsx(Boxes, { size: 15 }), "New asset"] }), _jsxs("button", { className: "menu-item", onClick: async () => { close(); toast((await copyText(absoluteUrl(`/locations/${l.id}`))) ? "Link copied" : "Couldn't copy the link"); }, children: [_jsx(Link2, { size: 15 }), "Copy link"] }), can("locations.delete") && !l.deleted && _jsxs(_Fragment, { children: [_jsx("div", { className: "menu-sep" }), _jsxs("button", { className: "menu-item", style: { color: "var(--c-danger)" }, onClick: () => { close(); setConfirm(true); }, children: [_jsx(Trash2, { size: 15 }), "Delete"] })] })] }) })] })] }), _jsx("div", { className: "tabs asset-tabs", role: "tablist", "aria-label": "Location sections", ref: (el) => el?.querySelector("[aria-selected=true]")?.scrollIntoView({ block: "nearest", inline: "nearest" }), children: TABS.map(([k, label]) => _jsxs("button", { type: "button", role: "tab", className: "tab", "aria-selected": tab === k, onClick: () => onTab(k), children: [label, k === "assets" && l.asset_count > 0 && _jsx("span", { className: "tab-count", children: l.asset_count }), k === "sub-locations" && l.child_count > 0 && _jsx("span", { className: "tab-count", children: l.child_count })] }, k)) }), tab === "details" && _jsxs("div", { className: "stack", style: { gap: 16 }, children: [l.description && _jsx("section", { className: "card card-pad prewrap", children: l.description }), _jsxs("dl", { className: "meta-grid card card-pad", children: [_jsxs("div", { className: "span2", children: [_jsx("dt", { children: "Address" }), _jsx("dd", { children: l.address || _jsx("span", { className: "faint", children: "None" }) })] }), _jsxs("div", { children: [_jsx("dt", { children: "Coordinates" }), _jsx("dd", { children: l.latitude !== null && l.longitude !== null ? _jsxs("span", { className: "mono", children: [l.latitude.toFixed(5), ", ", l.longitude.toFixed(5)] }) : _jsx("span", { className: "faint", children: "None" }) })] }), _jsxs("div", { className: "span2", children: [_jsx("dt", { children: "Teams in charge" }), _jsx("dd", { children: _jsx(TeamChips, { teams: l.teams }) })] }), _jsxs("div", { children: [_jsx("dt", { children: "Assets (incl. sub-locations)" }), _jsx("dd", { children: l.asset_count })] }), _jsxs("div", { children: [_jsx("dt", { children: "Open work orders" }), _jsx("dd", { children: l.open_work_orders })] }), _jsx(LocCustom, { l: l }), _jsxs("div", { children: [_jsx("dt", { children: "Created" }), _jsx("dd", { className: "small", children: dateTime(l.created_at, tz) })] })] }), _jsx(FilesSection, { files: l.files, entityType: "location", entityId: l.id, editable: manage, queryKey: ["location", l.id] })] }), tab === "assets" && _jsx(LocAssets, { id: l.id }), tab === "sub-locations" && _jsx(SubLocations, { id: l.id, onAdd: manage ? () => onAddChild(l.id) : undefined }), tab === "work-orders" && _jsx(LocWorkOrders, { id: l.id }), tab === "floor-plans" && _jsx(FloorPlans, { loc: l, editable: manage }), tab === "history" && _jsx(HistoryList, { path: `/locations/${l.id}/history`, tz: tz }), editing && _jsx(LocationForm, { edit: l, onClose: () => setEditing(false), onSaved: () => { setEditing(false); refresh(); } }), confirm && _jsx(Modal, { title: "Delete location?", onClose: () => setConfirm(false), footer: _jsxs(_Fragment, { children: [_jsx(Button, { onClick: () => setConfirm(false), children: "Cancel" }), _jsx(Button, { variant: "danger", onClick: () => del.mutate(), disabled: del.isPending, children: "Delete" })] }), children: _jsxs("p", { children: [l.name, " will be removed. Locations with sub-locations or assets can't be deleted until those are moved."] }) })] }));
}
function LocCustom({ l }) {
    const { session } = useSession();
    const opts = useAssetOptions();
    const defs = (opts.data?.location_custom_fields ?? []).filter((f) => l.custom[f.id] !== undefined && l.custom[f.id] !== "");
    return _jsx(_Fragment, { children: defs.map((f) => _jsxs("div", { children: [_jsx("dt", { children: f.name }), _jsx("dd", { children: f.type === "checkbox" ? (l.custom[f.id] ? "Yes" : "No") : f.type === "currency" ? currency(l.custom[f.id], session.org?.currency) : String(l.custom[f.id]) })] }, f.id)) });
}
function LocAssets({ id }) {
    const q = useQuery({ queryKey: ["assets", "at-location", id], queryFn: () => api(`/assets?location_id=${id}&per_page=200&sort=name`) });
    if (!q.data)
        return _jsx(ListSkeleton, { rows: 4 });
    if (!q.data.items.length)
        return _jsx(EmptyState, { icon: _jsx(Boxes, { size: 24 }), title: "No assets here", children: "Assets in this location and its sub-locations show here." });
    return (_jsxs("section", { className: "card", children: [_jsx("div", { className: "card-head", children: _jsxs("span", { className: "small muted", children: [q.data.total, " asset", q.data.total === 1 ? "" : "s", ", including sub-locations"] }) }), q.data.items.map((a) => _jsxs(Link, { to: `/assets/${a.id}`, className: "list-row", children: [_jsx("span", { className: "astat-dot " + a.status }), _jsxs("span", { className: "grow", children: [_jsx("span", { className: "t", style: { display: "block" }, children: a.name }), _jsx("span", { className: "s", children: [a.location?.name, a.manufacturer, a.model].filter(Boolean).join(" · ") })] }), _jsx(AssetStatusPill, { status: a.status })] }, a.id))] }));
}
function SubLocations({ id, onAdd }) {
    const q = useQuery({ queryKey: ["locations", "tree", id], queryFn: () => api(`/locations?parent_id=${id}&per_page=500`) });
    return (_jsxs("section", { className: "card", children: [_jsxs("div", { className: "card-head", children: [_jsxs("span", { className: "small muted", children: [q.data?.total ?? "", " sub-location", q.data?.total === 1 ? "" : "s"] }), onAdd && _jsxs(Button, { size: "sm", onClick: onAdd, children: [_jsx(Plus, { size: 14 }), "Add sub-location"] })] }), !q.data ? _jsx(ListSkeleton, { rows: 3 }) : q.data.items.length === 0 ? _jsx("div", { className: "card-body small faint", children: "No sub-locations yet." })
                : q.data.items.map((l) => _jsxs(Link, { to: `/locations/${l.id}`, className: "list-row", children: [_jsx(MapPin, { size: 16, className: "faint" }), _jsx("span", { className: "grow t", children: l.name }), _jsxs("span", { className: "small faint", children: [l.asset_count, " assets \u00B7 ", l.child_count, " sub"] })] }, l.id))] }));
}
function LocWorkOrders({ id }) {
    const [tab, setTab] = useState("todo");
    const { session } = useSession();
    const q = useQuery({ queryKey: ["work-orders", "location", id, tab], queryFn: () => api(`/work-orders?tab=${tab}&per_page=50&sort=-created_at${filtersParam([{ field: "location", op: "within", value: [id] }])}`) });
    return (_jsxs("section", { className: "card", children: [_jsxs("div", { className: "card-head", children: [_jsx("div", { className: "seg", role: "tablist", "aria-label": "Work orders", children: ["todo", "done", "all"].map((t) => (_jsx("button", { type: "button", role: "tab", "aria-selected": tab === t, className: "seg-btn" + (tab === t ? " on" : ""), onClick: () => setTab(t), children: t === "todo" ? "To Do" : t === "done" ? "Done" : "All" }, t))) }), _jsx("span", { className: "small muted", children: q.data?.total ?? "" })] }), !q.data ? _jsx(ListSkeleton, { rows: 3 }) : q.data.items.length === 0 ? _jsx(EmptyState, { icon: _jsx(ClipboardList, { size: 24 }), title: "No work orders", children: "Work at this location and its sub-locations shows here." })
                : q.data.items.map((w) => _jsx(WORow, { w: w, tz: session.org?.timezone }, w.id))] }));
}
// ---------------------------------------------------------------- form
const ADDR = [["address_line1", "Address line 1", "full"], ["address_line2", "Address line 2", "full"], ["city", "City", ""], ["region", "State / region", ""],
    ["postal_code", "Postal code", ""], ["country", "Country", ""]];
function LocationForm({ edit, parentId, onClose, onSaved }) {
    const opts = useAssetOptions();
    const qc = useQueryClient();
    const { toast } = useToast();
    const [f, setF] = useState(() => ({
        name: edit?.name ?? "", description: edit?.description ?? "", address_line1: edit?.address_line1 ?? "", address_line2: edit?.address_line2 ?? "", city: edit?.city ?? "",
        region: edit?.region ?? "", postal_code: edit?.postal_code ?? "", country: edit?.country ?? "",
        latitude: edit?.latitude?.toString() ?? "", longitude: edit?.longitude?.toString() ?? ""
    }));
    const [parent, setParent] = useState(edit?.parent_id ?? parentId ?? null);
    const [teams, setTeams] = useState(edit?.teams.map((t) => t.id) ?? []);
    const [custom, setCustom] = useState(edit?.custom ?? {});
    const [files, setFiles] = useState([]);
    const [err, setErr] = useState("");
    const set = (k, v) => setF((x) => ({ ...x, [k]: v }));
    const body = () => ({ ...f, latitude: f.latitude.trim() === "" ? null : Number(f.latitude), longitude: f.longitude.trim() === "" ? null : Number(f.longitude),
        parent_id: parent, teams, custom, ...(edit ? {} : { file_ids: files.map((x) => x.id) }) });
    const m = useMutation({
        mutationFn: () => edit ? api(`/locations/${edit.id}`, { method: "PATCH", body: body() }) : api("/locations", { method: "POST", body: body() }),
        onSuccess: (l) => {
            qc.invalidateQueries({ queryKey: ["locations"] });
            qc.invalidateQueries({ queryKey: ["location-pick"] });
            qc.setQueryData(["location", l.id], l);
            toast(edit ? "Location saved" : `Location ${l.name} created`);
            onSaved(l);
        },
        onError: (e) => setErr(e.message),
    });
    const useMyPosition = () => {
        if (!navigator.geolocation) {
            toast("This browser can't share its location.", { kind: "error" });
            return;
        }
        navigator.geolocation.getCurrentPosition((p) => { set("latitude", p.coords.latitude.toFixed(6)); set("longitude", p.coords.longitude.toFixed(6)); }, () => toast("Couldn't get your position. Check the browser's location permission.", { kind: "error" }), { enableHighAccuracy: true, timeout: 10000 });
    };
    return (_jsx(Drawer, { title: edit ? "Edit location" : "New location", onClose: onClose, width: 580, footer: _jsxs(_Fragment, { children: [_jsx(Button, { onClick: onClose, children: "Cancel" }), _jsx("span", { className: "grow" }), _jsx(Button, { variant: "primary", disabled: !f.name.trim() || m.isPending, onClick: () => { setErr(""); m.mutate(); }, children: m.isPending ? "Saving…" : edit ? "Save" : "Create location" })] }), children: _jsxs("form", { className: "form-grid", onSubmit: (e) => { e.preventDefault(); m.mutate(); }, children: [_jsx(Field, { label: "Location name *", className: "full", children: (id) => _jsx(Input, { id: id, value: f.name, maxLength: 255, autoFocus: true, onChange: (e) => set("name", e.target.value), placeholder: "e.g. Building A, Floor 2, Room 214" }) }), _jsx(Field, { label: "Description", className: "full", children: (id) => _jsx("textarea", { id: id, className: "textarea", rows: 2, value: f.description, onChange: (e) => set("description", e.target.value) }) }), _jsx(Field, { label: "Parent location", className: "full", children: (id) => _jsx(LocationPicker, { id: id, value: parent, onChange: setParent, exclude: edit ? [edit.id] : [], placeholder: "None (top level)" }) }), ADDR.map(([k, label, cls]) => _jsx(Field, { label: label, className: cls, children: (id) => _jsx(Input, { id: id, value: f[k], onChange: (e) => set(k, e.target.value), autoComplete: "off" }) }, k)), _jsx(Field, { label: "Latitude", children: (id) => _jsx(Input, { id: id, inputMode: "decimal", value: f.latitude, onChange: (e) => set("latitude", e.target.value), placeholder: "39.7589" }) }), _jsx(Field, { label: "Longitude", children: (id) => _jsx(Input, { id: id, inputMode: "decimal", value: f.longitude, onChange: (e) => set("longitude", e.target.value), placeholder: "-84.1916" }) }), _jsx("div", { className: "full", children: _jsxs("button", { type: "button", className: "linkbtn small", onClick: useMyPosition, children: [_jsx(MapPin, { size: 13 }), " Use my current position"] }) }), _jsx(Field, { label: "Teams in charge", className: "full", children: (id) => _jsx(TeamsPicker, { id: id, value: teams, onChange: setTeams }) }), (opts.data?.location_custom_fields ?? []).map((c) => _jsx(CustomInput, { def: c, value: custom[c.id], onChange: (v) => setCustom((x) => ({ ...x, [c.id]: v })) }, c.id)), !edit && _jsx(PhotoPicker, { files: files, setFiles: setFiles }), err && _jsx("div", { className: "banner warning full", role: "alert", children: err })] }) }));
}
