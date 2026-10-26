// /q/:code for someone who isn't signed in (0.6.0, MP-097): a printed label only ever leads to the request form,
// and only when the organization allows it. Otherwise: sign in.
import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { Loader2, QrCode } from "lucide-react";
import "../../styles/scan.css";
import { api, ApiError } from "../../lib/api";
import { LogoMark } from "../../components/Logo";

type Public = { organization: string; entity_type: string; label: string; request_url: string | null };

export function PublicScan() {
  const { code = "" } = useParams();
  const [r, setR] = useState<Public | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    api<Public>(`/public/scan/${encodeURIComponent(code)}`).then((x) => {
      if (x.request_url) window.location.replace(x.request_url); else setR(x);
    }).catch((e) => setErr((e as ApiError).message));
  }, [code]);
  const signIn = `/login?next=${encodeURIComponent(`/q/${code}`)}`;
  return (
    <div className="public-scan">
      <div className="card card-pad stack public-scan-card">
        <div className="row" style={{ gap: 10 }}><LogoMark size={28} /><b>Maintenance Pro</b></div>
        {!r && !err && <div className="scan-resolving" role="status"><Loader2 className="spin" size={22} /><span>Opening the code…</span></div>}
        {r && <>
          <div className="row" style={{ gap: 8 }}><QrCode size={18} /><h1 className="scan-title">{r.label}</h1></div>
          <p className="muted" style={{ margin: 0 }}>{r.organization} hasn't set up a request form yet. If you work there, sign in to see this record.</p>
        </>}
        {err && <><h1 className="scan-title">Sign in to open this code</h1><p className="muted" style={{ margin: 0 }}>{err}</p></>}
        {(r || err) && <Link className="btn primary block" to={signIn}>Sign in</Link>}
      </div>
    </div>
  );
}
