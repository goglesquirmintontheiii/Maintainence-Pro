import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
// Automations (MaintainX Automations, 0.4.0 MP-117): panel view (list + detail) and a table view, filters by asset or
// meter, bulk on / off / delete, copy, and the builder. Links: /automations?new=1&meter=<id> or &asset=<id> open the
// builder prefilled; /automations?meter_id=<id> or ?asset_id=<id> filter the list.
import { useEffect, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Boxes, CheckSquare, Gauge, LayoutList, Plus, Power, PowerOff, Search, Table2, Trash2, Workflow, Wrench, X } from "lucide-react";
import "../../styles/automations.css";
import { api } from "../../lib/api";
import { useSession } from "../../lib/session";
import { timeAgo } from "../../lib/format";
import { useToast } from "../../components/Toast";
import { Button, Checkbox, EmptyState, Input, ListSkeleton, Modal, Pill, Select } from "../../components/ui";
import { AssetPicker } from "../../components/assetPickers";
import { MultiPicker } from "../../components/pickers";
import { AutomationBuilder } from "./Builder";
import { AutomationDetail } from "./AutomationDetail";
import { TRIGGER_LABEL, emptyDoc, useMeterList } from "./types";
const load = () => { try {
    return localStorage.getItem("auto.view") === "table" ? "table" : "panel";
}
catch {
    return "panel";
} };
export function AutomationsPage() {
    const { id } = useParams();
    const [params, setParams] = useSearchParams();
    const { can } = useSession();
    const nav = useNavigate();
    const qc = useQueryClient();
    const { toast } = useToast();
    const manage = can("automations.manage");
    const [view, setViewState] = useState(load);
    const setView = (v) => { setViewState(v); try {
        localStorage.setItem("auto.view", v);
    }
    catch { /* private mode */ } };
    const [q, setQ] = useState("");
    const [asset, setAsset] = useState(() => (params.get("asset_id") ? [params.get("asset_id")] : []));
    const [meter, setMeter] = useState(() => (params.get("meter_id") ? [params.get("meter_id")] : []));
    const [type, setType] = useState("");
    const [active, setActive] = useState("");
    const [creating, setCreating] = useState(null);
    const [selecting, setSelecting] = useState(false);
    const [sel, setSel] = useState([]);
    const [confirmDelete, setConfirmDelete] = useState(false);
    // ?new=1[&meter=<id>|&asset=<id>] opens the builder prefilled (links from the meter and asset pages)
    useEffect(() => {
        if (params.get("new") !== "1")
            return;
        const m = params.get("meter"), a = params.get("asset");
        if (manage) {
            if (m)
                setCreating({ ...emptyDoc("meter_reading"), targets: [m] });
            else if (a)
                setCreating({ ...emptyDoc("asset_status"), targets: [a] });
            else
                setCreating({});
        }
        ["new", "meter", "asset"].forEach((k) => params.delete(k));
        setParams(params, { replace: true });
    }, [params, setParams, manage]);
    const qs = `per_page=100&q=${encodeURIComponent(q)}${asset[0] ? `&asset_id=${asset[0]}` : ""}${meter[0] ? `&meter_id=${meter[0]}` : ""}${type ? `&type=${type}` : ""}${active ? `&active=${active}` : ""}`;
    const list = useInfiniteQuery({
        queryKey: ["automations", qs], initialPageParam: 1, placeholderData: (p) => p,
        queryFn: ({ pageParam }) => api(`/automations?${qs}&page=${pageParam}`),
        getNextPageParam: (l) => (l.page * l.per_page < l.total ? l.page + 1 : undefined),
    });
    const items = list.data?.pages.flatMap((p) => p.items) ?? [];
    const total = list.data?.pages[0]?.total;
    useEffect(() => { setSel([]); }, [qs]);
    const filtered = !!(q || asset.length || meter.length || type || active);
    const clear = () => { setQ(""); setAsset([]); setMeter([]); setType(""); setActive(""); };
    const bulk = useMutation({
        mutationFn: (action) => api("/automations/bulk", { method: "POST", body: { ids: sel, action } }),
        onSuccess: (r, action) => {
            qc.invalidateQueries({ queryKey: ["automations"] });
            qc.invalidateQueries({ queryKey: ["automation"] });
            const n = r.done.length, s = n === 1 ? "" : "s";
            toast(action === "delete" ? `Deleted ${n} automation${s}` : action === "enable" ? `Turned on ${n} automation${s}` : `Turned off ${n} automation${s}`);
            setSel([]);
            setConfirmDelete(false);
            if (action === "delete" && id && r.done.includes(id))
                nav("/automations");
        },
        onError: (e) => toast(e.message, { kind: "error" }),
    });
    const toggleOne = useMutation({
        mutationFn: (a) => api(`/automations/${a.id}`, { method: "PATCH", body: { active: !a.active } }),
        onSuccess: () => { qc.invalidateQueries({ queryKey: ["automations"] }); qc.invalidateQueries({ queryKey: ["automation"] }); },
        onError: (e) => toast(e.message, { kind: "error" }),
    });
    const onSelect = (aid, c) => setSel((s) => (c ? [...s, aid] : s.filter((x) => x !== aid)));
    const tools = (_jsxs("div", { className: "list-tools wo-list-tools auto-tools", children: [_jsxs("div", { className: "row", style: { justifyContent: "space-between" }, children: [_jsx("h1", { style: { fontSize: "var(--fs-lg)" }, children: "Automations" }), _jsxs("div", { className: "row", children: [_jsxs("div", { className: "seg", role: "tablist", "aria-label": "View", children: [_jsx("button", { type: "button", role: "tab", "aria-selected": view === "panel", "aria-label": "Panel view", title: "Panel view", className: "seg-btn" + (view === "panel" ? " on" : ""), onClick: () => setView("panel"), children: _jsx(LayoutList, { size: 15 }) }), _jsx("button", { type: "button", role: "tab", "aria-selected": view === "table", "aria-label": "Table view", title: "Table view", className: "seg-btn" + (view === "table" ? " on" : ""), onClick: () => setView("table"), children: _jsx(Table2, { size: 15 }) })] }), manage && _jsxs(Button, { variant: "primary", onClick: () => setCreating({}), "aria-label": "New automation", children: [_jsx(Plus, { size: 16 }), "New"] })] })] }), _jsxs("div", { className: "search-in", children: [_jsx(Search, { size: 15, className: "faint" }), _jsx(Input, { placeholder: "Search automations", value: q, onChange: (e) => setQ(e.target.value), "aria-label": "Search automations" })] }), _jsxs("div", { className: "auto-filters" + (view === "table" ? " wide" : ""), children: [_jsx(AssetPicker, { value: asset, onChange: (v) => { setAsset(v); if (v.length)
                            setMeter([]); }, placeholder: "All assets" }), _jsx(MeterFilter, { value: meter, onChange: (v) => { setMeter(v); if (v.length)
                            setAsset([]); } }), _jsxs(Select, { "aria-label": "Trigger", value: type, onChange: (e) => setType(e.target.value), children: [_jsx("option", { value: "", children: "All triggers" }), Object.keys(TRIGGER_LABEL).map((k) => _jsx("option", { value: k, children: TRIGGER_LABEL[k] }, k))] }), _jsxs(Select, { "aria-label": "On or off", value: active, onChange: (e) => setActive(e.target.value), children: [_jsx("option", { value: "", children: "On and off" }), _jsx("option", { value: "1", children: "On" }), _jsx("option", { value: "0", children: "Off" })] })] }), _jsxs("div", { className: "row small muted", style: { justifyContent: "space-between" }, children: [_jsxs("span", { children: [total === undefined ? " " : `${total} automation${total === 1 ? "" : "s"}`, filtered && _jsxs(_Fragment, { children: [" \u00B7 ", _jsx("button", { className: "linkbtn small", onClick: clear, children: "Clear" })] })] }), _jsxs("span", { className: "row", style: { gap: 8 }, children: [selecting && items.length > 0 && _jsx(Checkbox, { checked: sel.length === items.length, indeterminate: sel.length > 0 && sel.length < items.length, onChange: (c) => setSel(c ? items.map((m) => m.id) : []), label: "All" }), manage && view === "panel" && _jsxs(Button, { size: "sm", variant: selecting ? "primary" : "ghost", "aria-pressed": selecting, onClick: () => { setSelecting((s) => !s); setSel([]); }, children: [_jsx(CheckSquare, { size: 14 }), "Select"] })] })] })] }));
    const empty = (_jsx(EmptyState, { icon: _jsx(Workflow, { size: 26 }), title: filtered ? "No automations match" : "No automations yet", action: !filtered && manage ? _jsxs(Button, { variant: "primary", onClick: () => setCreating({}), children: [_jsx(Plus, { size: 15 }), "New automation"] }) : undefined, children: filtered ? "Try clearing the filters." : "Create work orders, change asset statuses or send emails automatically when a meter reading, asset status or work order status changes." }));
    const bulkBar = sel.length > 0 && (_jsxs("div", { className: "bulkbar", role: "toolbar", "aria-label": "Bulk actions", children: [_jsxs("span", { className: "small", children: [_jsx("b", { children: sel.length }), " selected"] }), _jsxs(Button, { size: "sm", onClick: () => bulk.mutate("enable"), disabled: bulk.isPending, children: [_jsx(Power, { size: 14 }), "Turn on"] }), _jsxs(Button, { size: "sm", onClick: () => bulk.mutate("disable"), disabled: bulk.isPending, children: [_jsx(PowerOff, { size: 14 }), "Turn off"] }), _jsxs(Button, { size: "sm", onClick: () => setConfirmDelete(true), children: [_jsx(Trash2, { size: 14 }), "Delete"] }), _jsx("span", { className: "grow" }), _jsx(Button, { size: "sm", variant: "ghost", icon: true, "aria-label": "Clear selection", onClick: () => setSel([]), children: _jsx(X, { size: 14 }) })] }));
    return (_jsxs("div", { className: "wo-page", children: [view === "panel" ? (_jsxs("div", { className: "split wo-split" + (id ? " has-detail" : ""), children: [_jsxs("div", { className: "split-list", children: [tools, _jsxs("div", { className: "list", role: "list", children: [list.isLoading ? _jsx(ListSkeleton, {}) : items.length === 0 ? empty : items.map((a) => (_jsx(AutomationRow, { a: a, active: a.id === id, selecting: selecting, selected: sel.includes(a.id), onSelect: (c) => onSelect(a.id, c) }, a.id))), list.hasNextPage && _jsx("div", { style: { padding: 12, textAlign: "center" }, children: _jsx(Button, { size: "sm", onClick: () => list.fetchNextPage(), disabled: list.isFetchingNextPage, children: "Load more" }) })] }), bulkBar] }), _jsx("div", { className: "split-detail", children: id ? _jsx(AutomationDetail, { id: id }, id) : _jsx(EmptyState, { icon: _jsx(Workflow, { size: 28 }), title: "Select an automation", children: "Pick one from the list to see what it does and when it ran." }) })] })) : (_jsxs("div", { className: "wo-scroll auto-table-view", children: [tools, list.isLoading ? _jsx(ListSkeleton, {}) : items.length === 0 ? empty : (_jsx("div", { className: "table-wrap card", children: _jsxs("table", { className: "table auto-table", children: [_jsx("thead", { children: _jsxs("tr", { children: [manage && _jsx("th", { style: { width: 36 }, children: _jsx(Checkbox, { checked: sel.length === items.length, indeterminate: sel.length > 0 && sel.length < items.length, onChange: (c) => setSel(c ? items.map((m) => m.id) : []), label: _jsx("span", { className: "sr-only", children: "Select all" }) }) }), _jsx("th", { children: "Name" }), _jsx("th", { className: "desktop-only", children: "Trigger" }), _jsx("th", { className: "desktop-only", children: "Watching" }), _jsx("th", { children: "Ran" }), _jsx("th", { className: "desktop-only", children: "Last run" }), _jsx("th", { children: "On" })] }) }), _jsx("tbody", { children: items.map((a) => (_jsxs("tr", { children: [manage && _jsx("td", { children: _jsx(Checkbox, { checked: sel.includes(a.id), onChange: (c) => onSelect(a.id, c), label: _jsxs("span", { className: "sr-only", children: ["Select ", a.name] }) }) }), _jsxs("td", { children: [_jsx(Link, { to: `/automations/${a.id}`, onClick: () => setView("panel"), children: _jsx("b", { children: a.name }) }), _jsx("div", { className: "small muted auto-clamp", children: a.summary })] }), _jsx("td", { className: "small desktop-only", children: TRIGGER_LABEL[a.trigger.type] }), _jsx("td", { className: "small desktop-only", children: watching(a) }), _jsxs("td", { className: "small tnum", children: [a.run_count, a.fail_count > 0 && _jsx("div", { children: _jsxs(Pill, { tone: "danger", children: [a.fail_count, " failed"] }) })] }), _jsx("td", { className: "small desktop-only", children: a.last_run_at ? timeAgo(a.last_run_at) : _jsx("span", { className: "faint", children: "Never" }) }), _jsx("td", { children: manage ? _jsx("input", { type: "checkbox", role: "switch", className: "switch", checked: a.active, "aria-label": `${a.name} on`, onChange: () => toggleOne.mutate(a) })
                                                    : a.active ? "On" : "Off" })] }, a.id))) })] }) })), list.hasNextPage && _jsx("div", { style: { padding: 12, textAlign: "center" }, children: _jsx(Button, { size: "sm", onClick: () => list.fetchNextPage(), disabled: list.isFetchingNextPage, children: "Load more" }) }), bulkBar && _jsx("div", { className: "auto-bulk-float", children: bulkBar })] })), creating && _jsx(AutomationBuilder, { init: creating, onClose: () => setCreating(null), onSaved: (a) => { setCreating(null); setView("panel"); nav(`/automations/${a.id}`); } }), confirmDelete && _jsx(Modal, { title: `Delete ${sel.length} automation${sel.length === 1 ? "" : "s"}?`, onClose: () => setConfirmDelete(false), footer: _jsxs(_Fragment, { children: [_jsx(Button, { onClick: () => setConfirmDelete(false), children: "Cancel" }), _jsx(Button, { variant: "danger", disabled: bulk.isPending, onClick: () => bulk.mutate("delete"), children: "Delete" })] }), children: _jsx("p", { children: "They stop running. Work orders they already created are kept." }) })] }));
}
function watching(a) {
    if (!a.targets.length)
        return "Any asset";
    const more = a.targets.length - a.target_names.slice(0, 2).length;
    return a.target_names.slice(0, 2).join(", ") + (more > 0 ? ` +${more}` : "");
}
function AutomationRow({ a, active, selecting, selected, onSelect }) {
    const Icon = a.trigger.type === "meter_reading" ? Gauge : a.trigger.type === "asset_status" ? Boxes : Wrench;
    return (_jsxs(Link, { to: `/automations/${a.id}`, className: "list-row auto-row" + (active ? " active" : "") + (a.active ? "" : " off"), role: "listitem", children: [selecting && _jsx("span", { onClick: (e) => e.stopPropagation(), children: _jsx(Checkbox, { checked: selected, onChange: onSelect, label: _jsxs("span", { className: "sr-only", children: ["Select ", a.name] }) }) }), _jsx("span", { className: "auto-row-ic" + (a.active ? "" : " off"), "aria-hidden": "true", children: _jsx(Icon, { size: 16 }) }), _jsxs("div", { className: "grow", style: { minWidth: 0 }, children: [_jsx("div", { className: "t", children: a.name }), _jsx("div", { className: "s", children: watching(a) })] }), _jsxs("div", { className: "auto-row-side", children: [a.active ? _jsx(Pill, { tone: "success", children: "On" }) : _jsx(Pill, { children: "Off" }), _jsx("span", { className: "small faint", children: a.fail_count ? _jsxs("span", { style: { color: "var(--c-danger)" }, children: [a.fail_count, " failed"] }) : a.last_run_at ? `Ran ${timeAgo(a.last_run_at)}` : "Not run yet" })] })] }));
}
function MeterFilter({ value, onChange }) {
    const meters = useMeterList();
    const opts = (meters.data?.items ?? []).map((m) => ({ key: m.id, label: m.name, sub: m.asset?.name, icon: _jsx(Gauge, { size: 14, className: "faint" }) }));
    return _jsx(MultiPicker, { label: "Meter", single: true, placeholder: "All meters", options: opts, value: value, onChange: onChange, searchPlaceholder: "Search meters", renderValue: (s) => _jsxs("span", { className: "chip", children: [_jsx(Gauge, { size: 12 }), s[0].label] }) });
}
