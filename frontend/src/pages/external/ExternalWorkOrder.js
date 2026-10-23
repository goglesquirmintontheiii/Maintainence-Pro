import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
// Public work order page for people outside the organization (0.5.0: r058–r060, r092). No login: the secret link in
// the URL is the credential, so this page never uses the session and only calls /api/v1/external/<token>/….
import { useEffect, useRef, useState } from "react";
import { DropZone } from "../../components/DropZone";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Clock, FileText, MapPin, Paperclip, Send, Wrench } from "lucide-react";
import { api, ApiError } from "../../lib/api";
import { dateTime, timeAgo } from "../../lib/format";
import { useToast } from "../../components/Toast";
import { LogoMark } from "../../components/Logo";
import { Button, EmptyState, Field, Input, Modal, Pill, PriorityBadge, Select, StatusPill } from "../../components/ui";
import { SignaturePad } from "../../components/pickers";
import "../../styles/external.css";
const NAME_KEY = "mpro.external.name";
const readName = () => { try {
    return localStorage.getItem(NAME_KEY) ?? "";
}
catch {
    return "";
} };
const saveName = (n) => { try {
    localStorage.setItem(NAME_KEY, n);
}
catch { /* private mode */ } };
function token() { return decodeURIComponent(window.location.pathname.replace(/^\/x\//, "").split("/")[0] ?? ""); }
async function uploadFile(t, file) {
    const fd = new FormData();
    fd.append("file", file);
    const res = await fetch(`/api/v1/external/${encodeURIComponent(t)}/files`, { method: "POST", body: fd, credentials: "omit", referrerPolicy: "no-referrer" });
    const data = await res.json().catch(() => ({}));
    if (!res.ok)
        throw new ApiError(res.status, data.message || "The upload failed. Try again.");
    return data;
}
function FileChips({ files }) {
    if (!files.length)
        return null;
    return _jsx("div", { className: "row wrap", style: { gap: 8 }, children: files.map((f) => f.is_image && f.thumb_url
            ? _jsx("a", { href: f.url, target: "_blank", rel: "noopener noreferrer", className: "ext-thumb", children: _jsx("img", { src: f.thumb_url, alt: f.name, referrerPolicy: "no-referrer" }) }, f.id)
            : _jsxs("a", { href: f.url + "?download=1", rel: "noopener noreferrer", className: "chip", children: [_jsx(FileText, { size: 13 }), f.name] }, f.id)) });
}
function flatten(items) { return items.flatMap((i) => i.type === "section" || i.type === "procedure" ? [i, ...flatten(i.items ?? [])] : [i]); }
function AnswerField({ t, run, item, a, name, canEdit, onSaved }) {
    const { toast } = useToast();
    const [sig, setSig] = useState(null);
    const [text, setText] = useState(a?.value != null && typeof a.value !== "object" ? String(a.value) : "");
    const save = useMutation({
        mutationFn: (body) => api(`/external/${encodeURIComponent(t)}/procedures/${run.id}/answers/${item.id}`, { method: "PUT", body: { name, ...body } }),
        onSuccess: onSaved, onError: (e) => toast(e.message, { kind: "error" }),
    });
    const ask = () => { if (!name.trim()) {
        toast("Type your name at the top first.", { kind: "error" });
        return false;
    } return true; };
    const put = (value, extra = {}) => { if (ask())
        save.mutate({ value, ...extra }); };
    const dis = !canEdit || save.isPending;
    const v = a?.value;
    const choice = (opts, cur) => _jsx("div", { className: "row wrap", style: { gap: 6 }, children: opts.map(([id, label]) => _jsx(Button, { size: "sm", variant: cur === id ? "primary" : "default", disabled: dis, onClick: () => put(id), children: label }, id)) });
    let control;
    switch (item.type) {
        case "checkbox":
            control = _jsxs("label", { className: "check", children: [_jsx("input", { type: "checkbox", checked: !!v, disabled: dis, onChange: (e) => put(e.target.checked) }), _jsx("span", { children: v ? "Done" : "Not done" })] });
            break;
        case "inspection":
            control = choice([["pass", "Pass"], ["flag", "Flag"], ["fail", "Fail"]], a?.result ?? "");
            break;
        case "yes_no_na":
            control = choice([["yes", "Yes"], ["no", "No"], ["na", "N/A"]], a?.result ?? "");
            break;
        case "multiple_choice":
            control = _jsxs(Select, { value: String(v ?? ""), disabled: dis, onChange: (e) => put(e.target.value || null), "aria-label": item.label, children: [_jsx("option", { value: "", children: "Choose\u2026" }), (item.options ?? []).map((o) => _jsx("option", { children: o }, o))] });
            break;
        case "checklist": {
            const cur = Array.isArray(v) ? v : [];
            control = _jsx("div", { className: "stack", style: { gap: 4 }, children: (item.options ?? []).map((o) => _jsxs("label", { className: "check small", children: [_jsx("input", { type: "checkbox", disabled: dis, checked: cur.includes(o), onChange: (e) => put(e.target.checked ? [...cur, o] : cur.filter((x) => x !== o)) }), _jsx("span", { children: o })] }, o)) });
            break;
        }
        case "number":
        case "amount":
        case "meter_reading":
            control = _jsxs("div", { className: "row", children: [_jsx(Input, { type: "number", inputMode: "decimal", value: text, disabled: dis, onChange: (e) => setText(e.target.value), "aria-label": item.label, style: { maxWidth: 180 } }), _jsx(Button, { size: "sm", disabled: dis, onClick: () => put(item.type === "meter_reading" ? { value: text } : text), children: "Save" })] });
            break;
        case "date":
            control = _jsx(Input, { type: "date", value: String(v ?? "").slice(0, 10), disabled: dis, onChange: (e) => put(e.target.value || null), "aria-label": item.label, style: { maxWidth: 200 } });
            break;
        case "text":
            control = _jsxs("div", { className: "stack", style: { gap: 6 }, children: [_jsx("textarea", { className: "textarea", rows: 2, value: text, disabled: dis, onChange: (e) => setText(e.target.value), "aria-label": item.label }), _jsx("div", { children: _jsx(Button, { size: "sm", disabled: dis || text === String(v ?? ""), onClick: () => put(text), children: "Save" }) })] });
            break;
        case "file":
            control = _jsxs("div", { className: "stack", style: { gap: 6 }, children: [_jsx(FileChips, { files: a?.files ?? [] }), canEdit && _jsxs("label", { className: "btn btn-sm", style: { alignSelf: "flex-start" }, children: [_jsx(Paperclip, { size: 13 }), "Add photos or files", _jsx("input", { type: "file", multiple: true, hidden: true, onChange: async (e) => {
                                    if (!ask())
                                        return;
                                    const list = Array.from(e.target.files ?? []);
                                    e.target.value = "";
                                    try {
                                        const ups = await Promise.all(list.map((f) => uploadFile(t, f)));
                                        put(ups.map((u) => u.id));
                                    }
                                    catch (err) {
                                        toast(err.message, { kind: "error" });
                                    }
                                } })] })] });
            break;
        case "signature": {
            const sv = v;
            control = sv?.name ? _jsxs("span", { className: "small", children: ["Signed by ", _jsx("b", { children: sv.name })] }) : canEdit ? _jsxs("div", { className: "stack", style: { gap: 6 }, children: [_jsx(SignaturePad, { onChange: setSig }), _jsx("div", { children: _jsx(Button, { size: "sm", disabled: !sig || dis, onClick: () => { if (ask())
                                save.mutate({ signature: sig, signed_by: name }); }, children: "Sign" }) })] }) : _jsx("span", { className: "faint small", children: "Not signed" });
            break;
        }
        default: control = _jsx("span", { className: "small muted", children: "This field is filled in by the organization." });
    }
    return (_jsxs("div", { className: "ext-field", children: [_jsxs("div", { className: "row", style: { justifyContent: "space-between", alignItems: "flex-start" }, children: [_jsxs("div", { children: [_jsx("b", { children: item.label }), item.required && _jsx("span", { className: "req", "aria-label": "required", children: " *" }), item.description && _jsx("div", { className: "small muted prewrap", children: item.description })] }), a?.answered_by && _jsx("span", { className: "small faint", children: a.answered_by })] }), (item.reference_file_ids ?? []).length > 0 && _jsx(FileChips, { files: (item.reference_file_ids ?? []).map((id) => run.reference_files[id]).filter(Boolean) }), item.link && _jsx("a", { href: item.link, target: "_blank", rel: "noopener noreferrer", className: "small", children: item.link }), control] }));
}
function Procedures({ t, runs, name, canEdit, onSaved }) {
    return _jsxs("section", { className: "card card-pad stack", children: [_jsxs("h2", { children: [_jsx(Wrench, { size: 16 }), " Procedures"] }), runs.map((r) => (_jsxs("div", { className: "stack", style: { gap: 10 }, children: [_jsxs("div", { className: "row", children: [_jsx("h3", { className: "grow", children: r.procedure?.name ?? "Procedure" }), r.status === "done" ? _jsx(Pill, { tone: "success", children: "Done" }) : _jsx(Pill, { children: "In progress" })] }), flatten(r.schema.items).map((it) => it.type === "heading" || it.type === "section" || it.type === "procedure"
                        ? (it.label ? _jsx("h4", { className: "sec-h", children: it.label }, it.id) : null)
                        : _jsx(AnswerField, { t: t, run: r, item: it, a: r.answers[it.id], name: name, canEdit: canEdit, onSaved: onSaved }, it.id))] }, r.id)))] });
}
function Comments({ t, view, name, canEdit, onSaved }) {
    const { toast } = useToast();
    const [body, setBody] = useState("");
    const [files, setFiles] = useState([]);
    const [busy, setBusy] = useState(0);
    const post = useMutation({
        mutationFn: () => api(`/external/${encodeURIComponent(t)}/comments`, { method: "POST", body: { name, body, file_ids: files.map((f) => f.id) } }),
        onSuccess: () => { setBody(""); setFiles([]); onSaved(); }, onError: (e) => toast(e.message, { kind: "error" }),
    });
    return _jsxs("section", { className: "card card-pad stack", children: [_jsx("h2", { children: "Comments" }), (view.comments ?? []).map((c) => (_jsxs("div", { className: "ext-comment", children: [_jsxs("div", { className: "small", children: [_jsx("b", { children: c.author }), " ", _jsxs("span", { className: "faint", children: ["\u00B7 ", timeAgo(c.created_at)] })] }), c.body && _jsx("p", { className: "prewrap", style: { margin: "4px 0" }, children: c.body }), _jsx(FileChips, { files: c.files })] }, c.id))), !view.comments?.length && _jsx("p", { className: "small muted", children: "No comments yet." }), canEdit && _jsx(DropZone, { label: "Drop files to attach them", onFiles: async (list) => {
                    for (const f of list) {
                        setBusy((n) => n + 1);
                        try {
                            const up = await uploadFile(t, f);
                            setFiles((x) => [...x, up]);
                        }
                        catch (err) {
                            toast(err.message, { kind: "error" });
                        }
                        finally {
                            setBusy((n) => n - 1);
                        }
                    }
                }, children: _jsxs("div", { className: "stack", style: { gap: 6 }, children: [_jsx("textarea", { className: "textarea", rows: 3, placeholder: "Write a comment\u2026", value: body, onChange: (e) => setBody(e.target.value), "aria-label": "Comment" }), files.length > 0 && _jsx("div", { className: "row wrap small", children: files.map((f) => _jsx("span", { className: "chip", children: f.name }, f.id)) }), _jsxs("div", { className: "row", children: [_jsxs("label", { className: "btn btn-sm", children: [_jsx(Paperclip, { size: 13 }), busy ? "Uploading…" : "Attach", _jsx("input", { type: "file", multiple: true, hidden: true, onChange: async (e) => {
                                                const list = Array.from(e.target.files ?? []);
                                                e.target.value = "";
                                                for (const f of list) {
                                                    setBusy((n) => n + 1);
                                                    try {
                                                        const up = await uploadFile(t, f);
                                                        setFiles((x) => [...x, up]);
                                                    }
                                                    catch (err) {
                                                        toast(err.message, { kind: "error" });
                                                    }
                                                    finally {
                                                        setBusy((n) => n - 1);
                                                    }
                                                }
                                            } })] }), _jsx("span", { className: "grow" }), _jsxs(Button, { variant: "primary", size: "sm", disabled: post.isPending || busy > 0 || (!body.trim() && !files.length) || !name.trim(), onClick: () => post.mutate(), children: [_jsx(Send, { size: 13 }), "Post"] })] }), !name.trim() && _jsx("span", { className: "small faint", children: "Type your name at the top to comment." })] }) })] });
}
export function ExternalWorkOrder() {
    const t = token();
    const qc = useQueryClient();
    const { toast } = useToast();
    const [name, setName] = useState(readName);
    const [finishing, setFinishing] = useState(false);
    const [note, setNote] = useState("");
    const q = useQuery({ queryKey: ["external", t], queryFn: () => api(`/external/${encodeURIComponent(t)}`), retry: false, refetchInterval: 60_000 });
    const metaAdded = useRef(false);
    useEffect(() => {
        if (metaAdded.current)
            return;
        metaAdded.current = true;
        const m = document.createElement("meta");
        m.name = "referrer";
        m.content = "no-referrer";
        document.head.appendChild(m);
    }, []);
    useEffect(() => { if (q.data)
        document.title = `#${q.data.number} ${q.data.title} · ${q.data.organization}`; }, [q.data]);
    const refresh = () => qc.invalidateQueries({ queryKey: ["external", t] });
    const finish = useMutation({
        mutationFn: () => api(`/external/${encodeURIComponent(t)}/finish`, { method: "POST", body: { name, note } }),
        onSuccess: () => { setFinishing(false); setNote(""); refresh(); toast("Thanks — they've been told the work is finished."); },
        onError: (e) => toast(e.message, { kind: "error" }),
    });
    const shell = (children) => _jsxs("div", { className: "ext-page", children: [_jsxs("header", { className: "ext-top", children: [_jsx(LogoMark, { size: 26 }), _jsx("span", { className: "grow", children: q.data?.organization ?? "Maintenance Pro" })] }), _jsx("main", { className: "ext-main stack", children: children })] });
    if (q.isLoading)
        return shell(_jsx("p", { className: "muted", children: "Loading\u2026" }));
    if (q.isError || !q.data) {
        const st = q.error?.status;
        return shell(_jsx(EmptyState, { title: st === 429 ? "Too many requests" : "This link doesn't work", children: st === 429 ? "Wait a few minutes and try again." : "It may have been turned off, replaced with a new link, or the work may be complete. Ask the person who sent it for a new link." }));
    }
    const v = q.data;
    const can = (f, want = "view") => want === "interact" ? v.access[f] === "interact" : v.access[f] === "view" || v.access[f] === "interact";
    const anyInteract = can("comments", "interact") || can("procedures", "interact");
    return shell(_jsxs(_Fragment, { children: [_jsxs("section", { className: "card card-pad stack", children: [_jsxs("div", { className: "small muted mono", children: ["Work order #", v.number] }), _jsx("h1", { className: "wo-title", style: { margin: 0 }, children: v.title }), (v.status || v.priority) && _jsxs("div", { className: "row wrap", children: [v.status && _jsx(StatusPill, { status: v.status, sub: v.sub_status }), v.priority && _jsx(PriorityBadge, { priority: v.priority }), v.due_at && _jsxs("span", { className: "due " + (v.overdue ? "danger" : ""), children: [_jsx(Clock, { size: 13 }), "Due ", dateTime(v.due_at)] })] }), _jsxs("dl", { className: "meta-grid", children: [v.start_at !== undefined && _jsxs("div", { children: [_jsx("dt", { children: "Start" }), _jsx("dd", { children: v.start_at ? dateTime(v.start_at) : "—" })] }), v.location !== undefined && _jsxs("div", { children: [_jsx("dt", { children: "Location" }), _jsx("dd", { children: v.location ? _jsxs("span", { className: "row", style: { gap: 6 }, children: [_jsx(MapPin, { size: 14, className: "faint" }), v.location.name] }) : "—" })] }), v.assets !== undefined && _jsxs("div", { children: [_jsx("dt", { children: "Asset" }), _jsx("dd", { children: v.assets.length ? v.assets.map((a) => a.name).join(", ") : "—" })] }), v.assignees !== undefined && _jsxs("div", { children: [_jsx("dt", { children: "Assigned to" }), _jsx("dd", { children: v.assignees.map((a) => a.name).join(", ") || "—" })] }), v.categories !== undefined && _jsxs("div", { children: [_jsx("dt", { children: "Categories" }), _jsx("dd", { children: v.categories.map((c) => c.name).join(", ") || "—" })] })] }), v.description && _jsx("p", { className: "prewrap", children: v.description }), v.files && v.files.length > 0 && _jsx(FileChips, { files: v.files })] }), anyInteract && _jsx("section", { className: "card card-pad row wrap", children: _jsx(Field, { label: "Your name", hint: "Shown next to what you add.", className: "grow", children: (id) => _jsx(Input, { id: id, value: name, maxLength: 120, onChange: (e) => { setName(e.target.value); saveName(e.target.value); }, placeholder: "Jo Smith, Acme Mechanical" }) }) }), v.procedures && v.procedures.length > 0 && _jsx(Procedures, { t: t, runs: v.procedures, name: name, canEdit: can("procedures", "interact"), onSaved: refresh }), v.comments !== undefined && _jsx(Comments, { t: t, view: v, name: name, canEdit: can("comments", "interact"), onSaved: refresh }), _jsx("section", { className: "card card-pad row wrap", children: v.finished_at ? _jsxs("div", { className: "row grow", children: [_jsx(CheckCircle2, { size: 18, className: "ok" }), _jsxs("span", { children: ["Marked finished by ", _jsx("b", { children: v.finished_by_name }), " ", timeAgo(v.finished_at), ". ", v.organization, " will review and close it."] })] })
                    : _jsxs(_Fragment, { children: [_jsxs("span", { className: "grow small muted", children: ["Done with the work? Let ", v.organization, " know."] }), _jsxs(Button, { variant: "primary", onClick: () => setFinishing(true), children: [_jsx(CheckCircle2, { size: 15 }), "Mark work finished"] })] }) }), _jsx("p", { className: "small faint", style: { textAlign: "center" }, children: "Keep this link private: anyone with it can see and add to this work order." }), finishing && _jsx(Modal, { title: "Mark the work finished", onClose: () => setFinishing(false), footer: _jsxs(_Fragment, { children: [_jsx(Button, { onClick: () => setFinishing(false), children: "Cancel" }), _jsx(Button, { variant: "primary", disabled: !name.trim() || finish.isPending, onClick: () => finish.mutate(), children: "Mark finished" })] }), children: _jsxs("div", { className: "stack", children: [_jsx(Field, { label: "Your name", children: (id) => _jsx(Input, { id: id, value: name, onChange: (e) => { setName(e.target.value); saveName(e.target.value); } }) }), _jsx(Field, { label: "Note (optional)", children: (id) => _jsx("textarea", { id: id, className: "textarea", rows: 3, value: note, onChange: (e) => setNote(e.target.value), placeholder: "What was done, anything they should know" }) })] }) })] }));
}
