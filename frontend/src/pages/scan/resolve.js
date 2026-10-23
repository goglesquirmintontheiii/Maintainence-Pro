import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
// What a scanned value points at, and what to do when it isn't assigned yet. Shared by /scan and /q/:code.
import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useMutation, useQuery } from "@tanstack/react-query";
import { AlertTriangle, Boxes, Gauge, MapPin, QrCode, Search } from "lucide-react";
import { api } from "../../lib/api";
import { useSession } from "../../lib/session";
import { Button, Field, Select } from "../../components/ui";
import { AssetPicker, LocationPicker } from "../../components/assetPickers";
export const resolveScan = (value) => api(`/scan?value=${encodeURIComponent(value)}`);
const ICON = { asset: Boxes, location: MapPin, meter: Gauge };
export function ScanOutcome({ result, onAgain, againLabel = "Scan again" }) {
    const nav = useNavigate();
    const { can } = useSession();
    const again = onAgain && _jsx(Button, { onClick: onAgain, children: againLabel });
    if (result.status === "found")
        return null; // the caller navigates
    if (result.status === "several")
        return (_jsxs("div", { className: "scan-out card card-pad stack", children: [_jsx("h2", { className: "sec-h", children: "Several records match" }), _jsx("div", { className: "list", children: result.results.map((r) => {
                        const Icon = ICON[r.entity_type] ?? Boxes;
                        return (_jsxs("div", { className: "list-row", children: [_jsx(Icon, { size: 16, className: "faint" }), _jsx(Link, { to: r.url, className: "grow t", children: r.label }), r.entity_type === "asset" && can("wo.create") && _jsx(Link, { className: "btn sm", to: `/work-orders?new=1&asset=${r.entity_id}`, children: "New work order" })] }, r.entity_id));
                    }) }), _jsx("div", { className: "row", children: again })] }));
    if (result.status === "unassigned")
        return _jsx(AssignCode, { code: result.code, onDone: (url) => nav(url), again: again });
    const searchTerm = result.status === "unknown" ? result.value : result.code.value;
    return (_jsxs("div", { className: "scan-out card card-pad stack", role: "alert", children: [_jsxs("div", { className: "row", style: { gap: 8 }, children: [_jsx(AlertTriangle, { size: 18, color: "var(--c-warning)" }), _jsx("h2", { className: "sec-h", style: { margin: 0 }, children: result.status === "retired" ? "This label was retired" : "Nothing matches this code" })] }), _jsx("p", { className: "muted", style: { margin: 0 }, children: result.status === "retired"
                    ? "Someone replaced or removed this QR code. Print a new label from the record, or search for it."
                    : _jsxs(_Fragment, { children: ["We couldn't find a record for ", _jsx("span", { className: "mono", children: searchTerm.length > 80 ? searchTerm.slice(0, 80) + "…" : searchTerm }), ". It may belong to another organization, or not be linked yet."] }) }), _jsxs("div", { className: "row wrap", children: [_jsxs(Button, { variant: "primary", onClick: () => nav(`/assets?q=${encodeURIComponent(searchTerm.slice(0, 100))}`), children: [_jsx(Search, { size: 15 }), "Search instead"] }), again] })] }));
}
function AssignCode({ code, onDone, again }) {
    const { can } = useSession();
    const [type, setType] = useState("asset");
    const [target, setTarget] = useState(null);
    const [err, setErr] = useState("");
    const meters = useQuery({ queryKey: ["meter-pick"], queryFn: () => api("/meters?per_page=500"), enabled: type === "meter" && can("meters.view") });
    const m = useMutation({
        mutationFn: () => api(`/qr-codes/${code.id}/assign`, { method: "POST", body: { entity_type: type, entity_id: target } }),
        onSuccess: (c) => onDone(c.target?.url ?? (type === "asset" ? `/assets/${target}` : type === "location" ? `/locations/${target}` : `/meters/${target}`)),
        onError: (e) => setErr(e.message),
    });
    return (_jsxs("div", { className: "scan-out card card-pad stack", children: [_jsxs("div", { className: "row", style: { gap: 8 }, children: [_jsx(QrCode, { size: 18 }), _jsx("h2", { className: "sec-h", style: { margin: 0 }, children: "This QR code isn't assigned yet" })] }), _jsxs("p", { className: "muted", style: { margin: 0 }, children: ["Code ", _jsx("span", { className: "mono", children: code.value }), code.note && _jsxs(_Fragment, { children: [" \u00B7 ", code.note] }), ".", " ", can("qr.manage") ? "Stick it on a piece of equipment, then pick what it belongs to." : "Ask an administrator or technician to assign it."] }), can("qr.manage") && _jsxs(_Fragment, { children: [_jsx(Field, { label: "Assign to", children: (id) => _jsxs(Select, { id: id, value: type, onChange: (e) => { setType(e.target.value); setTarget(null); }, children: [_jsx("option", { value: "asset", children: "An asset" }), _jsx("option", { value: "location", children: "A location" }), _jsx("option", { value: "meter", children: "A meter" })] }) }), type === "asset" && _jsx(AssetPicker, { value: target ? [target] : [], onChange: (v) => setTarget(v[0] ?? null) }), type === "location" && _jsx(LocationPicker, { value: target, onChange: setTarget }), type === "meter" && _jsxs(Select, { "aria-label": "Meter", value: target ?? "", onChange: (e) => setTarget(e.target.value || null), children: [_jsx("option", { value: "", children: "Pick a meter" }), (meters.data?.items ?? []).map((x) => _jsxs("option", { value: x.id, children: [x.name, x.asset ? ` (${x.asset.name})` : ""] }, x.id))] }), err && _jsx("div", { className: "small", role: "alert", style: { color: "var(--c-danger)" }, children: err })] }), _jsxs("div", { className: "row wrap", children: [can("qr.manage") && _jsx(Button, { variant: "primary", disabled: !target || m.isPending, onClick: () => m.mutate(), children: "Assign code" }), again] })] }));
}
