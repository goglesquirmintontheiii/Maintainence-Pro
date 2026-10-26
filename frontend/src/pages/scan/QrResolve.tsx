// /q/:code — what a printed MPro QR label opens. Records the scan and shows what you can do with the record
// (or runs the default action the organization picked for your role).
import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Loader2 } from "lucide-react";
import "../../styles/scan.css";
import { ApiError } from "../../lib/api";
import type { ScanResult } from "../../lib/assets";
import { EmptyState } from "../../components/ui";
import { ScanOutcome } from "./resolve";
import { ScanActions } from "./ScanActions";
import { scanRecord, type ScanFound } from "./scanApi";

export function QrResolve() {
  const { code = "" } = useParams();
  const nav = useNavigate();
  const [result, setResult] = useState<ScanResult | null>(null);
  const [found, setFound] = useState<ScanFound | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    let live = true;
    scanRecord(code, "link").then((r) => {
      if (!live) return;
      if (r.status === "found") setFound(r as ScanFound); else setResult(r as ScanResult);
    }).catch((e) => { if (live) setErr((e as ApiError).message); });
    return () => { live = false; };
  }, [code]);
  return (
    <div className="page scan-page">
      {err ? <EmptyState title="Couldn't open this code">{err}</EmptyState>
        : found ? <ScanActions result={found} onAgain={() => nav("/scan")} />
        : result ? <><div className="page-head"><h1>QR code <span className="mono">{code}</span></h1></div>
          <ScanOutcome result={result} onAgain={() => nav("/scan")} againLabel="Scan another code" /></>
        : <div className="scan-resolving" role="status"><Loader2 className="spin" size={26} /><span>Opening code <span className="mono">{code}</span>…</span></div>}
    </div>
  );
}
