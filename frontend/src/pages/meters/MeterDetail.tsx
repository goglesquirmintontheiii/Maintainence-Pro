// One meter: latest reading, record a reading, chart, readings history and triggers.
import { useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, ArrowLeft, Boxes, Camera, Copy, Gauge, MapPin, MoreHorizontal, Pencil, Plus, Printer, Trash2, X, Zap } from "lucide-react";
import { api, ApiError, upload, type FileItem } from "../../lib/api";
import type { ChartData, MeterDetail as MeterDetailT, MeterTrigger, Reading } from "../../lib/assets";
import { useSession } from "../../lib/session";
import { dateTime, timeAgo } from "../../lib/format";
import { toLocalInput } from "../../lib/wo";
import { useToast } from "../../components/Toast";
import { Button, Dropdown, EmptyState, ListSkeleton, Modal, Pill } from "../../components/ui";
import { ClearableDate } from "../../components/assetPickers";
import { LabelDialog } from "../../components/LabelDialog";
import { MeterChart, fmtNum } from "./MeterChart";
import { CopyMeterDialog, MeterForm, TriggerForm } from "./MeterForms";

const RANGES = [[7, "7 days"], [30, "30 days"], [90, "90 days"], [365, "1 year"]] as const;
const FREQ: Record<string, string> = { hour: "hour", day: "day", week: "week", month: "month", year: "year" };

export function LevelBadge({ level }: { level: "" | "warning" | "alarm" }) {
  if (!level) return null;
  return <Pill tone={level === "alarm" ? "danger" : "warning"}><AlertTriangle size={12} />{level === "alarm" ? "Alarm" : "Warning"}</Pill>;
}

export function MeterDetail({ id }: { id: string }) {
  const { can, session } = useSession();
  const tz = session.org?.timezone;
  const qc = useQueryClient();
  const nav = useNavigate();
  const { toast } = useToast();
  const q = useQuery({ queryKey: ["meter", id], queryFn: () => api<MeterDetailT>(`/meters/${id}`) });
  const [days, setDays] = useState<number>(30);
  const range = useMemo(() => { const to = new Date(Date.now() + 60_000); return { to, from: new Date(to.getTime() - days * 86400_000) }; }, [days, q.dataUpdatedAt]);
  const chart = useQuery({ queryKey: ["meter-chart", id, days, q.dataUpdatedAt], queryFn: () => api<ChartData>(`/meters/${id}/chart?days=${days}`), placeholderData: (p) => p });
  const readings = useQuery({ queryKey: ["meter-readings", id, days, q.dataUpdatedAt], queryFn: () => api<{ items: Reading[] }>(`/meters/${id}/readings?days=${days}&limit=200`), placeholderData: (p) => p });
  const [editing, setEditing] = useState(false);
  const [copying, setCopying] = useState(false);
  const [labels, setLabels] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [trigger, setTrigger] = useState<MeterTrigger | "new" | null>(null);
  const refresh = () => { qc.invalidateQueries({ queryKey: ["meter", id] }); qc.invalidateQueries({ queryKey: ["meters"] }); };
  const del = useMutation({ mutationFn: () => api(`/meters/${id}`, { method: "DELETE" }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["meters"] }); toast("Meter deleted"); nav("/meters"); }, onError: (e) => toast((e as ApiError).message, { kind: "error" }) });
  const delReading = useMutation({ mutationFn: (rid: string) => api(`/meters/${id}/readings/${rid}`, { method: "DELETE" }),
    onSuccess: () => { refresh(); toast("Reading deleted"); }, onError: (e) => toast((e as ApiError).message, { kind: "error" }) });
  const delTrigger = useMutation({ mutationFn: (tid: string) => api(`/meters/${id}/triggers/${tid}`, { method: "DELETE" }),
    onSuccess: () => { refresh(); toast("Trigger deleted"); }, onError: (e) => toast((e as ApiError).message, { kind: "error" }) });

  if (q.isError) return <EmptyState icon={<Gauge size={26} />} title="Meter not found">It may have been deleted, or you don't have access to it.</EmptyState>;
  if (!q.data) return <div className="detail"><ListSkeleton rows={4} /></div>;
  const m = q.data;
  return (
    <div className="detail wo-detail meter-detail">
      <Link to="/meters" className="row small mobile-only"><ArrowLeft size={14} />All meters</Link>
      <div className="wo-head">
        <div className="grow">
          <div className="row small muted wrap" style={{ gap: 8 }}>
            {m.asset && <Link to={`/assets/${m.asset.id}`} className="row" style={{ gap: 4 }}><Boxes size={13} />{m.asset.name}</Link>}
            {m.location && <Link to={`/locations/${m.location.id}`} className="row" style={{ gap: 4 }}><MapPin size={13} />{m.location.name}</Link>}
            {m.monitoring_point && <span>· {m.monitoring_point.name}</span>}
          </div>
          <h1 className="wo-title">{m.name}</h1>
          <div className="row wrap" style={{ marginTop: 6 }}>
            <LevelBadge level={m.level} />
            {m.overdue && <Pill tone="warning">Reading overdue</Pill>}
            {m.meter_type === "automated" && <Pill tone="info">Automated</Pill>}
          </div>
        </div>
        <div className="row">
          {can("meters.manage") && <Button onClick={() => setEditing(true)} aria-label="Edit"><Pencil size={15} /><span className="desktop-only">Edit</span></Button>}
          <Dropdown trigger={(_, t) => <Button icon aria-label="More actions" onClick={t}><MoreHorizontal size={18} /></Button>} width={230}>
            {(close) => <>
              {can("meters.manage") && <button className="menu-item" onClick={() => { close(); setCopying(true); }}><Copy size={15} />Copy meter…</button>}
              <button className="menu-item" onClick={() => { close(); setLabels(true); }}><Printer size={15} />Print QR label…</button>
              {can("meters.delete") && <><div className="menu-sep" /><button className="menu-item" style={{ color: "var(--c-danger)" }} onClick={() => { close(); setConfirmDelete(true); }}><Trash2 size={15} />Delete</button></>}
            </>}
          </Dropdown>
        </div>
      </div>

      <div className="mstat-row">
        <div className="card tile"><div className="k">Last reading</div>
          <div className={"v" + (m.level === "alarm" ? " danger" : m.level === "warning" ? " warning" : "")}>{m.last_value === null ? "—" : fmtNum(m.last_value)} <span className="unit">{m.unit}</span></div>
          <div className="small muted">{m.last_reading_at ? <span title={dateTime(m.last_reading_at, tz)}>{timeAgo(m.last_reading_at)}</span> : "No readings yet"}</div></div>
        <div className="card tile"><div className="k">Next reading due</div>
          <div className={"v sm" + (m.overdue ? " warning" : "")}>{m.next_reading_due ? dateTime(m.next_reading_due, tz) : "No schedule"}</div>
          <div className="small muted">{m.reading_frequency === "none" ? "Readings whenever needed" : `Every ${m.frequency_interval > 1 ? m.frequency_interval + " " : ""}${FREQ[m.reading_frequency]}${m.frequency_interval > 1 ? "s" : ""}`}</div></div>
        <div className="card tile"><div className="k">Limits</div>
          <div className="small mlims">
            <span>Warning {m.warning_low ?? "—"} to {m.warning_high ?? "—"}</span>
            <span>Alarm {m.alarm_low ?? "—"} to {m.alarm_high ?? "—"}</span></div></div>
      </div>

      {can("meters.read") && <RecordReading meter={m} onSaved={refresh} />}

      <section className="card">
        <div className="card-head"><h2>Readings</h2>
          <div className="seg" role="radiogroup" aria-label="Range">{RANGES.map(([d, l]) => (
            <button key={d} type="button" role="radio" aria-checked={days === d} className={"seg-btn" + (days === d ? " on" : "")} onClick={() => setDays(d)}>{l}</button>))}</div>
        </div>
        <div className="card-body stack">
          {chart.data ? <MeterChart data={chart.data} from={range.from} to={range.to} tz={tz} /> : <ListSkeleton rows={3} />}
          <ReadingsTable items={readings.data?.items ?? []} unit={m.unit} tz={tz} canDelete={can("meters.manage")} onDelete={(rid) => delReading.mutate(rid)} />
        </div>
      </section>

      <section className="card">
        <div className="card-head"><h2>Triggers</h2>{can("meters.manage") && <Button size="sm" onClick={() => setTrigger("new")}><Plus size={14} />Add trigger</Button>}</div>
        {m.triggers.length === 0 ? <div className="card-body small faint">Create work orders automatically when a reading crosses a value, or every so many {m.unit}.</div> : (
          <div className="table-wrap"><table className="table">
            <thead><tr><th>Trigger</th><th>Creates</th><th>Fired</th><th /></tr></thead>
            <tbody>{m.triggers.map((t) => (
              <tr key={t.id}>
                <td><div className="row" style={{ gap: 6 }}><Zap size={14} className={t.active ? "" : "faint"} /><b>{t.name}</b>{!t.active && <Pill>Paused</Pill>}</div>
                  <div className="small muted">{t.kind === "threshold" ? `Reading ${t.comparator === "gt" ? "above" : "below"} ${t.threshold} ${m.unit}` : `Every ${t.every_units} ${m.unit}${t.next_at !== null ? ` · next at ${t.next_at}` : ""}`}</div></td>
                <td>{String(t.work_order.title ?? `${m.name}: ${t.name}`)}<div className="small muted">{t.work_order.priority ? `Priority ${t.work_order.priority}` : ""}</div></td>
                <td className="small">{t.fired_count} time{t.fired_count === 1 ? "" : "s"}{t.last_fired_at && <div className="faint">{timeAgo(t.last_fired_at)}</div>}{t.last_note && <div className="faint">{t.last_note}</div>}</td>
                <td style={{ whiteSpace: "nowrap", textAlign: "right" }}>{can("meters.manage") && <>
                  <Button size="sm" variant="ghost" icon aria-label={`Edit ${t.name}`} onClick={() => setTrigger(t)}><Pencil size={14} /></Button>
                  <Button size="sm" variant="ghost" icon aria-label={`Delete ${t.name}`} onClick={() => delTrigger.mutate(t.id)}><Trash2 size={14} /></Button></>}</td>
              </tr>))}</tbody></table></div>)}
      </section>

      {m.description && <section><h3 className="sec-h">Description</h3><p className="prewrap">{m.description}</p></section>}

      {editing && <MeterForm edit={m} onClose={() => setEditing(false)} onSaved={() => setEditing(false)} />}
      {copying && <CopyMeterDialog meter={m} onClose={() => setCopying(false)} onDone={(ids) => { setCopying(false); if (ids.length === 1) nav(`/meters/${ids[0]}`); }} />}
      {trigger && <TriggerForm meter={m} edit={trigger === "new" ? undefined : trigger} onClose={() => setTrigger(null)} />}
      {labels && <LabelDialog entityType="meter" ids={[m.id]} onClose={() => setLabels(false)} />}
      {confirmDelete && <Modal title="Delete meter?" onClose={() => setConfirmDelete(false)} footer={<><Button onClick={() => setConfirmDelete(false)}>Cancel</Button>
        <Button variant="danger" onClick={() => del.mutate()} disabled={del.isPending}>Delete</Button></>}>
        <p>“{m.name}” and its triggers stop working. Its readings are kept.</p></Modal>}
    </div>
  );
}

function RecordReading({ meter, onSaved }: { meter: MeterDetailT; onSaved: () => void }) {
  const { toast } = useToast();
  const [value, setValue] = useState("");
  const [when, setWhen] = useState("");
  const [note, setNote] = useState("");
  const [photo, setPhoto] = useState<FileItem | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const fileIn = useRef<HTMLInputElement>(null);
  const save = useMutation({
    mutationFn: () => api<{ reading: Reading }>(`/meters/${meter.id}/readings`, { method: "POST",
      body: { value: value.trim(), recorded_at: when ? new Date(when).toISOString() : undefined, note: note || undefined, file_id: photo?.id } }),
    onSuccess: (r) => {
      setValue(""); setWhen(""); setNote(""); setPhoto(null); setErr(""); onSaved();
      const lv = r.reading.level;
      toast(lv === "alarm" ? `Recorded. ${fmtNum(r.reading.value)} ${meter.unit} is past the alarm limit.` : lv === "warning" ? `Recorded. ${fmtNum(r.reading.value)} ${meter.unit} is past the warning limit.`
        : r.reading.anomaly ? "Recorded. This reading is unusual compared with recent ones." : "Reading recorded", { kind: lv === "alarm" ? "error" : "info" });
    },
    onError: (e) => setErr((e as ApiError).message),
  });
  const pick = async (f: File | undefined) => {
    if (!f) return;
    setBusy(true); setErr("");
    try { setPhoto(await upload(f)); } catch (e) { setErr((e as ApiError).message); } finally { setBusy(false); }
  };
  return (
    <form className="card card-pad mread" onSubmit={(e) => { e.preventDefault(); if (value.trim()) save.mutate(); }} aria-label="Record a reading">
      <div className="mread-main">
        <label className="mread-value">
          <span className="sr-only">Reading in {meter.unit}</span>
          <input className="input" inputMode="decimal" type="number" step="any" placeholder="New reading" value={value} onChange={(e) => setValue(e.target.value)} />
          <span className="unit">{meter.unit}</span>
        </label>
        <Button type="submit" variant="primary" disabled={!value.trim() || save.isPending || busy}>{save.isPending ? "Saving…" : "Record"}</Button>
      </div>
      <div className="mread-more">
        <ClearableDate type="datetime-local" label="time" aria-label="Reading time (leave empty for now)" value={when} max={toLocalInput(new Date().toISOString())} onChange={setWhen} />
        <input className="input" placeholder="Note (optional)" aria-label="Note" maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />
        <input ref={fileIn} type="file" accept="image/*" capture="environment" hidden onChange={(e) => { void pick(e.target.files?.[0]); e.target.value = ""; }} />
        {photo ? <span className="chip">{photo.thumb_url && <img src={photo.thumb_url} alt="" className="mread-thumb" />}{photo.name}
          <Button variant="ghost" size="sm" icon aria-label="Remove photo" onClick={() => setPhoto(null)}><X size={12} /></Button></span>
          : <Button onClick={() => fileIn.current?.click()} disabled={busy}><Camera size={15} />{busy ? "Uploading…" : "Photo"}</Button>}
      </div>
      {!when && <div className="small faint">Leave the time empty to record it now.</div>}
      {err && <div className="small" role="alert" style={{ color: "var(--c-danger)" }}>{err}</div>}
    </form>
  );
}

function ReadingsTable({ items, unit, tz, canDelete, onDelete }: { items: Reading[]; unit: string; tz?: string; canDelete: boolean; onDelete: (id: string) => void }) {
  if (!items.length) return null;
  return (
    <div className="table-wrap"><table className="table mreadings">
      <thead><tr><th>When</th><th>Reading</th><th className="desktop-only">By</th><th>Note</th><th /></tr></thead>
      <tbody>{items.map((r) => (
        <tr key={r.id}>
          <td className="small" title={dateTime(r.recorded_at, tz)}>{dateTime(r.recorded_at, tz)}</td>
          <td><b className="tnum">{fmtNum(r.value)}</b> <span className="small muted">{unit}</span>
            <div className="row" style={{ gap: 4, marginTop: 2 }}><LevelBadge level={r.level} />{r.anomaly && <Pill tone="info">Unusual</Pill>}
              {r.source !== "manual" && <span className="small faint">{r.source === "api" ? "API" : "Work order"}</span>}</div></td>
          <td className="small desktop-only">{r.recorded_by ?? "—"}</td>
          <td className="small">{r.note}{r.file_url && <a href={`/api/v1/files/${r.file_id}`} target="_blank" rel="noopener noreferrer"><img src={r.file_url} alt="Reading photo" className="mread-thumb" /></a>}
            {r.work_order_id && <div><Link to={`/work-orders/${r.work_order_id}`}>Work order</Link></div>}</td>
          <td style={{ textAlign: "right" }}>{canDelete && <Button size="sm" variant="ghost" icon aria-label="Delete reading" onClick={() => onDelete(r.id)}><Trash2 size={14} /></Button>}</td>
        </tr>))}</tbody></table></div>
  );
}
