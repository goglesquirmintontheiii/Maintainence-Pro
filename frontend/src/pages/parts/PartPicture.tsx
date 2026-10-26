// Part pictures (MP-131): a cropped picture on the part page and form, shown in lists, pickers and on work orders.
// The picture is one of the part's photos; removing it takes that photo off the part.
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Package, Trash2 } from "lucide-react";
import { api, ApiError, upload } from "../../lib/api";
import { useToast } from "../../components/Toast";
import { Button } from "../../components/ui";
import { PhotoPickerButton } from "../../components/AvatarCropper";
import type { PartPicture } from "./types";

/** Small square picture for list rows; a parts icon when there's none. */
export function PartThumb({ picture, size = "md" }: { picture: PartPicture | null | undefined; size?: "sm" | "md" }) {
  const cls = "asset-thumb" + (size === "sm" ? " sm" : "");
  return picture ? <img className={cls} src={picture.thumb_url} alt="" loading="lazy" /> : <span className={cls + " ph"} aria-hidden="true"><Package size={size === "sm" ? 13 : 15} /></span>;
}

/** Crop a photo and upload it; returns the new file's id. */
export async function uploadPicture(blob: Blob): Promise<string> {
  const f = await upload(new File([blob], "part-picture.jpg", { type: blob.type || "image/jpeg" }));
  return f.id;
}

/** Add / change / remove the picture of a saved part. */
export function PartPictureControls({ partId, picture }: { partId: string; picture: PartPicture | null }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);
  const save = async (fileId: string | null) => {
    setBusy(true);
    try {
      await api(`/parts/${partId}`, { method: "PATCH", body: { picture_file_id: fileId } });
      qc.invalidateQueries({ queryKey: ["part", partId] }); qc.invalidateQueries({ queryKey: ["parts"] }); qc.invalidateQueries({ queryKey: ["wo-parts"] });
      toast(fileId ? "Picture saved" : "Picture removed");
    } catch (e) { toast((e as ApiError).message, { kind: "error" }); } finally { setBusy(false); }
  };
  return <div className="row wrap" style={{ gap: 6 }}>
    <PhotoPickerButton inputLabel="Choose a part picture" busy={busy} label={picture ? "Change picture" : "Add picture"} onBlob={async (b) => { try { setBusy(true); const id = await uploadPicture(b); await save(id); } catch (e) { setBusy(false); toast((e as ApiError).message, { kind: "error" }); } }} />
    {picture && <Button size="sm" variant="ghost" disabled={busy} onClick={() => void save(null)}><Trash2 size={14} />Remove picture</Button>}
  </div>;
}
