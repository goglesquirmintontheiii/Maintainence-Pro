// Shared drag-and-drop target for files (0.5.0, MP-127). Wrap anything that takes files:
//   <DropZone onFiles={(files) => upload(files)} accept="image/*,.pdf" maxBytes={…}>…</DropZone>
// While files are dragged over it, a drop overlay appears. Files that aren't allowed or are too big are explained in a
// toast and left out; the rest go to onFiles. `disabled` turns it off (e.g. read-only views).
import { useRef, useState, type ReactNode } from "react";
import { Upload } from "lucide-react";
import { useToast } from "./Toast";
import { getMaxUpload } from "../lib/api";
import "../styles/dropzone.css";

/** Does `file` match an <input accept> style list ("image/*,.pdf,application/zip")? */
export function acceptsFile(file: File, accept?: string): boolean {
  if (!accept) return true;
  const name = file.name.toLowerCase();
  const type = (file.type || "").toLowerCase();
  return accept.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean).some((a) =>
    a.startsWith(".") ? name.endsWith(a) : a.endsWith("/*") ? type.startsWith(a.slice(0, -1)) : type === a);
}

export function DropZone({ onFiles, accept, maxBytes, multiple = true, disabled, children, className = "", label = "Drop files to add them", inline }: {
  onFiles: (files: File[]) => void; accept?: string; maxBytes?: number; multiple?: boolean; disabled?: boolean;
  children: ReactNode; className?: string; label?: string; inline?: boolean;
}) {
  const [over, setOver] = useState(false);
  const depth = useRef(0);
  const { toast } = useToast();
  const hasFiles = (e: React.DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes("Files");

  const take = (list: FileList) => {
    const limit = maxBytes ?? getMaxUpload() * 1024 * 1024;
    let files = Array.from(list);
    const wrongType = files.filter((f) => !acceptsFile(f, accept));
    const tooBig = files.filter((f) => acceptsFile(f, accept) && f.size > limit);
    files = files.filter((f) => acceptsFile(f, accept) && f.size <= limit);
    if (!multiple && files.length > 1) { toast("Only one file can be added here; the first one was used.", { kind: "info" }); files = files.slice(0, 1); }
    if (wrongType.length) toast(`${wrongType.map((f) => f.name).join(", ")} can't be added here.`, { kind: "error" });
    if (tooBig.length) toast(`${tooBig.map((f) => f.name).join(", ")} ${tooBig.length === 1 ? "is" : "are"} over the ${Math.round(limit / 1048576)} MB limit.`, { kind: "error" });
    if (files.length) onFiles(files);
  };

  return (
    <div className={"dz" + (over ? " over" : "") + (inline ? " inline" : "") + (className ? " " + className : "")}
      onDragEnter={(e) => { if (disabled || !hasFiles(e)) return; e.preventDefault(); depth.current++; setOver(true); }}
      onDragOver={(e) => { if (disabled || !hasFiles(e)) return; e.preventDefault(); e.dataTransfer.dropEffect = "copy"; }}
      onDragLeave={(e) => { if (disabled || !hasFiles(e)) return; depth.current = Math.max(0, depth.current - 1); if (!depth.current) setOver(false); }}
      onDrop={(e) => {
        if (disabled || !hasFiles(e)) return;
        e.preventDefault(); e.stopPropagation(); depth.current = 0; setOver(false);
        if (e.dataTransfer.files?.length) take(e.dataTransfer.files);
      }}>
      {children}
      {over && <div className="dz-overlay" aria-hidden><Upload size={22} /><span>{label}</span></div>}
    </div>
  );
}
