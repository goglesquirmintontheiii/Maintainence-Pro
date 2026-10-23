import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
// Warranty documents on an asset (MP-114): certificates, terms and receipts, attached with the FileLink role "warranty".
import { useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Download, FileText, Paperclip, X } from "lucide-react";
import { api, upload } from "../../lib/api";
import { useToast } from "../../components/Toast";
import { Button } from "../../components/ui";
import { Lightbox } from "./shared";
import { DropZone } from "../../components/DropZone";
/**
 * With `assetId`, files upload straight onto the saved asset and removing unlinks them.
 * Without it (a new asset), the uploaded files are kept in `files`/`setFiles` and sent as `warranty_file_ids` on create.
 */
const WARRANTY_ACCEPT = "image/*,application/pdf,.doc,.docx,.txt";
export function WarrantyFiles({ files, setFiles, assetId, editable = true }) {
    const input = useRef(null);
    const qc = useQueryClient();
    const { toast } = useToast();
    const [busy, setBusy] = useState("");
    const [view, setView] = useState(null);
    const refresh = () => assetId && void qc.invalidateQueries({ queryKey: ["asset", assetId] });
    const add = async (list) => {
        if (!list)
            return;
        const out = [...files];
        for (const f of Array.from(list)) {
            setBusy(f.name);
            try {
                out.push(await upload(f, assetId ? { entity_type: "asset", entity_id: assetId, role: "warranty" } : undefined));
            }
            catch (e) {
                toast(e.message, { kind: "error" });
            }
        }
        setBusy("");
        if (assetId)
            refresh();
        else
            setFiles?.(out);
    };
    const remove = async (f) => {
        if (!assetId) {
            setFiles?.(files.filter((x) => x.id !== f.id));
            return;
        }
        try {
            await api(`/files/links/${f.link_id}`, { method: "DELETE" });
            refresh();
            toast("Removed");
        }
        catch (e) {
            toast(e.message, { kind: "error" });
        }
    };
    return (_jsxs(DropZone, { className: "full stack", disabled: !editable, accept: WARRANTY_ACCEPT, onFiles: (fs) => void add(fs), children: [files.length > 0 && _jsx("div", { className: "files", children: files.map((f) => (_jsxs("div", { className: "file-row", children: [_jsx(FileText, { size: 14, className: "faint", "aria-hidden": "true" }), _jsx("button", { type: "button", className: "linkbtn grow", style: { textAlign: "left" }, onClick: () => setView(f), children: f.name }), f.link_id && _jsx("a", { className: "btn ghost sm icon", href: f.url + "?download=1", "aria-label": `Download ${f.name}`, children: _jsx(Download, { size: 14 }) }), editable && _jsx(Button, { size: "sm", variant: "ghost", icon: true, "aria-label": `Remove ${f.name}`, onClick: () => void remove(f), children: _jsx(X, { size: 14 }) })] }, f.id + (f.link_id ?? "")))) }), editable && _jsxs(_Fragment, { children: [_jsx("input", { ref: input, type: "file", multiple: true, hidden: true, accept: WARRANTY_ACCEPT, onChange: (e) => { void add(e.target.files); e.target.value = ""; } }), _jsx("div", { children: _jsxs(Button, { size: "sm", onClick: () => input.current?.click(), disabled: !!busy, children: [_jsx(Paperclip, { size: 14 }), busy ? `Uploading ${busy}…` : "Add warranty document"] }) })] }), !editable && files.length === 0 && _jsx("span", { className: "small faint", children: "No warranty documents." }), view && _jsx(Lightbox, { file: view, files: files, onClose: () => setView(null) })] }));
}
