// Warranty documents on an asset (MP-114): certificates, terms and receipts, attached with the FileLink role "warranty".
import { useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Download, FileText, Paperclip, X } from "lucide-react";
import { api, ApiError, upload, type FileItem } from "../../lib/api";
import { useToast } from "../../components/Toast";
import { Button } from "../../components/ui";
import { Lightbox } from "./shared";
import { DropZone } from "../../components/DropZone";

/**
 * With `assetId`, files upload straight onto the saved asset and removing unlinks them.
 * Without it (a new asset), the uploaded files are kept in `files`/`setFiles` and sent as `warranty_file_ids` on create.
 */
const WARRANTY_ACCEPT = "image/*,application/pdf,.doc,.docx,.txt";

export function WarrantyFiles({ files, setFiles, assetId, editable = true }: {
  files: FileItem[]; setFiles?: (f: FileItem[]) => void; assetId?: string; editable?: boolean;
}) {
  const input = useRef<HTMLInputElement>(null);
  const qc = useQueryClient();
  const { toast } = useToast();
  const [busy, setBusy] = useState("");
  const [view, setView] = useState<FileItem | null>(null);
  const refresh = () => assetId && void qc.invalidateQueries({ queryKey: ["asset", assetId] });
  const add = async (list: FileList | File[] | null) => {
    if (!list) return;
    const out = [...files];
    for (const f of Array.from(list)) {
      setBusy(f.name);
      try { out.push(await upload(f, assetId ? { entity_type: "asset", entity_id: assetId, role: "warranty" } : undefined)); }
      catch (e) { toast((e as ApiError).message, { kind: "error" }); }
    }
    setBusy("");
    if (assetId) refresh(); else setFiles?.(out);
  };
  const remove = async (f: FileItem) => {
    if (!assetId) { setFiles?.(files.filter((x) => x.id !== f.id)); return; }
    try { await api(`/files/links/${f.link_id}`, { method: "DELETE" }); refresh(); toast("Removed"); }
    catch (e) { toast((e as ApiError).message, { kind: "error" }); }
  };
  return (
    <DropZone className="full stack" disabled={!editable} accept={WARRANTY_ACCEPT} onFiles={(fs) => void add(fs)}>
      {files.length > 0 && <div className="files">{files.map((f) => (
        <div key={f.id + (f.link_id ?? "")} className="file-row">
          <FileText size={14} className="faint" aria-hidden="true" />
          <button type="button" className="linkbtn grow" style={{ textAlign: "left" }} onClick={() => setView(f)}>{f.name}</button>
          {f.link_id && <a className="btn ghost sm icon" href={f.url + "?download=1"} aria-label={`Download ${f.name}`}><Download size={14} /></a>}
          {editable && <Button size="sm" variant="ghost" icon aria-label={`Remove ${f.name}`} onClick={() => void remove(f)}><X size={14} /></Button>}
        </div>))}</div>}
      {editable && <>
        <input ref={input} type="file" multiple hidden accept={WARRANTY_ACCEPT} onChange={(e) => { void add(e.target.files); e.target.value = ""; }} />
        <div><Button size="sm" onClick={() => input.current?.click()} disabled={!!busy}><Paperclip size={14} />{busy ? `Uploading ${busy}…` : "Add warranty document"}</Button></div>
      </>}
      {!editable && files.length === 0 && <span className="small faint">No warranty documents.</span>}
      {view && <Lightbox file={view} files={files} onClose={() => setView(null)} />}
    </DropZone>
  );
}
