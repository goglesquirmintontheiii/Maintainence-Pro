// Settings › QR codes and labels: every code, blank codes to tag equipment first, assign/move/retire.
import { useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Ban, MoveRight, Plus, Printer, QrCode, ScanLine } from "lucide-react";
import "../../styles/scan.css";
import { api, ApiError } from "../../lib/api";
import type { Meter, Paged, QrCodeItem } from "../../lib/assets";
import { useSession } from "../../lib/session";
import { dateTime } from "../../lib/format";
import { useToast } from "../../components/Toast";
import { Button, Checkbox, EmptyState, Field, Input, ListSkeleton, Modal, Pill, Select } from "../../components/ui";
import { AssetPicker, LocationPicker } from "../../components/assetPickers";
import { LabelDialog } from "../../components/LabelDialog";
import { ScanSettingsCard } from "./ScanSettings";

type State = "all" | "unassigned" | "assigned" | "retired";

export function QrCodesPage() {
  const { can, session } = useSession();
  const tz = session.org?.timezone;
  const qc = useQueryClient();
  const { toast } = useToast();
  const [state, setState] = useState<State>("all");
  const [batch, setBatch] = useState("");
  const [page, setPage] = useState(1);
  const [sel, setSel] = useState<string[]>([]);
  const [making, setMaking] = useState(false);
  const [printing, setPrinting] = useState<string[] | null>(null);
  const [moving, setMoving] = useState<QrCodeItem | null>(null);
  const [retiring, setRetiring] = useState<QrCodeItem | null>(null);
  const list = useQuery({ queryKey: ["qr-codes", state, batch, page], placeholderData: (p) => p,
    queryFn: () => api<Paged<QrCodeItem>>(`/qr-codes?state=${state}&per_page=100&page=${page}${batch ? `&batch=${encodeURIComponent(batch)}` : ""}`), enabled: can("qr.manage") });
  const retire = useMutation({ mutationFn: (c: QrCodeItem) => api(`/qr-codes/${c.id}/retire`, { method: "POST" }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["qr-codes"] }); setRetiring(null); toast("Code retired. Scanning it now says so."); },
    onError: (e) => toast((e as ApiError).message, { kind: "error" }) });
  if (!can("qr.manage")) return <EmptyState title="QR codes">You don't have permission to manage QR codes.</EmptyState>;
  const items = list.data?.items ?? [];
  const total = list.data?.total ?? 0;
  const blanks = items.filter((c) => !c.entity_id && !c.retired);
  return (
    <div className="stack">
      <div className="page-head">
        <div><h1>QR codes and labels</h1>
          <p className="sub">Every record can carry an MPro QR code; existing barcodes and other systems' labels can be linked too. Print a sheet of blank codes, stick them on equipment, then scan each one to assign it.</p></div>
        <div className="row">
          <Link to="/scan" className="btn"><ScanLine size={15} />Scan</Link>
          <Button variant="primary" onClick={() => setMaking(true)}><Plus size={15} />Blank codes</Button>
        </div>
      </div>
      <ScanSettingsCard />
      <div className="row wrap">
        <div className="seg" role="radiogroup" aria-label="Show">{(["all", "unassigned", "assigned", "retired"] as const).map((s) => (
          <button key={s} type="button" role="radio" aria-checked={state === s} className={"seg-btn" + (state === s ? " on" : "")} onClick={() => { setState(s); setPage(1); setSel([]); }}>
            {s[0].toUpperCase() + s.slice(1)}</button>))}</div>
        <Input aria-label="Batch" placeholder="Batch (e.g. 20261022-0930…)" value={batch} onChange={(e) => { setBatch(e.target.value); setPage(1); }} style={{ width: 220 }} />
        <span className="grow" />
        {sel.length > 0 && <Button onClick={() => setPrinting(sel)}><Printer size={15} />Print {sel.length} label{sel.length === 1 ? "" : "s"}</Button>}
      </div>
      <section className="card">
        {list.isLoading ? <ListSkeleton /> : items.length === 0 ? <EmptyState icon={<QrCode size={26} />} title="No codes here">
          {state === "unassigned" ? "Make a batch of blank codes to tag equipment first." : "Codes appear when labels are printed or barcodes are linked."}</EmptyState> : (
          <div className="table-wrap"><table className="table">
            <thead><tr>
              <th style={{ width: 36 }}>{blanks.length > 0 && <Checkbox checked={blanks.every((c) => sel.includes(c.id))} indeterminate={sel.length > 0 && !blanks.every((c) => sel.includes(c.id))}
                onChange={(c) => setSel(c ? blanks.map((x) => x.id) : [])} label={<span className="sr-only">Select all blank codes</span>} />}</th>
              <th>Code</th><th>On</th><th className="desktop-only">Batch</th><th className="desktop-only">Created</th><th /></tr></thead>
            <tbody>{items.map((c) => (
              <tr key={c.id} className={c.retired ? "qr-retired" : ""}>
                <td>{!c.entity_id && !c.retired && <Checkbox checked={sel.includes(c.id)} onChange={(v) => setSel((s) => (v ? [...s, c.id] : s.filter((x) => x !== c.id)))} label={<span className="sr-only">Select {c.value}</span>} />}</td>
                <td><span className="mono qr-val">{c.value.length > 40 ? c.value.slice(0, 40) + "…" : c.value}</span>
                  <div className="row" style={{ gap: 4, marginTop: 2 }}>{c.kind === "external" && <Pill tone="info">{c.symbology === "other" ? "Barcode" : c.symbology.toUpperCase()}</Pill>}
                    {c.retired && <Pill tone="danger">Retired</Pill>}{c.note && <span className="small faint">{c.note}</span>}</div></td>
                <td>{c.target ? <Link to={c.target.url}>{c.target.label}</Link> : c.entity_id ? <span className="faint">Deleted record</span> : <span className="faint">Not assigned</span>}</td>
                <td className="small desktop-only">{c.batch || "—"}</td>
                <td className="small desktop-only">{dateTime(c.created_at, tz)}</td>
                <td style={{ whiteSpace: "nowrap", textAlign: "right" }}>{!c.retired && <>
                  {c.kind === "mpro" && <Button size="sm" variant="ghost" icon aria-label={`Print ${c.value}`} title="Print label" onClick={() => setPrinting([c.id])}><Printer size={14} /></Button>}
                  <Button size="sm" variant="ghost" icon aria-label={c.entity_id ? `Move ${c.value}` : `Assign ${c.value}`} title={c.entity_id ? "Move" : "Assign"} onClick={() => setMoving(c)}><MoveRight size={14} /></Button>
                  <Button size="sm" variant="ghost" icon aria-label={`Retire ${c.value}`} title="Retire" onClick={() => setRetiring(c)}><Ban size={14} /></Button></>}</td>
              </tr>))}</tbody></table></div>)}
      </section>
      {total > 100 && <div className="row" style={{ justifyContent: "center" }}>
        <Button size="sm" disabled={page === 1} onClick={() => setPage((p) => p - 1)}>Previous</Button><span className="small muted">Page {page} of {Math.ceil(total / 100)}</span>
        <Button size="sm" disabled={page * 100 >= total} onClick={() => setPage((p) => p + 1)}>Next</Button></div>}
      {making && <MakeBlanks onClose={() => setMaking(false)} onMade={(ids, b) => { setMaking(false); setState("unassigned"); setBatch(b); setPrinting(ids); }} />}
      {printing && <LabelDialog entityType="asset" codeIds={printing} onClose={() => { setPrinting(null); setSel([]); }} />}
      {moving && <MoveCode code={moving} onClose={() => setMoving(null)} />}
      {retiring && <Modal title={`Retire ${retiring.value}?`} onClose={() => setRetiring(null)} footer={<><Button onClick={() => setRetiring(null)}>Cancel</Button>
        <Button variant="danger" disabled={retire.isPending} onClick={() => retire.mutate(retiring)}>Retire</Button></>}>
        <p>Scanning this code will say it was retired instead of opening {retiring.target?.label ?? "anything"}. Do this when a label is damaged, lost or replaced.</p></Modal>}
    </div>
  );
}

function MakeBlanks({ onClose, onMade }: { onClose: () => void; onMade: (ids: string[], batch: string) => void }) {
  const qc = useQueryClient();
  const [count, setCount] = useState("30");
  const [note, setNote] = useState("");
  const [err, setErr] = useState("");
  const m = useMutation({ mutationFn: () => api<{ items: QrCodeItem[]; batch: string }>("/qr-codes", { method: "POST", body: { count: Number(count), note } }),
    onSuccess: (r) => { qc.invalidateQueries({ queryKey: ["qr-codes"] }); onMade(r.items.map((c) => c.id), r.batch); }, onError: (e) => setErr((e as ApiError).message) });
  return (
    <Modal title="Make blank QR codes" onClose={onClose} footer={<><span className="grow small" role="alert" style={{ color: "var(--c-danger)" }}>{err}</span>
      <Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={m.isPending} onClick={() => m.mutate()}>Make and print</Button></>}>
      <div className="stack">
        <p className="muted" style={{ margin: 0 }}>Tag first, assign later: stick the labels on equipment, then scan each one and pick the asset.</p>
        <Field label="How many" hint="Up to 1,000. 30 fills an Avery 5160 sheet.">{(id) => <Input id={id} type="number" min={1} max={1000} value={count} onChange={(e) => setCount(e.target.value)} style={{ width: 120 }} />}</Field>
        <Field label="Note" hint="Shown when the code is scanned before it's assigned">{(id) => <Input id={id} maxLength={200} value={note} placeholder="e.g. Line 2 walk-down" onChange={(e) => setNote(e.target.value)} />}</Field>
      </div>
    </Modal>
  );
}

function MoveCode({ code, onClose }: { code: QrCodeItem; onClose: () => void }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { can } = useSession();
  const [type, setType] = useState<"asset" | "location" | "meter">((code.entity_type as "asset") ?? "asset");
  const [target, setTarget] = useState<string | null>(null);
  const [err, setErr] = useState("");
  const meters = useQuery({ queryKey: ["meter-pick"], queryFn: () => api<Paged<Meter>>("/meters?per_page=500"), enabled: type === "meter" && can("meters.view") });
  const m = useMutation({ mutationFn: () => api(`/qr-codes/${code.id}/assign`, { method: "POST", body: { entity_type: type, entity_id: target, move: !!code.entity_id } }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["qr-codes"] }); toast(code.entity_id ? "Code moved" : "Code assigned"); onClose(); }, onError: (e) => setErr((e as ApiError).message) });
  return (
    <Modal title={code.entity_id ? `Move ${code.value}` : `Assign ${code.value}`} onClose={onClose} footer={<><span className="grow small" role="alert" style={{ color: "var(--c-danger)" }}>{err}</span>
      <Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!target || m.isPending} onClick={() => m.mutate()}>{code.entity_id ? "Move" : "Assign"}</Button></>}>
      <div className="stack">
        {code.target && <p className="muted" style={{ margin: 0 }}>Now on {code.target.label}.</p>}
        <Field label="Put it on">{(id) => <Select id={id} value={type} onChange={(e) => { setType(e.target.value as typeof type); setTarget(null); }}>
          <option value="asset">An asset</option><option value="location">A location</option><option value="meter">A meter</option></Select>}</Field>
        {type === "asset" && <AssetPicker value={target ? [target] : []} onChange={(v) => setTarget(v[0] ?? null)} exclude={code.entity_id ? [code.entity_id] : []} />}
        {type === "location" && <LocationPicker value={target} onChange={setTarget} exclude={code.entity_id ? [code.entity_id] : []} />}
        {type === "meter" && <Select aria-label="Meter" value={target ?? ""} onChange={(e) => setTarget(e.target.value || null)}>
          <option value="">Pick a meter</option>{(meters.data?.items ?? []).filter((x) => x.id !== code.entity_id).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</Select>}
      </div>
    </Modal>
  );
}
