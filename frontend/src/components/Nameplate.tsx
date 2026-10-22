// Read an equipment nameplate from a photo, on this device (r594). Tesseract.js runs in a worker; its code, WebAssembly
// core and English model are served from /ocr on our own origin (copied by scripts/copy-ocr.mjs), so it works offline.
import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Camera, ImageUp, Loader2, ScanText } from "lucide-react";
import "../styles/scan.css";
import { api } from "../lib/api";
import { Button, Field, Input, Modal } from "./ui";

export type NameplateResult = { manufacturer: string; model: string; serial_number: string; year: number | null; text: string; file: File };
type Parsed = Omit<NameplateResult, "text" | "file">;

const STOP = /\b(SERIAL|S\/N|SER\.?\s*NO|SN|MODEL|MOD\.?|M\/N|CAT\.?\s*NO|VOLTS?|AMPS?|HZ|PHASE|PH|RPM|HP|KW|PSI|YEAR|MFG|MFD|DATE|TYPE)\b/;

/** Pull manufacturer, model, serial and year out of OCR text. Exported for tests. */
export function parseNameplate(text: string, manufacturers: string[]): Parsed & { confidence: Record<keyof Parsed, "found" | "guess" | "none"> } {
  const lines = text.split(/\r?\n/).map((l) => l.replace(/[|_]+/g, " ").replace(/\s+/g, " ").trim()).filter(Boolean);
  const up = lines.map((l) => l.toUpperCase());
  const after = (re: RegExp, valueRe: RegExp): string => {
    for (let i = 0; i < up.length; i++) {
      const m = re.exec(up[i]);
      if (!m) continue;
      let rest = lines[i].slice(m.index + m[0].length).replace(/^[\s:#.\-=]+/, "");
      const cut = STOP.exec(rest.toUpperCase());
      if (cut && cut.index > 0) rest = rest.slice(0, cut.index);
      if (!rest.trim() && i + 1 < lines.length) rest = lines[i + 1]; // value on the next line
      const v = valueRe.exec(rest.trim());
      if (v) return v[0].replace(/[.,;:]+$/, "").trim();
    }
    return "";
  };
  const model = after(/\b(MODEL\s*(NO\.?|NUMBER|#)?|MOD\.?|M\/N|CAT\.?\s*NO\.?)(?=[\s:#.]|$)/, /^[A-Z0-9][A-Z0-9\-\/. ]{0,30}[A-Z0-9]|^[A-Z0-9]/i)
    .split(" ").slice(0, 3).join(" ");
  const serial = after(/\b(SERIAL\s*(NO\.?|NUMBER|#)?|S\/N|SER\.?\s*NO\.?|SN)(?=[\s:#.]|$)/, /^[A-Z0-9][A-Z0-9\-\/]{2,30}/i);
  let year: number | null = null, yearConf: "found" | "guess" | "none" = "none";
  const yr = (s: string) => { const m = /\b(19[5-9]\d|20[0-3]\d)\b/.exec(s); return m && +m[1] <= 2035 ? +m[1] : null; };
  for (let i = 0; i < up.length && year === null; i++) {
    if (/\b(YEAR|YR|MFG|MFD|MANUFACTURED|DATE|BUILT)\b/.test(up[i])) { year = yr(up[i]) ?? (i + 1 < up.length ? yr(up[i + 1]) : null); if (year) yearConf = "found"; }
  }
  if (year === null) {
    const cleaned = up.join(" ").replace(serial.toUpperCase(), " ").replace(model.toUpperCase(), " ");
    year = yr(cleaned);
    if (year) yearConf = "guess";
  }
  const norm = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, "");
  const flat = norm(text);
  let manufacturer = "";
  for (const name of manufacturers) {
    const n = norm(name);
    if (n.length >= 3 && flat.includes(n) && n.length > norm(manufacturer).length) manufacturer = name;
  }
  return { manufacturer, model, serial_number: serial, year,
    confidence: { manufacturer: manufacturer ? "found" : "none", model: model ? "found" : "none", serial_number: serial ? "found" : "none", year: yearConf } };
}

async function downscale(file: File, max = 1800): Promise<Blob | File> {
  try {
    const bmp = await createImageBitmap(file);
    const s = Math.min(1, max / Math.max(bmp.width, bmp.height));
    if (s === 1) { bmp.close?.(); return file; }
    const c = document.createElement("canvas");
    c.width = Math.round(bmp.width * s); c.height = Math.round(bmp.height * s);
    c.getContext("2d")!.drawImage(bmp, 0, 0, c.width, c.height);
    bmp.close?.();
    return await new Promise<Blob>((res) => c.toBlob((b) => res(b ?? file), "image/png"));
  } catch { return file; }
}

export async function ocrImage(img: Blob | File, onProgress?: (p: number, status: string) => void): Promise<{ text: string; confidence: number }> {
  const T = await import("tesseract.js");
  const worker = await T.createWorker("eng", 1 /* LSTM only */, {
    workerPath: "/ocr/worker.min.js", corePath: "/ocr", langPath: "/ocr", gzip: true, workerBlobURL: false,
    logger: (m: { status: string; progress: number }) => onProgress?.(m.progress, m.status),
  });
  try {
    const r = await worker.recognize(img);
    return { text: r.data.text, confidence: r.data.confidence };
  } finally { await worker.terminate(); }
}

export function NameplateScan({ onResult, onClose }: { onResult: (r: NameplateResult) => void; onClose: () => void }) {
  const cat = useQuery({ queryKey: ["asset-catalog"], queryFn: () => api<{ manufacturers: string[] }>("/asset-catalog"), staleTime: 300_000 });
  const camIn = useRef<HTMLInputElement>(null);
  const fileIn = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState("");
  const [stage, setStage] = useState<"pick" | "reading" | "review" | "error">("pick");
  const [progress, setProgress] = useState({ p: 0, s: "" });
  const [text, setText] = useState("");
  const [conf, setConf] = useState(0);
  const [found, setFound] = useState<ReturnType<typeof parseNameplate>["confidence"] | null>(null);
  const [f, setF] = useState<Parsed>({ manufacturer: "", model: "", serial_number: "", year: null });
  const [err, setErr] = useState("");
  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview); }, [preview]);
  const run = async (picked: File | undefined) => {
    if (!picked) return;
    if (!picked.type.startsWith("image/")) { setErr("Pick a photo of the nameplate."); setStage("error"); return; }
    setFile(picked); setPreview(URL.createObjectURL(picked)); setStage("reading"); setErr(""); setProgress({ p: 0, s: "Loading the text reader" });
    try {
      const r = await ocrImage(await downscale(picked), (p, s) => setProgress({ p, s }));
      const parsed = parseNameplate(r.text, cat.data?.manufacturers ?? []);
      setText(r.text); setConf(Math.round(r.confidence)); setFound(parsed.confidence);
      setF({ manufacturer: parsed.manufacturer, model: parsed.model, serial_number: parsed.serial_number, year: parsed.year });
      setStage("review");
    } catch (e) {
      const m = (e as Error)?.message || String(e);
      setErr(/fetch|load|import|network|wasm|worker/i.test(m)
        ? "The text reader couldn't load on this device. You can still type the details yourself." : `Couldn't read the photo: ${m}`);
      setStage("error");
    }
  };
  const label = (k: keyof Parsed, base: string) => found ? `${base}${found[k] === "none" ? " (not found)" : found[k] === "guess" ? " (best guess)" : ""}` : base;
  const statusText = (s: string) => ({ "loading tesseract core": "Loading the text reader", "initializing tesseract": "Starting up",
    "loading language traineddata": "Loading the English model", "initializing api": "Starting up", "recognizing text": "Reading the nameplate" } as Record<string, string>)[s] ?? s;
  return (
    <Modal title="Read a nameplate" onClose={onClose} width={560}
      footer={stage === "review" ? <><Button onClick={() => { setStage("pick"); setFile(null); }}>Try another photo</Button>
        <Button variant="primary" onClick={() => onResult({ ...f, text, file: file! })}>Use these details</Button></>
        : <Button onClick={onClose}>Cancel</Button>}>
      <div className="stack">
        <input ref={camIn} type="file" accept="image/*" capture="environment" hidden onChange={(e) => { void run(e.target.files?.[0]); e.target.value = ""; }} />
        <input ref={fileIn} type="file" accept="image/*" hidden onChange={(e) => { void run(e.target.files?.[0]); e.target.value = ""; }} />
        {stage === "pick" && <>
          <p className="muted" style={{ margin: 0 }}>Take a straight-on photo of the manufacturer's plate, filling the frame. The text is read on this device; nothing is sent anywhere until you save.</p>
          <div className="row wrap"><Button variant="primary" onClick={() => camIn.current?.click()}><Camera size={15} />Take a photo</Button>
            <Button onClick={() => fileIn.current?.click()}><ImageUp size={15} />Choose a photo</Button></div>
        </>}
        {preview && stage !== "pick" && <img src={preview} alt="Nameplate photo" className="np-photo" />}
        {stage === "reading" && <div className="stack" role="status" aria-live="polite">
          <div className="row" style={{ gap: 8 }}><Loader2 className="spin" size={16} />{statusText(progress.s)}…</div>
          <div className="progress" aria-hidden="true"><span style={{ width: `${Math.round(progress.p * 100)}%` }} /></div>
          <span className="small faint">The first time takes a little longer while the model loads.</span></div>}
        {stage === "error" && <><div className="banner warning" role="alert">{err}</div>
          <div className="row"><Button onClick={() => setStage("pick")}>Try again</Button></div></>}
        {stage === "review" && <>
          <div className={"banner " + (conf >= 70 ? "info" : "warning")}><ScanText size={16} /><div>Read with {conf}% confidence. Check each field against the plate and correct anything that's off.</div></div>
          <div className="form-grid">
            <Field label={label("manufacturer", "Manufacturer")}>{(id) => <><Input id={id} list="np-mfrs" value={f.manufacturer} onChange={(e) => setF({ ...f, manufacturer: e.target.value })} />
              <datalist id="np-mfrs">{(cat.data?.manufacturers ?? []).map((m) => <option key={m} value={m} />)}</datalist></>}</Field>
            <Field label={label("model", "Model")}>{(id) => <Input id={id} value={f.model} onChange={(e) => setF({ ...f, model: e.target.value })} />}</Field>
            <Field label={label("serial_number", "Serial number")}>{(id) => <Input id={id} value={f.serial_number} onChange={(e) => setF({ ...f, serial_number: e.target.value })} />}</Field>
            <Field label={label("year", "Year")}>{(id) => <Input id={id} type="number" min={1800} max={2200} value={f.year ?? ""} onChange={(e) => setF({ ...f, year: e.target.value ? Number(e.target.value) : null })} />}</Field>
          </div>
          <details className="small"><summary>Text read from the photo</summary><pre className="np-text">{text || "(no text found)"}</pre></details>
        </>}
      </div>
    </Modal>
  );
}
