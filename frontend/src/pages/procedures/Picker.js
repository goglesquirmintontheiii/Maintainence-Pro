import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
// Pick published procedures (work order form and work order templates).
import { ClipboardCheck } from "lucide-react";
import { MultiPicker } from "../../components/pickers";
import { useLibrary } from "./types";
export function ProcedurePicker({ value, onChange, id, disabled }) {
    const lib = useLibrary(true);
    const opts = (lib.data?.items ?? []).map((p) => ({ key: p.id, label: p.name, sub: `${p.field_count} fields${p.category ? ` · ${p.category}` : ""}`, icon: _jsx(ClipboardCheck, { size: 14, className: "faint" }) }));
    return _jsx(MultiPicker, { id: id, label: "Procedures", placeholder: "Add procedures", options: opts, value: value, onChange: onChange, disabled: disabled, searchPlaceholder: "Search procedures", renderValue: (sel) => _jsx("span", { className: "row", style: { gap: 4, flexWrap: "wrap" }, children: sel.map((s) => _jsxs("span", { className: "chip", children: [s.icon, s.label] }, s.key)) }) });
}
