// Scan a QR code or barcode with the camera (or type it, or decode a photo) and open what it belongs to.
import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Camera, CameraOff, CloudOff, Flashlight, History, ImageUp, Keyboard, Loader2, ScanLine } from "lucide-react";
import "../../styles/scan.css";
import { ApiError } from "../../lib/api";
import type { ScanResult } from "../../lib/assets";
import { Button, Input } from "../../components/ui";
import { DropZone } from "../../components/DropZone";
import { useOnline } from "../../lib/offline";
import { ScanOutcome } from "./resolve";
import { ScanActions } from "./ScanActions";
import { AddByScan, parseFor } from "./AddByScan";
import { scanRecord, type ScanFound } from "./scanApi";
import { cameraError, decodeImage, startScanning, type ScanSession } from "./scanner";

const hasCamera = () => !!(navigator.mediaDevices as MediaDevices | undefined)?.getUserMedia;

export function ScanPage() {
  const online = useOnline();
  const [params] = useSearchParams();
  const target = parseFor(params.get("for"));
  const [found, setFound] = useState<ScanFound | null>(null);
  const video = useRef<HTMLVideoElement>(null);
  const session = useRef<ScanSession | null>(null);
  const photoIn = useRef<HTMLInputElement>(null);
  const [state, setState] = useState<"idle" | "starting" | "live" | "error">("idle");
  const [camErr, setCamErr] = useState("");
  const [torchOn, setTorchOn] = useState(false);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ScanResult | null>(null);
  const [msg, setMsg] = useState("");
  const paused = useRef(false);

  const stop = useCallback(() => { session.current?.stop(); session.current = null; setTorchOn(false); }, []);
  const handle = useCallback(async (value: string, source: "camera" | "typed" | "photo" = "camera") => {
    if (paused.current) return;
    paused.current = true; setBusy(true); setMsg(""); setResult(null); setFound(null);
    try {
      const r = await scanRecord(value, source);
      navigator.vibrate?.(60);
      if (r.status === "found") { stop(); setFound(r as ScanFound); return; }
      setResult(r as ScanResult);
    } catch (e) {
      setMsg((e as ApiError).message);
      paused.current = false;
    } finally { setBusy(false); }
  }, [stop]);
  const start = useCallback(async () => {
    if (!video.current) return;
    stop(); setState("starting"); setCamErr("");
    try {
      session.current = await startScanning(video.current, (v) => { void handle(v); });
      setState("live");
    } catch (e) { setCamErr(cameraError(e)); setState("error"); }
  }, [handle, stop]);
  useEffect(() => {
    if (hasCamera()) void start(); else { setCamErr(cameraError(new Error("This browser can't open the camera. Type the code or use a photo instead."))); setState("error"); }
    return () => { session.current?.stop(); session.current = null; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const vis = () => { if (document.hidden) stop(); else if (state === "live" && !session.current) void start(); };
    document.addEventListener("visibilitychange", vis);
    return () => document.removeEventListener("visibilitychange", vis);
  }, [state, start, stop]);
  const again = () => { setResult(null); setFound(null); setMsg(""); paused.current = false; if (!session.current && state !== "error") void start(); };
  const fromPhoto = async (f: File | undefined) => {
    if (!f) return;
    setBusy(true); setMsg(""); paused.current = false;
    const v = await decodeImage(f);
    setBusy(false);
    if (v) void handle(v, "photo"); else setMsg("No QR code or barcode found in that photo. Try a closer, sharper picture.");
  };

  return (
    <div className="page scan-page">
      <div className="page-head"><div><h1>{target ? target.title : "Scan a code"}</h1><p className="sub">{target ? "Scan the code on the asset or location to add it." : "Point the camera at a QR code or barcode on equipment, a location, a part, a meter or a work order."}</p></div>
        <Link to="/scan/history" className="btn ghost"><History size={15} /><span className="desktop-only">Scan history</span></Link></div>
      {!online && <div className="banner warning row" style={{ gap: 8 }}><CloudOff size={16} />You're offline. Codes you've scanned before still open, and what you do is saved until you're back online.</div>}
      <div className={"scan-view" + (state === "live" ? " live" : "")}>
        <video ref={video} playsInline muted aria-label="Camera view" />
        {state === "live" && <div className="scan-frame" aria-hidden="true"><span /><i /></div>}
        {state === "starting" && <div className="scan-msg"><Loader2 className="spin" size={22} />Starting the camera…</div>}
        {state === "error" && <div className="scan-msg"><CameraOff size={26} /><span>{camErr}</span>
          {hasCamera() && <Button onClick={() => void start()}><Camera size={15} />Try again</Button>}</div>}
        {state === "idle" && <div className="scan-msg"><ScanLine size={26} /></div>}
        {busy && <div className="scan-busy" role="status"><Loader2 className="spin" size={18} />Looking it up…</div>}
        {state === "live" && session.current?.torch && (
          <Button className="scan-torch" variant={torchOn ? "primary" : "default"} icon aria-label={torchOn ? "Turn the light off" : "Turn the light on"} aria-pressed={torchOn}
            onClick={async () => { if (await session.current?.torch?.(!torchOn)) setTorchOn(!torchOn); }}><Flashlight size={18} /></Button>)}
      </div>
      {found && (target ? <AddByScan target={target} result={found} onAgain={again} /> : <ScanActions result={found} onAgain={again} />)}
      {result && <ScanOutcome result={result} onAgain={again} />}
      {msg && <div className="banner warning" role="alert">{msg}</div>}
      <form className="scan-manual card card-pad" onSubmit={(e) => { e.preventDefault(); paused.current = false; if (typed.trim()) void handle(typed.trim(), "typed"); }}>
        <label htmlFor="scan-typed" className="row small" style={{ gap: 6, fontWeight: 600 }}><Keyboard size={15} />Type a code, barcode or serial number</label>
        <div className="row" style={{ gap: 8 }}>
          <Input id="scan-typed" value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="e.g. 7KQ2M9XH4P" autoCapitalize="characters" autoComplete="off" />
          <Button type="submit" variant="primary" disabled={!typed.trim() || busy}>Find</Button>
        </div>
        <input ref={photoIn} type="file" accept="image/*" hidden onChange={(e) => { void fromPhoto(e.target.files?.[0]); e.target.value = ""; }} />
        <DropZone multiple={false} accept="image/*" disabled={busy} label="Drop a photo of the code" onFiles={(fs) => void fromPhoto(fs[0])}>
          <Button onClick={() => photoIn.current?.click()} disabled={busy}><ImageUp size={15} />Read a code from a photo</Button></DropZone>
      </form>
    </div>
  );
}
