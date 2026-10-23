import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
// Meters: list + detail split like Work Orders (MaintainX Meters), with bulk edit and monitoring points.
import { useEffect, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { CheckSquare, Clock, Gauge, MoreHorizontal, Pencil, Plus, Radio, Search, Trash2, X } from "lucide-react";
import "../../styles/meters.css";
import { api } from "../../lib/api";
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
    const [asset, setAsset] = useState(() => (params.get("asset_id") ? [params.get("asset_id")] : []));
    const [status, setStatus] = useState(() => params.get("overdue") === "1" ? "overdue" : params.get("level") === "alarm" ? "alarm" : params.get("level") === "warning" ? "warning" : "");
    const [creating, setCreating] = useState(false);
    const [points, setPoints] = useState(false);
    const [selecting, setSelecting] = useState(false);
    const [sel, setSel] = useState([]);
    const [bulk, setBulk] = useState(null);
    useEffect(() => { if (params.get("new") === "1") {
        setCreating(true);
        params.delete("new");
        setParams(params, { replace: true });
    } }, [params, setParams]);
    const qs = `per_page=50&q=${encodeURIComponent(q)}${asset[0] ? `&asset_id=${asset[0]}` : ""}${status === "overdue" ? "&overdue=1" : status ? `&level=${status}` : ""}`;
    const list = useInfiniteQuery({
        queryKey: ["meters", qs], initialPageParam: 1,
        queryFn: ({ pageParam }) => api(`/meters?${qs}&page=${pageParam}`),
        getNextPageParam: (l) => (l.page * l.per_page < l.total ? l.page + 1 : undefined),
        placeholderData: (p) => p,
    });
    const items = list.data?.pages.flatMap((p) => p.items) ?? [];
    const total = list.data?.pages[0]?.total;
    useEffect(() => { setSel([]); }, [qs]);
    const del = useMutation({
        mutationFn: () => api("/meters/bulk", { method: "POST", body: { ids: sel, action: "delete" } }),
        onSuccess: (r) => { qc.invalidateQueries({ queryKey: ["meters"] }); setBulk(null); setSel([]); toast(`Deleted ${r.done.length} meter${r.done.length === 1 ? "" : "s"}`); if (id && r.done.includes(id))
            nav("/meters"); },
        onError: (e) => toast(e.message, { kind: "error" }),
    });
    const filtered = !!(q || asset.length || status);
    return (_jsxs("div", { className: "wo-page", children: [_jsxs("div", { className: "split wo-split" + (id ? " has-detail" : ""), children: [_jsxs("div", { className: "split-list", children: [_jsxs("div", { className: "list-tools wo-list-tools", children: [_jsxs("div", { className: "row", style: { justifyContent: "space-between" }, children: [_jsx("h1", { style: { fontSize: "var(--fs-lg)" }, children: "Meters" }), _jsxs("div", { className: "row", children: [_jsx(Dropdown, { trigger: (_, t) => _jsx(Button, { icon: true, "aria-label": "More", onClick: t, children: _jsx(MoreHorizontal, { size: 18 }) }), width: 230, children: (close) => _jsxs("button", { className: "menu-item", onClick: () => { close(); setPoints(true); }, children: [_jsx(Radio, { size: 15 }), "Monitoring points\u2026"] }) }), can("meters.manage") && _jsxs(Button, { variant: "primary", onClick: () => setCreating(true), "aria-label": "New meter", children: [_jsx(Plus, { size: 16 }), "New"] })] })] }), _jsxs("div", { className: "search-in", children: [_jsx(Search, { size: 15, className: "faint" }), _jsx(Input, { placeholder: "Search meters", value: q, onChange: (e) => setQ(e.target.value), "aria-label": "Search meters" })] }), _jsxs("div", { className: "row", style: { gap: 6 }, children: [_jsx("div", { className: "grow", style: { minWidth: 0 }, children: _jsx(AssetPicker, { value: asset, onChange: setAsset, placeholder: "All assets" }) }), _jsxs(Select, { "aria-label": "Show", value: status, onChange: (e) => setStatus(e.target.value), style: { width: 150 }, children: [_jsx("option", { value: "", children: "All meters" }), _jsx("option", { value: "overdue", children: "Reading overdue" }), _jsx("option", { value: "warning", children: "In warning" }), _jsx("option", { value: "alarm", children: "In alarm" })] })] }), _jsxs("div", { className: "row small muted", style: { justifyContent: "space-between" }, children: [_jsxs("span", { children: [total === undefined ? " " : `${total} meter${total === 1 ? "" : "s"}`, filtered && _jsxs(_Fragment, { children: [" \u00B7 ", _jsx("button", { className: "linkbtn small", onClick: () => { setQ(""); setAsset([]); setStatus(""); }, children: "Clear" })] })] }), _jsxs("span", { className: "row", style: { gap: 8 }, children: [selecting && items.length > 0 && _jsx(Checkbox, { checked: sel.length === items.length, indeterminate: sel.length > 0 && sel.length < items.length, onChange: (c) => setSel(c ? items.map((m) => m.id) : []), label: "All" }), can("meters.manage") && _jsxs(Button, { size: "sm", variant: selecting ? "primary" : "ghost", "aria-pressed": selecting, onClick: () => { setSelecting((s) => !s); setSel([]); }, children: [_jsx(CheckSquare, { size: 14 }), "Select"] })] })] })] }), _jsxs("div", { className: "list", role: "list", children: [list.isLoading ? _jsx(ListSkeleton, {}) : items.length === 0 ? (_jsx(EmptyState, { icon: _jsx(Gauge, { size: 26 }), title: filtered ? "No meters match" : "No meters yet", children: filtered ? "Try clearing the filters." : "Meters track run hours, miles, temperatures and other readings, and can create work automatically." })) : items.map((m) => _jsx(MeterRow, { m: m, active: m.id === id, selecting: selecting, selected: sel.includes(m.id), onSelect: (c) => setSel((s) => (c ? [...s, m.id] : s.filter((x) => x !== m.id))) }, m.id)), list.hasNextPage && _jsx("div", { style: { padding: 12, textAlign: "center" }, children: _jsx(Button, { size: "sm", onClick: () => list.fetchNextPage(), disabled: list.isFetchingNextPage, children: "Load more" }) })] }), sel.length > 0 && (_jsxs("div", { className: "bulkbar", role: "toolbar", "aria-label": "Bulk actions", children: [_jsxs("span", { className: "small", children: [_jsx("b", { children: sel.length }), " selected"] }), _jsxs(Button, { size: "sm", onClick: () => setBulk("edit"), children: [_jsx(Pencil, { size: 14 }), "Edit"] }), can("meters.delete") && _jsxs(Button, { size: "sm", onClick: () => setBulk("delete"), children: [_jsx(Trash2, { size: 14 }), "Delete"] }), _jsx("span", { className: "grow" }), _jsx(Button, { size: "sm", variant: "ghost", icon: true, "aria-label": "Clear selection", onClick: () => setSel([]), children: _jsx(X, { size: 14 }) })] }))] }), _jsx("div", { className: "split-detail", children: id ? _jsx(MeterDetail, { id: id }, id) : _jsx(EmptyState, { icon: _jsx(Gauge, { size: 28 }), title: "Select a meter", children: "Pick one from the list to see its readings, chart and automations." }) })] }), creating && _jsx(MeterForm, { onClose: () => setCreating(false), onSaved: (m) => { setCreating(false); nav(`/meters/${m.id}`); } }), points && _jsx(MonitoringPointsDialog, { onClose: () => setPoints(false) }), bulk === "edit" && _jsx(BulkMeterDialog, { ids: sel, onClose: () => setBulk(null), onDone: () => { setBulk(null); setSel([]); } }), bulk === "delete" && _jsx(Modal, { title: `Delete ${sel.length} meter${sel.length === 1 ? "" : "s"}?`, onClose: () => setBulk(null), footer: _jsxs(_Fragment, { children: [_jsx(Button, { onClick: () => setBulk(null), children: "Cancel" }), _jsx(Button, { variant: "danger", disabled: del.isPending, onClick: () => del.mutate(), children: "Delete" })] }), children: _jsx("p", { children: "Automations stop watching them. Readings are kept." }) })] }));
}
function MeterRow({ m, active, selecting, selected, onSelect }) {
    return (_jsxs(Link, { to: `/meters/${m.id}`, className: "list-row meter-row" + (active ? " active" : ""), role: "listitem", children: [selecting && _jsx("span", { onClick: (e) => e.stopPropagation(), children: _jsx(Checkbox, { checked: selected, onChange: onSelect, label: _jsxs("span", { className: "sr-only", children: ["Select ", m.name] }) }) }), _jsx("span", { className: "mrow-ic " + (m.level || "ok"), "aria-hidden": "true", children: _jsx(Gauge, { size: 16 }) }), _jsxs("div", { className: "grow", style: { minWidth: 0 }, children: [_jsx("div", { className: "t", children: m.name }), _jsx("div", { className: "s", children: [m.asset?.name, m.location?.name].filter(Boolean).join(" · ") || "No asset" })] }), _jsxs("div", { className: "mrow-side", children: [_jsx("span", { className: "tnum mrow-val", children: m.last_value === null ? _jsx("span", { className: "faint", children: "\u2014" }) : _jsxs(_Fragment, { children: [fmtNum(m.last_value), " ", _jsx("span", { className: "small muted", children: m.unit })] }) }), _jsxs("span", { className: "row", style: { gap: 4 }, children: [_jsx(LevelBadge, { level: m.level }), m.overdue ? _jsxs(Pill, { tone: "warning", children: [_jsx(Clock, { size: 11 }), "Overdue"] })
                                : m.next_reading_due ? _jsxs("span", { className: "small faint", title: "Next reading due", children: ["Next ", shortDate(m.next_reading_due)] })
                                    : m.last_reading_at ? _jsx("span", { className: "small faint", children: timeAgo(m.last_reading_at) }) : null] })] })] }));
}
