// /q/:code — what a printed MPro QR label opens. Resolves the code, then goes to the record.
import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Loader2 } from "lucide-react";
import "../../styles/scan.css";
import { ApiError } from "../../lib/api";
import type { ScanResult } from "../../lib/assets";
import { EmptyState } from "../../components/ui";
import { ScanOutcome, resolveScan } from "./resolve";

export function QrResolve() {
  const { code = "" } = useParams();
  const nav = useNavigate();
  const [result, setResult] = useState<ScanResult | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    let live = true;
    resolveScan(code).then((r) => {
      if (!live) return;
      if (r.status === "found") nav(r.url, { replace: true }); else setResult(r);
    }).catch((e) => { if (live) setErr((e as ApiError).message); });
    return () => { live = false; };
  }, [code, nav]);
  return (
    <div className="page scan-page">
      {err ? <EmptyState title="Couldn't open this code">{err}</EmptyState>
        : result ? <><div className="page-head"><h1>QR code <span className="mono">{code}</span></h1></div>
          <ScanOutcome result={result} onAgain={() => nav("/scan")} againLabel="Scan another code" /></>
        : <div className="scan-resolving" role="status"><Loader2 className="spin" size={26} /><span>Opening code <span className="mono">{code}</span>…</span></div>}
    </div>
  );
}
