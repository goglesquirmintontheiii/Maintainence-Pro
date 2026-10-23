import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
// One meter: latest reading, record a reading, chart, readings history and its automations.
import { useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, ArrowLeft, Boxes, Camera, ClipboardList, Copy, Gauge, MapPin, MoreHorizontal, Pencil, Plus, Printer, Trash2, X, Zap } from "lucide-react";
import { api, upload } from "../../lib/api";
import { useSession } from "../../lib/session";
import { dateTime, timeAgo } from "../../lib/format";
import { toLocalInput } from "../../lib/wo";
import { useToast } from "../../components/Toast";
import { Button, Dropdown, EmptyState, ListSkeleton, Modal, Pill } from "../../components/ui";
import { ClearableDate } from "../../components/assetPickers";
import { DropZone } from "../../components/DropZone";
import { LabelDialog } from "../../components/LabelDialog";
import { useFileViewer } from "../../components/FileViewer";
import { MeterChart, fmtNum } from "./MeterChart";
import "../../styles/automations.css";
import { CopyMeterDialog, MeterForm } from "./MeterForms";
const RANGES = [[7, "7 days"], [30, "30 days"], [90, "90 days"], [365, "1 yr"], [730, "2 yr"]];
const ymd = (d) => new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
const FREQ = { hour: "hour", day: "day", week: "week", month: "month", year: "year" };
function limitText(lo, hi, unit) {
    if (lo === null && hi === null)
        return "not set";
    if (lo === null)
        return `above ${fmtNum(hi)} ${unit}`;
    if (hi === null)
        return `below ${fmtNum(lo)} ${unit}`;
    return `below ${fmtNum(lo)} or above ${fmtNum(hi)} ${unit}`;
}
export function LevelBadge({ level }) {
    if (!level)
        return null;
    return _jsxs(Pill, { tone: level === "alarm" ? "danger" : "warning", children: [_jsx(AlertTriangle, { size: 12 }), level === "alarm" ? "Alarm" : "Warning"] });
}
export function MeterDetail({ id }) {
    const { can, session } = useSession();
    const tz = session.org?.timezone;
    const qc = useQueryClient();
    const nav = useNavigate();
    const { toast } = useToast();
    const q = useQuery({ queryKey: ["meter", id], queryFn: () => api(`/meters/${id}`) });
    const [days, setDays] = useState(30);
    // Custom range (MP-122): whole days in the person's time zone, end date included
    const [custom, setCustom] = useState(() => ({ from: ymd(new Date(Date.now() - 30 * 86400_000)), to: ymd(new Date()) }));
    const customOk = !!custom.from && !!custom.to && custom.from <= custom.to;
    const range = useMemo(() => {
        if (days === "custom") {
            const from = new Date(custom.from + "T00:00"), to = new Date(new Date(custom.to + "T00:00").getTime() + 86400_000);
            return customOk ? { from, to } : { from: new Date(Date.now() - 30 * 86400_000), to: new Date() };
        }
        const to = new Date(Date.now() + 60_000);
        return { to, from: new Date(to.getTime() - days * 86400_000) };
    }, [days, custom, customOk, q.dataUpdatedAt]);
    const span = days === "custom" ? `from=${encodeURIComponent(range.from.toISOString())}&to=${encodeURIComponent(range.to.toISOString())}` : `days=${days}`;
    const chart = useQuery({ queryKey: ["meter-chart", id, span, q.dataUpdatedAt], queryFn: () => api(`/meters/${id}/chart?${span}`), placeholderData: (p) => p, enabled: days !== "custom" || customOk });
    const readings = useQuery({ queryKey: ["meter-readings", id, span, q.dataUpdatedAt], queryFn: () => api(`/meters/${id}/readings?${span}&limit=200`), placeholderData: (p) => p, enabled: days !== "custom" || customOk });
    const [editing, setEditing] = useState(false);
    const [copying, setCopying] = useState(false);
    const [labels, setLabels] = useState(false);
    const [confirmDelete, setConfirmDelete] = useState(false);
    const refresh = () => { qc.invalidateQueries({ queryKey: ["meter", id] }); qc.invalidateQueries({ queryKey: ["meters"] }); };
    const del = useMutation({ mutationFn: () => api(`/meters/${id}`, { method: "DELETE" }),
        onSuccess: () => { qc.invalidateQueries({ queryKey: ["meters"] }); toast("Meter deleted"); nav("/meters"); }, onError: (e) => toast(e.message, { kind: "error" }) });
    const delReading = useMutation({ mutationFn: (rid) => api(`/meters/${id}/readings/${rid}`, { method: "DELETE" }),
        onSuccess: () => { refresh(); toast("Reading deleted"); }, onError: (e) => toast(e.message, { kind: "error" }) });
    if (q.isError)
        return _jsx(EmptyState, { icon: _jsx(Gauge, { size: 26 }), title: "Meter not found", children: "It may have been deleted, or you don't have access to it." });
    if (!q.data)
        return _jsx("div", { className: "detail", children: _jsx(ListSkeleton, { rows: 4 }) });
    const m = q.data;
    return (_jsxs("div", { className: "detail wo-detail meter-detail", children: [_jsxs(Link, { to: "/meters", className: "row small mobile-only", children: [_jsx(ArrowLeft, { size: 14 }), "All meters"] }), _jsxs("div", { className: "wo-head", children: [_jsxs("div", { className: "grow", children: [_jsxs("div", { className: "row small muted wrap", style: { gap: 8 }, children: [m.asset && _jsxs(Link, { to: `/assets/${m.asset.id}`, className: "row", style: { gap: 4 }, children: [_jsx(Boxes, { size: 13 }), m.asset.name] }), m.location && _jsxs(Link, { to: `/locations/${m.location.id}`, className: "row", style: { gap: 4 }, children: [_jsx(MapPin, { size: 13 }), m.location.name] }), m.monitoring_point && _jsxs("span", { children: ["\u00B7 ", m.monitoring_point.name] })] }), _jsx("h1", { className: "wo-title", children: m.name }), _jsxs("div", { className: "row wrap", style: { marginTop: 6 }, children: [_jsx(LevelBadge, { level: m.level }), m.overdue && _jsx(Pill, { tone: "warning", children: "Reading overdue" }), m.meter_type === "automated" && _jsx(Pill, { tone: "info", children: "Automated" })] })] }), _jsxs("div", { className: "row", children: [can("wo.create") && _jsxs(Button, { onClick: () => nav(`/work-orders?new=1${m.asset ? `&asset=${m.asset.id}` : ""}${m.location ? `&location=${m.location.id}` : ""}`), "aria-label": "New work order", title: "New work order for this meter's asset", children: [_jsx(ClipboardList, { size: 15 }), _jsx("span", { className: "desktop-only", children: "Work order" })] }), can("meters.manage") && _jsxs(Button, { onClick: () => setEditing(true), "aria-label": "Edit", children: [_jsx(Pencil, { size: 15 }), _jsx("span", { className: "desktop-only", children: "Edit" })] }), _jsx(Dropdown, { trigger: (_, t) => _jsx(Button, { icon: true, "aria-label": "More actions", onClick: t, children: _jsx(MoreHorizontal, { size: 18 }) }), width: 230, children: (close) => _jsxs(_Fragment, { children: [can("meters.manage") && _jsxs("button", { className: "menu-item", onClick: () => { close(); setCopying(true); }, children: [_jsx(Copy, { size: 15 }), "Copy meter\u2026"] }), _jsxs("button", { className: "menu-item", onClick: () => { close(); setLabels(true); }, children: [_jsx(Printer, { size: 15 }), "Print QR label\u2026"] }), can("meters.delete") && _jsxs(_Fragment, { children: [_jsx("div", { className: "menu-sep" }), _jsxs("button", { className: "menu-item", style: { color: "var(--c-danger)" }, onClick: () => { close(); setConfirmDelete(true); }, children: [_jsx(Trash2, { size: 15 }), "Delete"] })] })] }) })] })] }), can("meters.read") && _jsx(RecordReading, { meter: m, onSaved: refresh }), _jsxs("div", { className: "mstat-row", children: [_jsxs("div", { className: "card tile", children: [_jsx("div", { className: "k", children: "Last reading" }), _jsxs("div", { className: "v" + (m.level === "alarm" ? " danger" : m.level === "warning" ? " warning" : ""), children: [m.last_value === null ? "—" : fmtNum(m.last_value), " ", _jsx("span", { className: "unit", children: m.unit })] }), _jsx("div", { className: "small muted", children: m.last_reading_at ? _jsx("span", { title: dateTime(m.last_reading_at, tz), children: timeAgo(m.last_reading_at) }) : "No readings yet" })] }), _jsxs("div", { className: "card tile", children: [_jsx("div", { className: "k", children: "Next reading due" }), _jsx("div", { className: "v sm" + (m.overdue ? " warning" : ""), children: m.next_reading_due ? dateTime(m.next_reading_due, tz) : "No schedule" }), _jsx("div", { className: "small muted", children: m.reading_frequency === "none" ? "Readings whenever needed" : `Every ${m.frequency_interval > 1 ? m.frequency_interval + " " : ""}${FREQ[m.reading_frequency]}${m.frequency_interval > 1 ? "s" : ""}` })] }), _jsxs("div", { className: "card tile", children: [_jsx("div", { className: "k", children: "Limits" }), _jsxs("div", { className: "small mlims", children: [_jsxs("span", { children: ["Warning ", limitText(m.warning_low, m.warning_high, m.unit)] }), _jsxs("span", { children: ["Alarm ", limitText(m.alarm_low, m.alarm_high, m.unit)] })] })] })] }), _jsxs("section", { className: "card", children: [_jsxs("div", { className: "card-head", children: [_jsx("h2", { children: "Readings" }), _jsxs("div", { className: "seg range-seg", role: "radiogroup", "aria-label": "Range", children: [RANGES.map(([d, l]) => (_jsx("button", { type: "button", role: "radio", "aria-checked": days === d, className: "seg-btn" + (days === d ? " on" : ""), onClick: () => setDays(d), children: l }, d))), _jsx("button", { type: "button", role: "radio", "aria-checked": days === "custom", className: "seg-btn" + (days === "custom" ? " on" : ""), onClick: () => setDays("custom"), children: "Custom" })] })] }), days === "custom" && (_jsxs("div", { className: "card-body row wrap range-custom", children: [_jsxs("label", { className: "row small", children: ["From ", _jsx("input", { className: "input", type: "date", value: custom.from, max: custom.to || undefined, onChange: (e) => setCustom({ ...custom, from: e.target.value }) })] }), _jsxs("label", { className: "row small", children: ["To ", _jsx("input", { className: "input", type: "date", value: custom.to, min: custom.from || undefined, onChange: (e) => setCustom({ ...custom, to: e.target.value }) })] }), !customOk && _jsx("span", { className: "small", style: { color: "var(--c-danger)" }, children: "Pick a start date on or before the end date." })] })), _jsxs("div", { className: "card-body stack", children: [chart.data ? _jsx(MeterChart, { data: chart.data, from: range.from, to: range.to, tz: tz }) : _jsx(ListSkeleton, { rows: 3 }), _jsx(ReadingsTable, { items: readings.data?.items ?? [], unit: m.unit, tz: tz, canDelete: can("meters.manage"), onDelete: (rid) => delReading.mutate(rid) })] })] }), _jsxs("section", { className: "card", children: [_jsxs("div", { className: "card-head", children: [_jsx("h2", { children: "Automations for this meter" }), _jsxs("div", { className: "row", style: { gap: 6 }, children: [(m.automations?.length ?? 0) > 0 && _jsx(Link, { className: "small", to: `/automations?meter_id=${m.id}`, children: "See all" }), can("automations.manage") && _jsxs(Button, { size: "sm", onClick: () => nav(`/automations?new=1&meter=${m.id}`), children: [_jsx(Plus, { size: 14 }), "New automation"] })] })] }), !m.automations?.length ? _jsxs("div", { className: "card-body small faint", children: ["Create work orders, change the asset's status or send emails automatically when a reading crosses a value, or every so many ", m.unit, "."] }) : (_jsx("ul", { className: "auto-mini", children: m.automations.map((x) => (_jsxs("li", { children: [_jsxs(Link, { to: `/automations/${x.id}`, className: "row", style: { gap: 6 }, children: [_jsx(Zap, { size: 14, className: x.active ? "" : "faint" }), x.name] }), !x.active && _jsx(Pill, { children: "Off" })] }, x.id))) }))] }), m.description && _jsxs("section", { children: [_jsx("h3", { className: "sec-h", children: "Description" }), _jsx("p", { className: "prewrap", children: m.description })] }), editing && _jsx(MeterForm, { edit: m, onClose: () => setEditing(false), onSaved: () => setEditing(false) }), copying && _jsx(CopyMeterDialog, { meter: m, onClose: () => setCopying(false), onDone: (ids) => { setCopying(false); if (ids.length === 1)
                    nav(`/meters/${ids[0]}`); } }), labels && _jsx(LabelDialog, { entityType: "meter", ids: [m.id], onClose: () => setLabels(false) }), confirmDelete && _jsx(Modal, { title: "Delete meter?", onClose: () => setConfirmDelete(false), footer: _jsxs(_Fragment, { children: [_jsx(Button, { onClick: () => setConfirmDelete(false), children: "Cancel" }), _jsx(Button, { variant: "danger", onClick: () => del.mutate(), disabled: del.isPending, children: "Delete" })] }), children: _jsxs("p", { children: ["Automations stop watching \u201C", m.name, "\u201D. Its readings are kept."] }) })] }));
}
function RecordReading({ meter, onSaved }) {
    const { toast } = useToast();
    const [value, setValue] = useState("");
    const [when, setWhen] = useState("");
    const [note, setNote] = useState("");
    const [photo, setPhoto] = useState(null);
    const [busy, setBusy] = useState(false);
    const [err, setErr] = useState("");
    const fileIn = useRef(null);
    const save = useMutation({
        mutationFn: () => api(`/meters/${meter.id}/readings`, { method: "POST",
            body: { value: value.trim(), recorded_at: when ? new Date(when).toISOString() : undefined, note: note || undefined, file_id: photo?.id } }),
        onSuccess: (r) => {
            setValue("");
            setWhen("");
            setNote("");
            setPhoto(null);
            setErr("");
            onSaved();
            const lv = r.reading.level;
            toast(lv === "alarm" ? `Recorded. ${fmtNum(r.reading.value)} ${meter.unit} is past the alarm limit.` : lv === "warning" ? `Recorded. ${fmtNum(r.reading.value)} ${meter.unit} is past the warning limit.`
                : r.reading.anomaly ? "Recorded. This reading is unusual compared with recent ones." : "Reading recorded", { kind: lv === "alarm" ? "error" : "info" });
        },
        onError: (e) => setErr(e.message),
    });
    const pick = async (f) => {
        if (!f)
            return;
        setBusy(true);
        setErr("");
        try {
            setPhoto(await upload(f));
        }
        catch (e) {
            setErr(e.message);
        }
        finally {
            setBusy(false);
        }
    };
    return (_jsxs("form", { className: "card card-pad mread", onSubmit: (e) => { e.preventDefault(); if (value.trim())
            save.mutate(); }, "aria-label": "Record a reading", children: [_jsxs("div", { className: "mread-main", children: [_jsxs("label", { className: "mread-value", children: [_jsxs("span", { className: "sr-only", children: ["Reading in ", meter.unit] }), _jsx("input", { className: "input", inputMode: "decimal", type: "number", step: "any", placeholder: "New reading", value: value, onChange: (e) => setValue(e.target.value) }), _jsx("span", { className: "unit", children: meter.unit })] }), _jsx(Button, { type: "submit", variant: "primary", disabled: !value.trim() || save.isPending || busy, children: save.isPending ? "Saving…" : "Record" })] }), _jsxs(DropZone, { className: "mread-more", accept: "image/*", multiple: false, label: "Drop a photo of the meter", disabled: busy, onFiles: (fs) => void pick(fs[0]), children: [_jsx(ClearableDate, { type: "datetime-local", label: "time", "aria-label": "Reading time (leave empty for now)", value: when, max: toLocalInput(new Date().toISOString()), onChange: setWhen }), _jsx("input", { className: "input", placeholder: "Note (optional)", "aria-label": "Note", maxLength: 500, value: note, onChange: (e) => setNote(e.target.value) }), _jsx("input", { ref: fileIn, type: "file", accept: "image/*", capture: "environment", hidden: true, onChange: (e) => { void pick(e.target.files?.[0]); e.target.value = ""; } }), photo ? _jsxs("span", { className: "chip", children: [photo.thumb_url && _jsx("img", { src: photo.thumb_url, alt: "", className: "mread-thumb" }), photo.name, _jsx(Button, { variant: "ghost", size: "sm", icon: true, "aria-label": "Remove photo", onClick: () => setPhoto(null), children: _jsx(X, { size: 12 }) })] })
                        : _jsxs(Button, { onClick: () => fileIn.current?.click(), disabled: busy, children: [_jsx(Camera, { size: 15 }), busy ? "Uploading…" : "Photo"] })] }), !when && _jsx("div", { className: "small faint", children: "Leave the time empty to record it now." }), err && _jsx("div", { className: "small", role: "alert", style: { color: "var(--c-danger)" }, children: err })] }));
}
function ReadingsTable({ items, unit, tz, canDelete, onDelete }) {
    const photos = items.filter((r) => r.file_id && r.file_url)
        .map((r) => ({ id: r.file_id, name: `Reading ${fmtNum(r.value)} ${unit} · ${dateTime(r.recorded_at, tz)}`, url: `/api/v1/files/${r.file_id}`, thumb_url: r.file_url, is_image: true }));
    const [viewer, openPhoto] = useFileViewer(photos);
    if (!items.length)
        return null;
    return (_jsxs("div", { className: "table-wrap", children: [viewer, _jsxs("table", { className: "table mreadings", children: [_jsx("thead", { children: _jsxs("tr", { children: [_jsx("th", { children: "When" }), _jsx("th", { children: "Reading" }), _jsx("th", { className: "desktop-only", children: "By" }), _jsx("th", { children: "Note" }), _jsx("th", {})] }) }), _jsx("tbody", { children: items.map((r) => (_jsxs("tr", { children: [_jsx("td", { className: "small", title: dateTime(r.recorded_at, tz), children: dateTime(r.recorded_at, tz) }), _jsxs("td", { children: [_jsx("b", { className: "tnum", children: fmtNum(r.value) }), " ", _jsx("span", { className: "small muted", children: unit }), _jsxs("div", { className: "row", style: { gap: 4, marginTop: 2 }, children: [_jsx(LevelBadge, { level: r.level }), r.anomaly && _jsx(Pill, { tone: "info", children: "Unusual" }), r.source !== "manual" && _jsx("span", { className: "small faint", children: r.source === "api" ? "API" : "Work order" })] })] }), _jsx("td", { className: "small desktop-only", children: r.recorded_by ?? "—" }), _jsxs("td", { className: "small", children: [r.note, r.file_url && _jsx("button", { type: "button", className: "linkbtn", "aria-label": "View reading photo", onClick: () => openPhoto(photos.findIndex((p) => p.id === r.file_id)), children: _jsx("img", { src: r.file_url, alt: "Reading photo", className: "mread-thumb" }) }), r.work_order_id && _jsx("div", { children: _jsx(Link, { to: `/work-orders/${r.work_order_id}`, children: "Work order" }) })] }), _jsx("td", { style: { textAlign: "right" }, children: canDelete && _jsx(Button, { size: "sm", variant: "ghost", icon: true, "aria-label": "Delete reading", onClick: () => onDelete(r.id), children: _jsx(Trash2, { size: 14 }) }) })] }, r.id))) })] })] }));
}
