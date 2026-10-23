import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
// Asset and location pickers (single or multi) and a date input with a compact clear button.
import { useMemo } from "react";
import { Boxes, MapPin, X } from "lucide-react";
import { MultiPicker } from "./pickers";
import { useAssetList, useLocationList, pathLabel } from "../lib/assets";
const dot = (status) => _jsx("span", { className: "astat-dot " + status, "aria-hidden": "true" });
export function AssetPicker({ value, onChange, multi = false, disabled, id, placeholder = "Pick an asset", exclude = [] }) {
    const q = useAssetList();
    const opts = useMemo(() => (q.data?.items ?? []).filter((a) => !exclude.includes(a.id)).map((a) => ({
        key: a.id, label: a.name, sub: [a.path.length ? pathLabel(a.path.slice(-2), "").replace(/ › $/, "") : "", a.location?.name].filter(Boolean).join(" · ") || undefined,
        icon: dot(a.status),
    })), [q.data, exclude]);
    return _jsx(MultiPicker, { id: id, label: "Asset", single: !multi, placeholder: placeholder, options: opts, value: value, onChange: onChange, disabled: disabled, searchPlaceholder: "Search assets", renderValue: (sel) => _jsx("span", { className: "row", style: { gap: 4, flexWrap: "wrap" }, children: sel.map((s) => _jsxs("span", { className: "chip", children: [_jsx(Boxes, { size: 12 }), s.label] }, s.key)) }) });
}
export function LocationPicker({ value, onChange, disabled, id, placeholder = "Pick a location", exclude = [] }) {
    const q = useLocationList();
    const opts = useMemo(() => (q.data?.items ?? []).filter((l) => !exclude.includes(l.id)).map((l) => ({
        key: l.id, label: l.name, sub: l.path.length ? l.path.map((p) => p.name).join(" › ") : undefined, icon: _jsx(MapPin, { size: 14, className: "faint" }),
    })), [q.data, exclude]);
    return _jsx(MultiPicker, { id: id, label: "Location", single: true, placeholder: placeholder, options: opts, value: value ? [value] : [], onChange: (v) => onChange(v[0] ?? null), disabled: disabled, searchPlaceholder: "Search locations", renderValue: (sel) => _jsxs("span", { className: "chip", children: [_jsx(MapPin, { size: 12 }), sel[0].label] }) });
}
/** A date or datetime input with a small × to clear it (requested in the 0.2.0 review). */
export function ClearableDate({ value, onChange, label, ...rest }) {
    return (_jsxs("span", { className: "clearable" + (value && !rest.disabled ? " has-value" : ""), children: [_jsx("input", { ...rest, className: "input " + (rest.className ?? ""), value: value, onChange: (e) => onChange(e.target.value) }), value && !rest.disabled && (_jsx("button", { type: "button", className: "clear-x", "aria-label": `Clear ${label}`, title: `Clear ${label}`, onClick: () => onChange(""), children: _jsx(X, { size: 12 }) }))] }));
}
