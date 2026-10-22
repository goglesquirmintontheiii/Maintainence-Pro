// What a scanned value points at, and what to do when it isn't assigned yet. Shared by /scan and /q/:code.
import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useMutation, useQuery } from "@tanstack/react-query";
import { AlertTriangle, Boxes, Gauge, MapPin, QrCode, Search } from "lucide-react";
import { api, ApiError } from "../../lib/api";
import type { Meter, Paged, QrCodeItem, ScanResult } from "../../lib/assets";
import { useSession } from "../../lib/session";
import { Button, Field, Select } from "../../components/ui";
import { AssetPicker, LocationPicker } from "../../components/assetPickers";

export const resolveScan = (value: string) => api<ScanResult>(`/scan?value=${encodeURIComponent(value)}`);

const ICON: Record<string, typeof Boxes> = { asset: Boxes, location: MapPin, meter: Gauge };

export function ScanOutcome({ result, onAgain, againLabel = "Scan again" }: { result: ScanResult; onAgain?: () => void; againLabel?: string }) {
  const nav = useNavigate();
  const { can } = useSession();
  const again = onAgain && <Button onClick={onAgain}>{againLabel}</Button>;
  if (result.status === "found") return null; // the caller navigates
  if (result.status === "several") return (
    <div className="scan-out card card-pad stack">
      <h2 className="sec-h">Several records match</h2>
      <div className="list">{result.results.map((r) => { const Icon = ICON[r.entity_type] ?? Boxes; return (
        <div key={r.entity_id} className="list-row"><Icon size={16} className="faint" /><Link to={r.url} className="grow t">{r.label}</Link>
          {r.entity_type === "asset" && can("wo.create") && <Link className="btn sm" to={`/work-orders?new=1&asset=${r.entity_id}`}>New work order</Link>}</div>); })}</div>
      <div className="row">{again}</div>
    </div>);
  if (result.status === "unassigned") return <AssignCode code={result.code} onDone={(url) => nav(url)} again={again} />;
  const searchTerm = result.status === "unknown" ? result.value : result.code.value;
  return (
    <div className="scan-out card card-pad stack" role="alert">
      <div className="row" style={{ gap: 8 }}><AlertTriangle size={18} color="var(--c-warning)" />
        <h2 className="sec-h" style={{ margin: 0 }}>{result.status === "retired" ? "This label was retired" : "Nothing matches this code"}</h2></div>
      <p className="muted" style={{ margin: 0 }}>{result.status === "retired"
        ? "Someone replaced or removed this QR code. Print a new label from the record, or search for it."
        : <>We couldn't find a record for <span className="mono">{searchTerm.length > 80 ? searchTerm.slice(0, 80) + "…" : searchTerm}</span>. It may belong to another organization, or not be linked yet.</>}</p>
      <div className="row wrap">
        <Button variant="primary" onClick={() => nav(`/assets?q=${encodeURIComponent(searchTerm.slice(0, 100))}`)}><Search size={15} />Search instead</Button>
        {again}
      </div>
    </div>
  );
}

function AssignCode({ code, onDone, again }: { code: QrCodeItem; onDone: (url: string) => void; again: React.ReactNode }) {
  const { can } = useSession();
  const [type, setType] = useState<"asset" | "location" | "meter">("asset");
  const [target, setTarget] = useState<string | null>(null);
  const [err, setErr] = useState("");
  const meters = useQuery({ queryKey: ["meter-pick"], queryFn: () => api<Paged<Meter>>("/meters?per_page=500"), enabled: type === "meter" && can("meters.view") });
  const m = useMutation({
    mutationFn: () => api<QrCodeItem>(`/qr-codes/${code.id}/assign`, { method: "POST", body: { entity_type: type, entity_id: target } }),
    onSuccess: (c) => onDone(c.target?.url ?? (type === "asset" ? `/assets/${target}` : type === "location" ? `/locations/${target}` : `/meters/${target}`)),
    onError: (e) => setErr((e as ApiError).message),
  });
  return (
    <div className="scan-out card card-pad stack">
      <div className="row" style={{ gap: 8 }}><QrCode size={18} /><h2 className="sec-h" style={{ margin: 0 }}>This QR code isn't assigned yet</h2></div>
      <p className="muted" style={{ margin: 0 }}>Code <span className="mono">{code.value}</span>{code.note && <> · {code.note}</>}.{" "}
        {can("qr.manage") ? "Stick it on a piece of equipment, then pick what it belongs to." : "Ask an administrator or technician to assign it."}</p>
      {can("qr.manage") && <>
        <Field label="Assign to">{(id) => <Select id={id} value={type} onChange={(e) => { setType(e.target.value as typeof type); setTarget(null); }}>
          <option value="asset">An asset</option><option value="location">A location</option><option value="meter">A meter</option></Select>}</Field>
        {type === "asset" && <AssetPicker value={target ? [target] : []} onChange={(v) => setTarget(v[0] ?? null)} />}
        {type === "location" && <LocationPicker value={target} onChange={setTarget} />}
        {type === "meter" && <Select aria-label="Meter" value={target ?? ""} onChange={(e) => setTarget(e.target.value || null)}>
          <option value="">Pick a meter</option>{(meters.data?.items ?? []).map((x) => <option key={x.id} value={x.id}>{x.name}{x.asset ? ` (${x.asset.name})` : ""}</option>)}</Select>}
        {err && <div className="small" role="alert" style={{ color: "var(--c-danger)" }}>{err}</div>}
      </>}
      <div className="row wrap">
        {can("qr.manage") && <Button variant="primary" disabled={!target || m.isPending} onClick={() => m.mutate()}>Assign code</Button>}
        {again}
      </div>
    </div>
  );
}
