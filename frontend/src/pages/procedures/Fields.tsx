// One procedure field as the technician sees it (runner on the work order and the builder's live preview).
// `onSave(body)` sends the answer; the preview passes a local handler so nothing is saved.
import { useEffect, useRef, useState } from "react";
import { Camera, Check, ExternalLink, FileText, Flag, Gauge, Link2, LocateFixed, MapPin, MessageSquare, Paperclip, Users, X } from "lucide-react";
import { upload, type FileItem } from "../../lib/api";
import { dateTime } from "../../lib/format";
import { useWOOptions } from "../../lib/wo";
import { SignaturePad } from "../../components/pickers";
import { Button, Input } from "../../components/ui";
import { DropZone } from "../../components/DropZone";
import { FIELD_LABEL, RESULT_LABEL, type Answer, type Item } from "./types";

export type SaveBody = Record<string, unknown>;
type Props = {
  item: Item; answer?: Answer; disabled?: boolean; preview?: boolean; tz?: string;
  refs?: Record<string, FileItem>; onSave: (body: SaveBody) => Promise<unknown> | void;
};

const NOTE_TYPES = ["checkbox", "number", "amount", "multiple_choice", "checklist", "inspection", "yes_no_na", "date"];

export function FieldRow({ item, answer, disabled, preview, tz, refs, onSave }: Props) {
  const v = answer?.value;
  const [noteOpen, setNoteOpen] = useState(!!answer?.note);
  const answered = !!answer && (answer.skipped || (v !== null && v !== undefined && v !== "" && v !== false && !(Array.isArray(v) && v.length === 0)));
  const save = (body: SaveBody) => onSave(body);
  const withValue = (extra: SaveBody) => save({ value: item.type === "meter_reading" && v && typeof v === "object" ? { value: (v as { value: number }).value } : v, ...extra });
  return (
    <div className={"pr-field" + (answered ? " answered" : "") + (answer?.result ? " r-" + answer.result : "")} data-type={item.type} id={`pf-${item.id}`}>
      {(item.type !== "checkbox" || item.description || item.link || item.reference_file_ids?.length || item.assignees?.length) && <div className="pr-field-head">
        <div className="grow" style={{ minWidth: 0 }}>
          <div className="pr-label">{item.type !== "checkbox" && item.label}{item.required && item.type !== "checkbox" && <span className="pr-req" aria-label="required">*</span>}</div>
          {item.description && <div className="small muted prewrap">{item.description}</div>}
          <FieldExtras item={item} refs={refs} />
        </div>
        {answer?.result && ["pass", "flag", "fail"].includes(answer.result) && <span className={"pr-result " + answer.result}>{RESULT_LABEL[answer.result]}</span>}
      </div>}
      <FieldInput item={item} answer={answer} disabled={disabled} preview={preview} onSave={save} />
      {(answer?.note || noteOpen) && NOTE_TYPES.includes(item.type) && (
        <NoteBox note={answer?.note ?? ""} disabled={disabled} onSave={(note) => withValue({ note })} />)}
      {!!answer?.files.length && item.type !== "file" && <Thumbs files={answer.files} />}
      {(answer?.answered_by || (!disabled && !preview && answered && NOTE_TYPES.includes(item.type))) && <div className="pr-field-foot">
        {answer?.answered_by && <span className="small faint">{answer.skipped ? "Skipped" : "Answered"} by {answer.answered_by}{answer.answered_at ? ` · ${dateTime(answer.answered_at, tz)}` : ""}</span>}
        <span className="grow" />
        {!disabled && !preview && answered && NOTE_TYPES.includes(item.type) && !noteOpen && !answer?.note &&
          <button type="button" className="linkbtn small" onClick={() => setNoteOpen(true)}><MessageSquare size={13} />Add note</button>}
        {!disabled && !preview && answered && item.type === "inspection" && <PhotoButton label="Add photo" onUploaded={(f) => withValue({ file_ids: [...(answer?.files ?? []).map((x) => x.id), f.id] })} />}
      </div>}
    </div>
  );
}

function FieldExtras({ item, refs }: { item: Item; refs?: Record<string, FileItem> }) {
  const opts = useWOOptions();
  const names = (item.assignees ?? []).map((a) => {
    const [kind, id] = a.split(":");
    return kind === "user" ? opts.data?.people.find((p) => p.id === id)?.name : opts.data?.teams.find((t) => t.id === id)?.name;
  }).filter(Boolean);
  const files = (item.reference_file_ids ?? []).map((id) => refs?.[id]).filter(Boolean) as FileItem[];
  if (!item.link && !files.length && !names.length) return null;
  return (
    <div className="pr-extras">
      {names.length > 0 && <span className="chip"><Users size={12} />Assigned to {names.join(", ")}</span>}
      {item.link && <a className="chip" href={item.link} target="_blank" rel="noopener noreferrer"><Link2 size={12} />{shortUrl(item.link)}<ExternalLink size={11} /></a>}
      {files.map((f) => <a key={f.id} className="chip" href={f.url} target="_blank" rel="noopener noreferrer"><FileText size={12} />{f.name}</a>)}
    </div>
  );
}
const shortUrl = (u: string) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return u; } };

function NoteBox({ note, disabled, onSave }: { note: string; disabled?: boolean; onSave: (n: string) => void }) {
  const [t, setT] = useState(note);
  useEffect(() => setT(note), [note]);
  return <textarea className="textarea pr-note" rows={2} placeholder="Add a note" aria-label="Note" value={t} disabled={disabled}
    onChange={(e) => setT(e.target.value)} onBlur={() => { if (t !== note) onSave(t); }} />;
}

function Thumbs({ files }: { files: FileItem[] }) {
  return <div className="pr-thumbs">{files.map((f) => f.thumb_url
    ? <a key={f.id} href={f.url} target="_blank" rel="noopener noreferrer"><img src={f.thumb_url} alt={f.name} /></a>
    : <a key={f.id} href={f.url} target="_blank" rel="noopener noreferrer" className="chip"><Paperclip size={12} />{f.name}</a>)}</div>;
}

function PhotoButton({ label, onUploaded, accept = "image/*" }: { label: string; onUploaded: (f: FileItem) => void; accept?: string }) {
  const ref = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const go = async (f: File | undefined) => {
    if (!f) return;
    setBusy(true); setErr("");
    try { onUploaded(await upload(f)); } catch (x) { setErr((x as Error).message); } finally { setBusy(false); }
  };
  return <DropZone className="row-inline" multiple={false} accept={accept} disabled={busy} label="Drop to add" onFiles={(fs) => void go(fs[0])}>
    <input ref={ref} type="file" accept={accept} hidden multiple={false} onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; void go(f); }} />
    <button type="button" className="linkbtn small" disabled={busy} onClick={() => ref.current?.click()}><Camera size={13} />{busy ? "Uploading…" : label}</button>
    {err && <span className="small" style={{ color: "var(--c-danger)" }}>{err}</span>}
  </DropZone>;
}

function Choice({ options, value, onPick, disabled, tone }: { options: { key: string; label: string; icon?: React.ReactNode }[]; value: unknown; onPick: (k: string) => void; disabled?: boolean; tone?: boolean }) {
  return (
    <div className={"pr-choices" + (tone ? " tone" : "")} role="radiogroup">
      {options.map((o) => (
        <button key={o.key} type="button" role="radio" aria-checked={value === o.key} disabled={disabled}
          className={"pr-choice " + o.key + (value === o.key ? " on" : "")} onClick={() => onPick(o.key)}>{o.icon}{o.label}</button>))}
    </div>
  );
}

function BlurInput({ value, onCommit, type = "text", disabled, unit, ...rest }: { value: string; onCommit: (v: string) => void; type?: string; disabled?: boolean; unit?: string; min?: number; max?: number; "aria-label": string; step?: string }) {
  const [t, setT] = useState(value);
  useEffect(() => setT(value), [value]);
  const commit = () => { if (t !== value) onCommit(t); };
  return <div className="pr-num"><Input type={type} value={t} disabled={disabled} onChange={(e) => setT(e.target.value)} onBlur={commit}
    onKeyDown={(e) => { if (e.key === "Enter" && type !== "textarea") (e.target as HTMLInputElement).blur(); }} {...rest} />{unit && <span className="muted small">{unit}</span>}</div>;
}

export function FieldInput({ item, answer, disabled, preview, onSave }: Omit<Props, "tz" | "refs">) {
  const v = answer?.value;
  const t = item.type;
  if (t === "checkbox") return (
    <label className={"pr-check" + (v === true ? " on" : "")}>
      <input type="checkbox" checked={v === true} disabled={disabled} onChange={(e) => onSave({ value: e.target.checked })} />
      <span>{item.label}{item.required && <span className="pr-req" aria-label="required">*</span>}</span>
    </label>);
  if (t === "text") return <TextAnswer value={typeof v === "string" ? v : ""} disabled={disabled} label={item.label} onCommit={(s) => onSave({ value: s })} />;
  if (t === "number" || t === "amount") return (
    <BlurInput type="number" step="any" aria-label={item.label} value={v === null || v === undefined ? "" : String(v)} disabled={disabled}
      unit={t === "amount" ? item.unit || "$" : item.unit} min={item.min} max={item.max} onCommit={(s) => onSave({ value: s === "" ? null : Number(s) })} />);
  if (t === "inspection") return <Choice tone disabled={disabled} value={v} onPick={(k) => onSave({ value: v === k ? null : k })}
    options={[{ key: "pass", label: "Pass", icon: <Check size={16} /> }, { key: "flag", label: "Flag", icon: <Flag size={15} /> }, { key: "fail", label: "Fail", icon: <X size={16} /> }]} />;
  if (t === "yes_no_na") return <Choice disabled={disabled} value={v} onPick={(k) => onSave({ value: v === k ? null : k })}
    options={[{ key: "yes", label: "Yes" }, { key: "no", label: "No" }, { key: "na", label: "N/A" }]} />;
  if (t === "multiple_choice") return <Choice disabled={disabled} value={v} onPick={(k) => onSave({ value: v === k ? null : k })}
    options={(item.options ?? []).map((o) => ({ key: o, label: o }))} />;
  if (t === "checklist") {
    const sel = Array.isArray(v) ? (v as string[]) : [];
    return <div className="pr-checklist">{(item.options ?? []).map((o) => (
      <label key={o} className={"pr-check" + (sel.includes(o) ? " on" : "")}><input type="checkbox" disabled={disabled} checked={sel.includes(o)}
        onChange={(e) => onSave({ value: e.target.checked ? [...sel, o] : sel.filter((x) => x !== o) })} /><span>{o}</span></label>))}</div>;
  }
  if (t === "date") return <BlurInput type={item.with_time ? "datetime-local" : "date"} aria-label={item.label} disabled={disabled}
    value={typeof v === "string" ? (item.with_time ? v.slice(0, 16) : v.slice(0, 10)) : ""} onCommit={(s) => onSave({ value: s || null })} />;
  if (t === "file") {
    const files = answer?.files ?? [];
    return <div className="stack" style={{ gap: 6 }}>
      {files.length > 0 && <div className="pr-thumbs">{files.map((f) => (
        <span key={f.id} className="pr-thumb">{f.thumb_url ? <a href={f.url} target="_blank" rel="noopener noreferrer"><img src={f.thumb_url} alt={f.name} /></a>
          : <a href={f.url} target="_blank" rel="noopener noreferrer" className="chip"><Paperclip size={12} />{f.name}</a>}
          {!disabled && <button type="button" className="pr-thumb-x" aria-label={`Remove ${f.name}`} onClick={() => onSave({ file_ids: files.filter((x) => x.id !== f.id).map((x) => x.id) })}><X size={12} /></button>}
        </span>))}</div>}
      {!disabled && !preview ? <div><PhotoButton label="Add pictures or files" accept="image/*,application/pdf,.doc,.docx,.xls,.xlsx,.csv,.txt"
        onUploaded={(f) => onSave({ file_ids: [...files.map((x) => x.id), f.id] })} /></div>
        : !files.length && <div className="pr-placeholder"><Camera size={16} />Pictures and files</div>}
    </div>;
  }
  if (t === "signature") return <SignatureAnswer value={v as { file_id: string; name: string; signed_at: string } | null} disabled={disabled} preview={preview} onSave={onSave} />;
  if (t === "meter_reading") {
    const mv = v as { value: number; unit: string; level?: string } | null;
    return <div className="row wrap" style={{ gap: 8 }}><Gauge size={16} className="faint" />
      <BlurInput type="number" step="any" aria-label={item.label} disabled={disabled || (!item.meter_id && !preview)} value={mv ? String(mv.value) : ""} unit={mv?.unit}
        onCommit={(s) => onSave({ value: s === "" ? null : { value: Number(s) } })} />
      {mv?.level && mv.level !== "normal" && <span className={"pr-result " + (mv.level === "alarm" ? "fail" : "flag")}>{mv.level === "alarm" ? "Alarm" : "Warning"}</span>}
      {!item.meter_id && !preview && <span className="small faint">No meter picked in the procedure</span>}
    </div>;
  }
  if (t === "location_check_in") return <CheckIn item={item} answer={answer} disabled={disabled} preview={preview} onSave={onSave} />;
  return <div className="small faint">{FIELD_LABEL[t]}</div>;
}

function TextAnswer({ value, disabled, label, onCommit }: { value: string; disabled?: boolean; label: string; onCommit: (s: string) => void }) {
  const [t, setT] = useState(value);
  useEffect(() => setT(value), [value]);
  return <textarea className="textarea" rows={2} aria-label={label} value={t} disabled={disabled} placeholder="Type your answer"
    onChange={(e) => setT(e.target.value)} onBlur={() => { if (t !== value) onCommit(t); }} />;
}

function SignatureAnswer({ value, disabled, preview, onSave }: { value: { file_id: string; name: string; signed_at: string } | null; disabled?: boolean; preview?: boolean; onSave: (b: SaveBody) => Promise<unknown> | void }) {
  const [redo, setRedo] = useState(false);
  const [data, setData] = useState<string | null>(null);
  const [name, setName] = useState("");
  if (value && !redo) return (
    <div className="row wrap" style={{ alignItems: "flex-end", gap: 12 }}>
      <img src={`/api/v1/files/${value.file_id}`} alt={`Signature of ${value.name}`} className="sig-img" />
      <div className="small muted">Signed by <b>{value.name}</b><br />{dateTime(value.signed_at)}</div>
      {!disabled && <button type="button" className="linkbtn small" onClick={() => setRedo(true)}>Sign again</button>}
    </div>);
  if (disabled) return <div className="pr-placeholder">Not signed</div>;
  return (
    <div className="stack" style={{ gap: 6 }}>
      <SignaturePad onChange={setData} />
      <div className="row wrap" style={{ gap: 6 }}>
        <Input placeholder="Name (optional)" aria-label="Signed by" value={name} onChange={(e) => setName(e.target.value)} style={{ maxWidth: 240 }} />
        <Button size="sm" variant="primary" disabled={!data || preview} onClick={async () => { await onSave({ signature: data, signed_by: name }); setRedo(false); }}>Save signature</Button>
        {redo && <Button size="sm" variant="ghost" onClick={() => setRedo(false)}>Cancel</Button>}
      </div>
    </div>);
}

function CheckIn({ item, answer, disabled, preview, onSave }: { item: Item; answer?: Answer; disabled?: boolean; preview?: boolean; onSave: (b: SaveBody) => Promise<unknown> | void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [skipping, setSkipping] = useState(false);
  const [reason, setReason] = useState("");
  const v = answer?.value as { lat?: number; lng?: number; distance_m?: number; accuracy?: number; skipped?: boolean; reason?: string; note?: string } | null | undefined;
  const locate = () => {
    if (!navigator.geolocation) { setErr("This device can't share its location."); return; }
    setBusy(true); setErr("");
    navigator.geolocation.getCurrentPosition(async (pos) => {
      try { await onSave({ value: { lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: pos.coords.accuracy } }); }
      catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
    }, (e) => { setBusy(false); setErr(e.code === 1 ? "Location access was denied. Allow it in your browser settings, or skip the check-in." : "Your position couldn't be found. Try again outdoors or near a window."); },
    { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 });
  };
  if (v && v.skipped) return <div className="row wrap small" style={{ gap: 8 }}><span className="pr-result flag">Skipped</span>{v.reason && <span className="muted">{v.reason}</span>}
    {!disabled && <button type="button" className="linkbtn small" onClick={locate}>Check in instead</button>}</div>;
  if (v && v.lat !== undefined) return <div className="row wrap small" style={{ gap: 8 }}><span className="pr-result pass"><MapPin size={13} />Checked in</span>
    <span className="muted">{v.distance_m !== undefined ? `${Math.round(v.distance_m)} m from the location` : v.note}</span>
    {!disabled && <button type="button" className="linkbtn small" onClick={locate} disabled={busy}>Check in again</button>}</div>;
  return (
    <div className="stack" style={{ gap: 6 }}>
      <div className="row wrap" style={{ gap: 8 }}>
        <Button size="sm" variant="primary" onClick={locate} disabled={disabled || busy || preview}><LocateFixed size={15} />{busy ? "Finding you…" : "Check in"}</Button>
        <span className="small faint">Within {item.buffer_m ?? 10} m of the work order's location</span>
        {item.allow_skip !== false && !disabled && !preview && <button type="button" className="linkbtn small" onClick={() => setSkipping(true)}>Skip</button>}
      </div>
      {skipping && <div className="row wrap" style={{ gap: 6 }}>
        <Input placeholder="Why are you skipping? (optional)" aria-label="Reason for skipping" value={reason} onChange={(e) => setReason(e.target.value)} style={{ maxWidth: 320 }} />
        <Button size="sm" onClick={async () => { try { await onSave({ value: { skip: true, reason } }); setSkipping(false); } catch (e) { setErr((e as Error).message); } }}>Skip check-in</Button>
      </div>}
      {err && <div className="small" style={{ color: "var(--c-danger)" }}>{err}</div>}
    </div>);
}
