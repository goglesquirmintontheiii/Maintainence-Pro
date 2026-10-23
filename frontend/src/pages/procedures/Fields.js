import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
// One procedure field as the technician sees it (runner on the work order and the builder's live preview).
// `onSave(body)` sends the answer; the preview passes a local handler so nothing is saved.
import { useEffect, useRef, useState } from "react";
import { Camera, Check, ExternalLink, FileText, Flag, Gauge, Link2, LocateFixed, MapPin, MessageSquare, Paperclip, Users, X } from "lucide-react";
import { upload } from "../../lib/api";
import { dateTime } from "../../lib/format";
import { useWOOptions } from "../../lib/wo";
import { SignaturePad } from "../../components/pickers";
import { Button, Input } from "../../components/ui";
import { DropZone } from "../../components/DropZone";
import { FIELD_LABEL, RESULT_LABEL } from "./types";
const NOTE_TYPES = ["checkbox", "number", "amount", "multiple_choice", "checklist", "inspection", "yes_no_na", "date"];
export function FieldRow({ item, answer, disabled, preview, tz, refs, onSave }) {
    const v = answer?.value;
    const [noteOpen, setNoteOpen] = useState(!!answer?.note);
    const answered = !!answer && (answer.skipped || (v !== null && v !== undefined && v !== "" && v !== false && !(Array.isArray(v) && v.length === 0)));
    const save = (body) => onSave(body);
    const withValue = (extra) => save({ value: item.type === "meter_reading" && v && typeof v === "object" ? { value: v.value } : v, ...extra });
    return (_jsxs("div", { className: "pr-field" + (answered ? " answered" : "") + (answer?.result ? " r-" + answer.result : ""), "data-type": item.type, id: `pf-${item.id}`, children: [(item.type !== "checkbox" || item.description || item.link || item.reference_file_ids?.length || item.assignees?.length) && _jsxs("div", { className: "pr-field-head", children: [_jsxs("div", { className: "grow", style: { minWidth: 0 }, children: [_jsxs("div", { className: "pr-label", children: [item.type !== "checkbox" && item.label, item.required && item.type !== "checkbox" && _jsx("span", { className: "pr-req", "aria-label": "required", children: "*" })] }), item.description && _jsx("div", { className: "small muted prewrap", children: item.description }), _jsx(FieldExtras, { item: item, refs: refs })] }), answer?.result && ["pass", "flag", "fail"].includes(answer.result) && _jsx("span", { className: "pr-result " + answer.result, children: RESULT_LABEL[answer.result] })] }), _jsx(FieldInput, { item: item, answer: answer, disabled: disabled, preview: preview, onSave: save }), (answer?.note || noteOpen) && NOTE_TYPES.includes(item.type) && (_jsx(NoteBox, { note: answer?.note ?? "", disabled: disabled, onSave: (note) => withValue({ note }) })), !!answer?.files.length && item.type !== "file" && _jsx(Thumbs, { files: answer.files }), (answer?.answered_by || (!disabled && !preview && answered && NOTE_TYPES.includes(item.type))) && _jsxs("div", { className: "pr-field-foot", children: [answer?.answered_by && _jsxs("span", { className: "small faint", children: [answer.skipped ? "Skipped" : "Answered", " by ", answer.answered_by, answer.answered_at ? ` · ${dateTime(answer.answered_at, tz)}` : ""] }), _jsx("span", { className: "grow" }), !disabled && !preview && answered && NOTE_TYPES.includes(item.type) && !noteOpen && !answer?.note &&
                        _jsxs("button", { type: "button", className: "linkbtn small", onClick: () => setNoteOpen(true), children: [_jsx(MessageSquare, { size: 13 }), "Add note"] }), !disabled && !preview && answered && item.type === "inspection" && _jsx(PhotoButton, { label: "Add photo", onUploaded: (f) => withValue({ file_ids: [...(answer?.files ?? []).map((x) => x.id), f.id] }) })] })] }));
}
function FieldExtras({ item, refs }) {
    const opts = useWOOptions();
    const names = (item.assignees ?? []).map((a) => {
        const [kind, id] = a.split(":");
        return kind === "user" ? opts.data?.people.find((p) => p.id === id)?.name : opts.data?.teams.find((t) => t.id === id)?.name;
    }).filter(Boolean);
    const files = (item.reference_file_ids ?? []).map((id) => refs?.[id]).filter(Boolean);
    if (!item.link && !files.length && !names.length)
        return null;
    return (_jsxs("div", { className: "pr-extras", children: [names.length > 0 && _jsxs("span", { className: "chip", children: [_jsx(Users, { size: 12 }), "Assigned to ", names.join(", ")] }), item.link && _jsxs("a", { className: "chip", href: item.link, target: "_blank", rel: "noopener noreferrer", children: [_jsx(Link2, { size: 12 }), shortUrl(item.link), _jsx(ExternalLink, { size: 11 })] }), files.map((f) => _jsxs("a", { className: "chip", href: f.url, target: "_blank", rel: "noopener noreferrer", children: [_jsx(FileText, { size: 12 }), f.name] }, f.id))] }));
}
const shortUrl = (u) => { try {
    return new URL(u).hostname.replace(/^www\./, "");
}
catch {
    return u;
} };
function NoteBox({ note, disabled, onSave }) {
    const [t, setT] = useState(note);
    useEffect(() => setT(note), [note]);
    return _jsx("textarea", { className: "textarea pr-note", rows: 2, placeholder: "Add a note", "aria-label": "Note", value: t, disabled: disabled, onChange: (e) => setT(e.target.value), onBlur: () => { if (t !== note)
            onSave(t); } });
}
function Thumbs({ files }) {
    return _jsx("div", { className: "pr-thumbs", children: files.map((f) => f.thumb_url
            ? _jsx("a", { href: f.url, target: "_blank", rel: "noopener noreferrer", children: _jsx("img", { src: f.thumb_url, alt: f.name }) }, f.id)
            : _jsxs("a", { href: f.url, target: "_blank", rel: "noopener noreferrer", className: "chip", children: [_jsx(Paperclip, { size: 12 }), f.name] }, f.id)) });
}
function PhotoButton({ label, onUploaded, accept = "image/*" }) {
    const ref = useRef(null);
    const [busy, setBusy] = useState(false);
    const [err, setErr] = useState("");
    const go = async (f) => {
        if (!f)
            return;
        setBusy(true);
        setErr("");
        try {
            onUploaded(await upload(f));
        }
        catch (x) {
            setErr(x.message);
        }
        finally {
            setBusy(false);
        }
    };
    return _jsxs(DropZone, { className: "row-inline", multiple: false, accept: accept, disabled: busy, label: "Drop to add", onFiles: (fs) => void go(fs[0]), children: [_jsx("input", { ref: ref, type: "file", accept: accept, hidden: true, multiple: false, onChange: (e) => { const f = e.target.files?.[0]; e.target.value = ""; void go(f); } }), _jsxs("button", { type: "button", className: "linkbtn small", disabled: busy, onClick: () => ref.current?.click(), children: [_jsx(Camera, { size: 13 }), busy ? "Uploading…" : label] }), err && _jsx("span", { className: "small", style: { color: "var(--c-danger)" }, children: err })] });
}
function Choice({ options, value, onPick, disabled, tone }) {
    return (_jsx("div", { className: "pr-choices" + (tone ? " tone" : ""), role: "radiogroup", children: options.map((o) => (_jsxs("button", { type: "button", role: "radio", "aria-checked": value === o.key, disabled: disabled, className: "pr-choice " + o.key + (value === o.key ? " on" : ""), onClick: () => onPick(o.key), children: [o.icon, o.label] }, o.key))) }));
}
function BlurInput({ value, onCommit, type = "text", disabled, unit, ...rest }) {
    const [t, setT] = useState(value);
    useEffect(() => setT(value), [value]);
    const commit = () => { if (t !== value)
        onCommit(t); };
    return _jsxs("div", { className: "pr-num", children: [_jsx(Input, { type: type, value: t, disabled: disabled, onChange: (e) => setT(e.target.value), onBlur: commit, onKeyDown: (e) => { if (e.key === "Enter" && type !== "textarea")
                    e.target.blur(); }, ...rest }), unit && _jsx("span", { className: "muted small", children: unit })] });
}
export function FieldInput({ item, answer, disabled, preview, onSave }) {
    const v = answer?.value;
    const t = item.type;
    if (t === "checkbox")
        return (_jsxs("label", { className: "pr-check" + (v === true ? " on" : ""), children: [_jsx("input", { type: "checkbox", checked: v === true, disabled: disabled, onChange: (e) => onSave({ value: e.target.checked }) }), _jsxs("span", { children: [item.label, item.required && _jsx("span", { className: "pr-req", "aria-label": "required", children: "*" })] })] }));
    if (t === "text")
        return _jsx(TextAnswer, { value: typeof v === "string" ? v : "", disabled: disabled, label: item.label, onCommit: (s) => onSave({ value: s }) });
    if (t === "number" || t === "amount")
        return (_jsx(BlurInput, { type: "number", step: "any", "aria-label": item.label, value: v === null || v === undefined ? "" : String(v), disabled: disabled, unit: t === "amount" ? item.unit || "$" : item.unit, min: item.min, max: item.max, onCommit: (s) => onSave({ value: s === "" ? null : Number(s) }) }));
    if (t === "inspection")
        return _jsx(Choice, { tone: true, disabled: disabled, value: v, onPick: (k) => onSave({ value: v === k ? null : k }), options: [{ key: "pass", label: "Pass", icon: _jsx(Check, { size: 16 }) }, { key: "flag", label: "Flag", icon: _jsx(Flag, { size: 15 }) }, { key: "fail", label: "Fail", icon: _jsx(X, { size: 16 }) }] });
    if (t === "yes_no_na")
        return _jsx(Choice, { disabled: disabled, value: v, onPick: (k) => onSave({ value: v === k ? null : k }), options: [{ key: "yes", label: "Yes" }, { key: "no", label: "No" }, { key: "na", label: "N/A" }] });
    if (t === "multiple_choice")
        return _jsx(Choice, { disabled: disabled, value: v, onPick: (k) => onSave({ value: v === k ? null : k }), options: (item.options ?? []).map((o) => ({ key: o, label: o })) });
    if (t === "checklist") {
        const sel = Array.isArray(v) ? v : [];
        return _jsx("div", { className: "pr-checklist", children: (item.options ?? []).map((o) => (_jsxs("label", { className: "pr-check" + (sel.includes(o) ? " on" : ""), children: [_jsx("input", { type: "checkbox", disabled: disabled, checked: sel.includes(o), onChange: (e) => onSave({ value: e.target.checked ? [...sel, o] : sel.filter((x) => x !== o) }) }), _jsx("span", { children: o })] }, o))) });
    }
    if (t === "date")
        return _jsx(BlurInput, { type: item.with_time ? "datetime-local" : "date", "aria-label": item.label, disabled: disabled, value: typeof v === "string" ? (item.with_time ? v.slice(0, 16) : v.slice(0, 10)) : "", onCommit: (s) => onSave({ value: s || null }) });
    if (t === "file") {
        const files = answer?.files ?? [];
        return _jsxs("div", { className: "stack", style: { gap: 6 }, children: [files.length > 0 && _jsx("div", { className: "pr-thumbs", children: files.map((f) => (_jsxs("span", { className: "pr-thumb", children: [f.thumb_url ? _jsx("a", { href: f.url, target: "_blank", rel: "noopener noreferrer", children: _jsx("img", { src: f.thumb_url, alt: f.name }) })
                                : _jsxs("a", { href: f.url, target: "_blank", rel: "noopener noreferrer", className: "chip", children: [_jsx(Paperclip, { size: 12 }), f.name] }), !disabled && _jsx("button", { type: "button", className: "pr-thumb-x", "aria-label": `Remove ${f.name}`, onClick: () => onSave({ file_ids: files.filter((x) => x.id !== f.id).map((x) => x.id) }), children: _jsx(X, { size: 12 }) })] }, f.id))) }), !disabled && !preview ? _jsx("div", { children: _jsx(PhotoButton, { label: "Add pictures or files", accept: "image/*,application/pdf,.doc,.docx,.xls,.xlsx,.csv,.txt", onUploaded: (f) => onSave({ file_ids: [...files.map((x) => x.id), f.id] }) }) })
                    : !files.length && _jsxs("div", { className: "pr-placeholder", children: [_jsx(Camera, { size: 16 }), "Pictures and files"] })] });
    }
    if (t === "signature")
        return _jsx(SignatureAnswer, { value: v, disabled: disabled, preview: preview, onSave: onSave });
    if (t === "meter_reading") {
        const mv = v;
        return _jsxs("div", { className: "row wrap", style: { gap: 8 }, children: [_jsx(Gauge, { size: 16, className: "faint" }), _jsx(BlurInput, { type: "number", step: "any", "aria-label": item.label, disabled: disabled || (!item.meter_id && !preview), value: mv ? String(mv.value) : "", unit: mv?.unit, onCommit: (s) => onSave({ value: s === "" ? null : { value: Number(s) } }) }), mv?.level && mv.level !== "normal" && _jsx("span", { className: "pr-result " + (mv.level === "alarm" ? "fail" : "flag"), children: mv.level === "alarm" ? "Alarm" : "Warning" }), !item.meter_id && !preview && _jsx("span", { className: "small faint", children: "No meter picked in the procedure" })] });
    }
    if (t === "location_check_in")
        return _jsx(CheckIn, { item: item, answer: answer, disabled: disabled, preview: preview, onSave: onSave });
    return _jsx("div", { className: "small faint", children: FIELD_LABEL[t] });
}
function TextAnswer({ value, disabled, label, onCommit }) {
    const [t, setT] = useState(value);
    useEffect(() => setT(value), [value]);
    return _jsx("textarea", { className: "textarea", rows: 2, "aria-label": label, value: t, disabled: disabled, placeholder: "Type your answer", onChange: (e) => setT(e.target.value), onBlur: () => { if (t !== value)
            onCommit(t); } });
}
function SignatureAnswer({ value, disabled, preview, onSave }) {
    const [redo, setRedo] = useState(false);
    const [data, setData] = useState(null);
    const [name, setName] = useState("");
    if (value && !redo)
        return (_jsxs("div", { className: "row wrap", style: { alignItems: "flex-end", gap: 12 }, children: [_jsx("img", { src: `/api/v1/files/${value.file_id}`, alt: `Signature of ${value.name}`, className: "sig-img" }), _jsxs("div", { className: "small muted", children: ["Signed by ", _jsx("b", { children: value.name }), _jsx("br", {}), dateTime(value.signed_at)] }), !disabled && _jsx("button", { type: "button", className: "linkbtn small", onClick: () => setRedo(true), children: "Sign again" })] }));
    if (disabled)
        return _jsx("div", { className: "pr-placeholder", children: "Not signed" });
    return (_jsxs("div", { className: "stack", style: { gap: 6 }, children: [_jsx(SignaturePad, { onChange: setData }), _jsxs("div", { className: "row wrap", style: { gap: 6 }, children: [_jsx(Input, { placeholder: "Name (optional)", "aria-label": "Signed by", value: name, onChange: (e) => setName(e.target.value), style: { maxWidth: 240 } }), _jsx(Button, { size: "sm", variant: "primary", disabled: !data || preview, onClick: async () => { await onSave({ signature: data, signed_by: name }); setRedo(false); }, children: "Save signature" }), redo && _jsx(Button, { size: "sm", variant: "ghost", onClick: () => setRedo(false), children: "Cancel" })] })] }));
}
function CheckIn({ item, answer, disabled, preview, onSave }) {
    const [busy, setBusy] = useState(false);
    const [err, setErr] = useState("");
    const [skipping, setSkipping] = useState(false);
    const [reason, setReason] = useState("");
    const v = answer?.value;
    const locate = () => {
        if (!navigator.geolocation) {
            setErr("This device can't share its location.");
            return;
        }
        setBusy(true);
        setErr("");
        navigator.geolocation.getCurrentPosition(async (pos) => {
            try {
                await onSave({ value: { lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: pos.coords.accuracy } });
            }
            catch (e) {
                setErr(e.message);
            }
            finally {
                setBusy(false);
            }
        }, (e) => { setBusy(false); setErr(e.code === 1 ? "Location access was denied. Allow it in your browser settings, or skip the check-in." : "Your position couldn't be found. Try again outdoors or near a window."); }, { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 });
    };
    if (v && v.skipped)
        return _jsxs("div", { className: "row wrap small", style: { gap: 8 }, children: [_jsx("span", { className: "pr-result flag", children: "Skipped" }), v.reason && _jsx("span", { className: "muted", children: v.reason }), !disabled && _jsx("button", { type: "button", className: "linkbtn small", onClick: locate, children: "Check in instead" })] });
    if (v && v.lat !== undefined)
        return _jsxs("div", { className: "row wrap small", style: { gap: 8 }, children: [_jsxs("span", { className: "pr-result pass", children: [_jsx(MapPin, { size: 13 }), "Checked in"] }), _jsx("span", { className: "muted", children: v.distance_m !== undefined ? `${Math.round(v.distance_m)} m from the location` : v.note }), !disabled && _jsx("button", { type: "button", className: "linkbtn small", onClick: locate, disabled: busy, children: "Check in again" })] });
    return (_jsxs("div", { className: "stack", style: { gap: 6 }, children: [_jsxs("div", { className: "row wrap", style: { gap: 8 }, children: [_jsxs(Button, { size: "sm", variant: "primary", onClick: locate, disabled: disabled || busy || preview, children: [_jsx(LocateFixed, { size: 15 }), busy ? "Finding you…" : "Check in"] }), _jsxs("span", { className: "small faint", children: ["Within ", item.buffer_m ?? 10, " m of the work order's location"] }), item.allow_skip !== false && !disabled && !preview && _jsx("button", { type: "button", className: "linkbtn small", onClick: () => setSkipping(true), children: "Skip" })] }), skipping && _jsxs("div", { className: "row wrap", style: { gap: 6 }, children: [_jsx(Input, { placeholder: "Why are you skipping? (optional)", "aria-label": "Reason for skipping", value: reason, onChange: (e) => setReason(e.target.value), style: { maxWidth: 320 } }), _jsx(Button, { size: "sm", onClick: async () => { try {
                            await onSave({ value: { skip: true, reason } });
                            setSkipping(false);
                        }
                        catch (e) {
                            setErr(e.message);
                        } }, children: "Skip check-in" })] }), err && _jsx("div", { className: "small", style: { color: "var(--c-danger)" }, children: err })] }));
}
