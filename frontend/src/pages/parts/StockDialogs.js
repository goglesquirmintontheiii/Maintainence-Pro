import { jsxs as _jsxs, jsx as _jsx, Fragment as _Fragment } from "react/jsx-runtime";
// Restock, adjust, move between locations, and a stocking location's area/min/max. Every change goes through the ledger.
import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { api } from "../../lib/api";
import { useSession } from "../../lib/session";
import { useToast } from "../../components/Toast";
import { Button, Field, Input, Modal, Select } from "../../components/ui";
import { LocationPicker } from "../../components/assetPickers";
import { qty } from "./types";
const locKey = (s) => s.location?.id ?? "none";
const locId = (k) => (k === "none" ? null : k);
function LocationSelect({ p, value, onChange, label = "Location", exclude }) {
    return (_jsx(Field, { label: label, children: (id) => _jsx(Select, { id: id, value: value, onChange: (e) => onChange(e.target.value), children: p.stock.filter((s) => locKey(s) !== exclude).map((s) => _jsxs("option", { value: locKey(s), children: [s.location?.name ?? "No location", s.area ? ` · ${s.area}` : "", " (", qty(s.on_hand, p.unit), ")"] }, s.id)) }) }));
}
function useStockAction(path, done, onDone, onClose) {
    const { toast } = useToast();
    const [err, setErr] = useState("");
    const m = useMutation({
        mutationFn: (body) => api(path, { method: "POST", body }),
        onSuccess: () => { toast(done); onDone(); onClose(); },
        onError: (e) => setErr(e.message),
    });
    return { m, err };
}
export function RestockDialog({ p, stock, onClose, onDone }) {
    const { can } = useSession();
    const [loc, setLoc] = useState(stock ? locKey(stock) : p.stock[0] ? locKey(p.stock[0]) : "none");
    const [newLoc, setNewLoc] = useState(null);
    const cur = p.stock.find((s) => locKey(s) === loc);
    const [n, setN] = useState(cur?.restock_quantity && cur.restock_quantity !== "0" ? cur.restock_quantity : "");
    const [cost, setCost] = useState(p.unit_cost ?? "");
    const [note, setNote] = useState("");
    const { m, err } = useStockAction(`/parts/${p.id}/restock`, "Restocked", onDone, onClose);
    const target = p.stock.length ? locId(loc) : newLoc;
    return (_jsxs(Modal, { title: `Restock ${p.name}`, onClose: onClose, footer: _jsxs(_Fragment, { children: [_jsx(Button, { onClick: onClose, children: "Cancel" }), _jsx(Button, { variant: "primary", disabled: !n || m.isPending, onClick: () => m.mutate({ location_id: target, quantity: n, unit_cost: can("costs.view") && cost !== "" ? cost : undefined, note }), children: "Restock" })] }), children: [p.stock.length ? _jsx(LocationSelect, { p: p, value: loc, onChange: setLoc })
                : _jsx(Field, { label: "Location", children: () => _jsx(LocationPicker, { value: newLoc, onChange: setNewLoc, placeholder: "No location" }) }), _jsxs("div", { className: "part-grid2", children: [_jsx(Field, { label: `Quantity added${p.unit !== "each" ? ` (${p.unit})` : ""}`, children: (id) => _jsx(Input, { id: id, autoFocus: true, inputMode: "decimal", value: n, onChange: (e) => setN(e.target.value) }) }), can("costs.view") && _jsx(Field, { label: "Unit cost", children: (id) => _jsx(Input, { id: id, inputMode: "decimal", value: cost, onChange: (e) => setCost(e.target.value) }) })] }), _jsx(Field, { label: "Note", children: (id) => _jsx(Input, { id: id, value: note, maxLength: 500, onChange: (e) => setNote(e.target.value), placeholder: "Where it came from (optional)" }) }), err && _jsx("div", { className: "banner warning", role: "alert", children: err })] }));
}
export function AdjustDialog({ p, stock, onClose, onDone }) {
    const [loc, setLoc] = useState(stock ? locKey(stock) : p.stock[0] ? locKey(p.stock[0]) : "none");
    const cur = p.stock.find((s) => locKey(s) === loc);
    const [n, setN] = useState(cur?.on_hand ?? "");
    const [note, setNote] = useState("");
    const { m, err } = useStockAction(`/parts/${p.id}/adjust`, "Quantity updated", onDone, onClose);
    const change = cur && n !== "" ? Number(n) - Number(cur.on_hand) : 0;
    return (_jsxs(Modal, { title: `Adjust ${p.name}`, onClose: onClose, footer: _jsxs(_Fragment, { children: [_jsx(Button, { onClick: onClose, children: "Cancel" }), _jsx(Button, { variant: "primary", disabled: n === "" || !change || (change < 0 && !note.trim()) || m.isPending, onClick: () => m.mutate({ location_id: locId(loc), quantity: n, note }), children: "Save" })] }), children: [p.stock.length === 0 ? _jsx("p", { className: "small muted", children: "Add a stocking location first." }) : _jsxs(_Fragment, { children: [_jsx(LocationSelect, { p: p, value: loc, onChange: (v) => { setLoc(v); setN(p.stock.find((s) => locKey(s) === v)?.on_hand ?? ""); } }), _jsx(Field, { label: "Quantity in stock", hint: change ? `${change > 0 ? "+" : ""}${Number(change.toFixed(4))} ${p.unit}` : "Enter what's really on the shelf.", children: (id) => _jsx(Input, { id: id, autoFocus: true, inputMode: "decimal", value: n, onChange: (e) => setN(e.target.value) }) }), _jsx(Field, { label: change < 0 ? "Reason (needed when removing)" : "Reason", children: (id) => _jsx(Input, { id: id, value: note, maxLength: 500, onChange: (e) => setNote(e.target.value), placeholder: "e.g. Damaged, found extra, recount" }) })] }), err && _jsx("div", { className: "banner warning", role: "alert", children: err })] }));
}
export function TransferDialog({ p, stock, onClose, onDone }) {
    const [from, setFrom] = useState(stock ? locKey(stock) : p.stock[0] ? locKey(p.stock[0]) : "none");
    const [to, setTo] = useState(p.stock.find((s) => locKey(s) !== from)?.location?.id ?? null);
    const [n, setN] = useState("");
    const [note, setNote] = useState("");
    const { m, err } = useStockAction(`/parts/${p.id}/transfer`, "Moved", onDone, onClose);
    return (_jsxs(Modal, { title: `Move ${p.name}`, onClose: onClose, footer: _jsxs(_Fragment, { children: [_jsx(Button, { onClick: onClose, children: "Cancel" }), _jsx(Button, { variant: "primary", disabled: !n || (to ?? "none") === from || m.isPending, onClick: () => m.mutate({ from_location_id: locId(from), to_location_id: to, quantity: n, note }), children: "Move" })] }), children: [_jsx(LocationSelect, { p: p, value: from, onChange: setFrom, label: "From" }), _jsx(Field, { label: "To", hint: "A new location starts with no minimum or maximum.", children: () => _jsx(LocationPicker, { value: to, onChange: setTo, placeholder: "No location" }) }), _jsx(Field, { label: "Quantity", children: (id) => _jsx(Input, { id: id, autoFocus: true, inputMode: "decimal", value: n, onChange: (e) => setN(e.target.value) }) }), _jsx(Field, { label: "Note", children: (id) => _jsx(Input, { id: id, value: note, maxLength: 500, onChange: (e) => setNote(e.target.value) }) }), err && _jsx("div", { className: "banner warning", role: "alert", children: err })] }));
}
export function LocationDialog({ p, stock, onClose, onDone }) {
    const { can } = useSession();
    const { toast } = useToast();
    const [loc, setLoc] = useState(stock?.location?.id ?? null);
    const [area, setArea] = useState(stock?.area ?? "");
    const [min, setMin] = useState(stock?.min_qty ?? "");
    const [max, setMax] = useState(stock?.max_qty ?? "");
    const [initial, setInitial] = useState("");
    const [err, setErr] = useState("");
    const save = useMutation({
        mutationFn: () => api(`/parts/${p.id}/stock`, { method: "PUT", body: { location_id: loc, area, min_qty: min || null, max_qty: max || null, initial_quantity: stock ? undefined : initial || undefined } }),
        onSuccess: () => { toast("Saved"); onDone(); onClose(); },
        onError: (e) => setErr(e.message),
    });
    const remove = useMutation({
        mutationFn: () => api(`/parts/${p.id}/stock?location_id=${stock?.location?.id ?? "none"}`, { method: "DELETE" }),
        onSuccess: () => { toast("Location removed"); onDone(); onClose(); },
        onError: (e) => setErr(e.message),
    });
    return (_jsxs(Modal, { title: stock ? `${stock.location?.name ?? "No location"}` : "Add a stocking location", onClose: onClose, footer: _jsxs(_Fragment, { children: [stock && _jsx(Button, { variant: "danger", disabled: remove.isPending, onClick: () => remove.mutate(), style: { marginRight: "auto" }, children: "Remove" }), _jsx(Button, { onClick: onClose, children: "Cancel" }), _jsx(Button, { variant: "primary", disabled: save.isPending, onClick: () => save.mutate(), children: "Save" })] }), children: [!stock && _jsx(Field, { label: "Location", children: () => _jsx(LocationPicker, { value: loc, onChange: setLoc, placeholder: "No location" }) }), _jsx(Field, { label: "Area or bin", children: (id) => _jsx(Input, { id: id, value: area, maxLength: 120, onChange: (e) => setArea(e.target.value), placeholder: "e.g. Aisle 3 / Bin 12" }) }), _jsxs("div", { className: "part-grid2", children: [_jsx(Field, { label: "Minimum", hint: "Below this, the part needs restocking.", children: (id) => _jsx(Input, { id: id, inputMode: "decimal", value: min, onChange: (e) => setMin(e.target.value) }) }), _jsx(Field, { label: "Maximum", hint: "Orders fill up to this.", children: (id) => _jsx(Input, { id: id, inputMode: "decimal", value: max, onChange: (e) => setMax(e.target.value) }) })] }), !stock && can("parts.stock") && _jsx(Field, { label: "Quantity in stock now", children: (id) => _jsx(Input, { id: id, inputMode: "decimal", value: initial, onChange: (e) => setInitial(e.target.value) }) }), stock && _jsx("p", { className: "small faint", children: "A location can only be removed when nothing is in stock or reserved there." }), err && _jsx("div", { className: "banner warning", role: "alert", children: err })] }));
}
