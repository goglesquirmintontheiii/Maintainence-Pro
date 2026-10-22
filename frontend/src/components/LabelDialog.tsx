// Print QR labels: Avery sheets (PDF), single thermal labels (PDF) or Zebra ZPL (MP-096).
import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Printer, QrCode } from "lucide-react";
import "../styles/scan.css";
import { api } from "../lib/api";
import { postForFile, type LabelTemplates } from "../lib/assets";
import { Button, Field, Input, Modal, Select, Toggle } from "./ui";

type Fmt = "sheet" | "thermal" | "zpl";
const NOUN = { asset: "asset", location: "location", meter: "meter" } as const;

function loadPrefs(): { fmt: Fmt; sheet: string; thermal: string } | null {
  try { const v = localStorage.getItem("mpro.labels"); return v ? JSON.parse(v) : null; } catch { return null; }
}

export function LabelDialog({ entityType, ids, query, codeIds, onClose }: {
  entityType: "asset" | "location" | "meter"; ids?: string[]; query?: Record<string, string>; codeIds?: string[]; onClose: () => void;
}) {
  const t = useQuery({ queryKey: ["label-templates"], queryFn: () => api<LabelTemplates>("/labels/templates"), staleTime: Infinity });
  const prefs = useMemo(loadPrefs, []);
  const [fmt, setFmt] = useState<Fmt>(prefs?.fmt ?? "sheet");
  const [sheet, setSheet] = useState(prefs?.sheet ?? "avery_5160");
  const [thermal, setThermal] = useState(prefs?.thermal ?? "zebra_2x1");
  const [start, setStart] = useState(1);
  const [copies, setCopies] = useState(1);
  const [opt, setOpt] = useState({ show_name: !codeIds, show_subtitle: !codeIds, show_code: true, barcode: false, outline: false });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const zebras = (t.data?.thermal ?? []).filter((x) => x.zpl);
  useEffect(() => { if (fmt === "zpl" && zebras.length && !zebras.some((z) => z.id === thermal)) setThermal(zebras[0].id); }, [fmt, zebras, thermal]);
  const sheetT = t.data?.sheets.find((s) => s.id === sheet);
  const thermT = t.data?.thermal.find((s) => s.id === thermal);
  const size = fmt === "sheet" ? sheetT : thermT;
  const count = codeIds?.length ?? ids?.length;
  const what = codeIds ? `${codeIds.length} blank code${codeIds.length === 1 ? "" : "s"}` : count !== undefined
    ? `${count} ${NOUN[entityType]}${count === 1 ? "" : "s"}` : `every ${NOUN[entityType]} matching your filters`;

  const print = async () => {
    setBusy(true); setErr("");
    try { localStorage.setItem("mpro.labels", JSON.stringify({ fmt, sheet, thermal })); } catch { /* private mode */ }
    const body: Record<string, unknown> = { format: fmt, template: fmt === "sheet" ? sheet : thermal, start: fmt === "sheet" ? start : 1, copies, options: opt };
    if (codeIds) body.code_ids = codeIds; else { body.entity_type = entityType; if (ids) body.ids = ids; else body.query = query ?? {}; }
    try { await postForFile("/labels", body, fmt === "zpl" ? "labels.zpl" : "labels.pdf"); onClose(); }
    catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  };
  const cols = sheetT ? sheetT.cols ?? Math.max(1, Math.floor(8 / sheetT.w)) : 3;
  const set = (k: keyof typeof opt) => (v: boolean) => setOpt((o) => ({ ...o, [k]: v }));
  return (
    <Modal title="Print labels" onClose={onClose} width={640}
      footer={<><span className="grow small" role="alert" style={{ color: "var(--c-danger)" }}>{err}</span><Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" onClick={() => void print()} disabled={busy || !t.data}><Printer size={15} />{busy ? "Preparing…" : fmt === "zpl" ? "Download ZPL" : "Print"}</Button></>}>
      <div className="stack">
        <p className="muted" style={{ margin: 0 }}>Labels for {what}.{!codeIds && " Records without a QR code get one."}</p>
        <div className="seg" role="radiogroup" aria-label="Printer">
          {([["sheet", "Label sheets (Avery)"], ["thermal", "Label printer (PDF)"], ["zpl", "Zebra (ZPL)"]] as const).map(([k, l]) => (
            <button key={k} type="button" role="radio" aria-checked={fmt === k} className={"seg-btn" + (fmt === k ? " on" : "")} onClick={() => setFmt(k)}>{l}</button>))}
        </div>
        <div className="lbl-grid">
          <div className="stack">
            {fmt === "sheet" ? (
              <Field label="Sheet">{(id) => <Select id={id} value={sheet} onChange={(e) => { setSheet(e.target.value); setStart(1); }}>
                {(t.data?.sheets ?? []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</Select>}</Field>
            ) : (
              <Field label="Label size" hint={fmt === "zpl" ? "Send the file to the printer, e.g. with the Zebra Setup Utilities or `lp -o raw`." : "One label per page. Pick the same size in the printer driver."}>{(id) => (
                <Select id={id} value={thermal} onChange={(e) => setThermal(e.target.value)}>
                  {(fmt === "zpl" ? zebras : t.data?.thermal ?? []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</Select>)}</Field>)}
            <Field label="Copies of each">{(id) => <Input id={id} type="number" min={1} max={20} value={copies} onChange={(e) => setCopies(Math.max(1, Math.min(20, Number(e.target.value) || 1)))} style={{ width: 90 }} />}</Field>
            <div className="stack" style={{ gap: 10 }}>
              <Toggle checked={opt.show_name} onChange={set("show_name")} label="Name" />
              <Toggle checked={opt.show_subtitle} onChange={set("show_subtitle")} label="Location / serial" />
              <Toggle checked={opt.show_code} onChange={set("show_code")} label="Code under the QR" />
              {fmt !== "zpl" && <Toggle checked={opt.barcode} onChange={set("barcode")} label="Code 128 barcode" hint="On wide labels, for handheld scanners" />}
              {fmt === "sheet" && <Toggle checked={opt.outline} onChange={set("outline")} label="Outline (test print on plain paper)" />}
            </div>
          </div>
          <div className="stack">
            <span className="small muted">Preview</span>
            {size && <LabelPreview w={size.w} h={size.h} opt={opt} sample={codeIds ? "" : entityType === "asset" ? "Air Compressor 2" : entityType === "meter" ? "Run hours" : "Compressor Room"} />}
            {fmt === "sheet" && sheetT && <>
              <span className="small muted" id="lbl-start">Start at label {start} <span className="faint">(skip used labels on a part-used sheet)</span></span>
              <div className="lbl-sheet" role="radiogroup" aria-labelledby="lbl-start" style={{ gridTemplateColumns: `repeat(${cols}, 1fr)`, gridTemplateRows: `repeat(${Math.ceil(sheetT.per_sheet / cols)}, 1fr)`, aspectRatio: "8.5 / 11" }}>
                {Array.from({ length: sheetT.per_sheet }, (_, i) => (
                  <button key={i} type="button" role="radio" aria-checked={start === i + 1} aria-label={`Start at label ${i + 1}`}
                    className={"lbl-cell" + (i + 1 < start ? " used" : "") + (start === i + 1 ? " on" : "")} onClick={() => setStart(i + 1)} />))}
              </div></>}
          </div>
        </div>
      </div>
    </Modal>
  );
}

function LabelPreview({ w, h, opt, sample }: { w: number; h: number; opt: Record<string, boolean>; sample: string }) {
  const stacked = h >= w * 0.9;
  const scale = Math.min(220 / w, 160 / h);
  return (
    <div className={"lbl-prev" + (stacked ? " stacked" : "")} style={{ width: w * scale, height: h * scale }} aria-hidden="true">
      <span className="lbl-qr"><QrCode size={Math.min(w, h) * scale * 0.55} /></span>
      <span className="lbl-text">
        {opt.show_name && sample && <b>{sample}</b>}
        {opt.show_subtitle && sample && <span>Compressor Room · S/N AIF-071144</span>}
        {opt.show_code && <span className="mono">7KQ2M9XH4P</span>}
        {opt.barcode && !stacked && <span className="lbl-bars" />}
      </span>
    </div>
  );
}
