// What you can do right after a scan (0.6.0, MP-097): the record, what's going on there, and one big button per
// action this person may take. Admins choose whether one action runs straight away (Settings → QR codes).
import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ArrowRight, Boxes, ClipboardCheck, ClipboardList, CloudOff, Gauge, MapPin, Package, Plus, Wrench } from "lucide-react";
import { api, ApiError } from "../../lib/api";
import { useToast } from "../../components/Toast";
import { Button, Pill, StatusPill } from "../../components/ui";
import { recordAction, TYPE_LABEL, type ScanFound } from "./scanApi";

const ICON: Record<string, typeof Boxes> = { asset: Boxes, location: MapPin, part: Package, work_order: ClipboardList, procedure: ClipboardCheck, meter: Gauge };

/** Where a request form lives (F1, Requests). */
export const requestUrl = (r: { entity_type: string; entity_id: string }) => `/requests/new?${r.entity_type}_id=${r.entity_id}`;

export function useScanActions(r: ScanFound) {
  const nav = useNavigate();
  const { toast } = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const [checkedIn, setCheckedIn] = useState(false);
  const ctx = r.context;
  const wos = ctx.work_orders ?? [];
  const keep = async (action: string, woId?: string) => {
    try {
      const { queued } = await recordAction(r, action, woId);
      if (queued) toast("Saved on this phone. It syncs when you're back online.");
    } catch (e) { toast((e as ApiError).message, { kind: "error" }); throw e; }
  };
  const run = async (key: string) => {
    setBusy(key);
    try {
      switch (`${r.entity_type}.${key}`) {
        case "asset.start_wo": {
          const wo = wos.find((w) => w.assigned_to_me) ?? wos.find((w) => w.status === "in_progress") ?? wos[0];
          await keep("start_wo", wo?.id);
          nav(wo ? `/work-orders/${wo.id}` : `/work-orders?new=1&asset=${r.entity_id}`);
          break;
        }
        case "asset.log_meter": {
          const ms = ctx.meters ?? [];
          if (ms.length === 1) nav(`/meters/${ms[0].id}`);
          else nav(`/meters?asset_id=${r.entity_id}`);
          break;
        }
        case "asset.manuals": nav(`/assets/${r.entity_id}#files`); break;
        case "asset.report":
        case "location.report": await keep("report"); nav(requestUrl(r)); break;
        case "location.check_in": await keep("check_in"); setCheckedIn(true); toast(`Checked in at ${r.label}`); break;
        case "part.use": await keep("use"); nav(`/parts/${r.entity_id}?do=adjust`); break;
        case "part.restock": await keep("restock"); nav(`/parts/${r.entity_id}?do=restock`); break;
        case "part.count": await keep("count"); nav(`/parts/${r.entity_id}?do=adjust`); break;
        case "work_order.complete": await keep("complete", r.entity_id); nav(`/work-orders/${r.entity_id}`); break;
        case "procedure.start": {
          const s = await api<{ work_order_id: string; number: number; created: boolean }>("/scan/start-procedure", { method: "POST", body: { procedure_id: r.entity_id } });
          toast(s.created ? `Work order #${s.number} started` : `Continuing work order #${s.number}`);
          nav(`/work-orders/${s.work_order_id}`);
          break;
        }
        case "meter.reading": await keep("reading"); nav(`/meters/${r.entity_id}`); break;
        default: nav(r.url);
      }
    } catch (e) {
      if (e instanceof ApiError) toast(e.message, { kind: "error" });
    } finally { setBusy(null); }
  };
  return { run, busy, checkedIn };
}

export function ScanActions({ result: r, onAgain }: { result: ScanFound; onAgain?: () => void }) {
  const { run, busy, checkedIn } = useScanActions(r);
  const ran = useRef(false);
  useEffect(() => { // the default action runs straight away (once), unless it's "show the choices"
    if (ran.current || r.default_action === "menu" || !r.actions.some((a) => a.key === r.default_action)) return;
    ran.current = true;
    void run(r.default_action);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const Icon = ICON[r.entity_type] ?? Boxes;
  const ctx = r.context;
  return (
    <div className="scan-out card card-pad stack scan-sheet" aria-label="Scan result">
      <div className="row scan-head">
        <span className="scan-ico" aria-hidden><Icon size={22} /></span>
        <div className="grow" style={{ minWidth: 0 }}>
          <div className="small muted">{TYPE_LABEL[r.entity_type] ?? r.entity_type}{ctx.location ? ` · ${ctx.location}` : ""}</div>
          <h2 className="scan-title">{r.limited ? r.label : <Link to={r.url}>{r.label}</Link>}</h2>
        </div>
        {r.offline && <Pill tone="warning"><CloudOff size={13} /> Offline</Pill>}
        {checkedIn && <Pill tone="success">Checked in</Pill>}
      </div>
      {r.limited && <p className="muted small" style={{ margin: 0 }}>Something wrong with it? Report it and the maintenance team will take a look.</p>}

      <div className="scan-acts" role="group" aria-label="What do you want to do?">
        {r.actions.map((a) => (
          <Button key={a.key} size="lg" block variant={a.key === r.default_action || r.actions.length === 1 ? "primary" : "default"}
            disabled={!!busy} onClick={() => void run(a.key)}>{a.label}</Button>))}
        {r.actions.length === 0 && <p className="muted">You can't do anything with this record. Ask an administrator.</p>}
      </div>

      <ScanContextView r={r} />
      {onAgain && <div className="row"><Button onClick={onAgain}>Scan another code</Button></div>}
    </div>
  );
}

function ScanContextView({ r }: { r: ScanFound }) {
  const c = r.context;
  return <>
    {c.work_orders && c.work_orders.length > 0 && (
      <section><h3 className="sec-h">Open work here</h3>
        <div className="list scan-list">{c.work_orders.map((w) => (
          <Link key={w.id} to={`/work-orders/${w.id}`} className="list-row">
            <Wrench size={15} className="faint" />
            <span className="grow"><span className="t">#{w.number} {w.title}</span>{w.assigned_to_me && <span className="s">Assigned to you</span>}</span>
            <StatusPill status={w.status as "open"} />
          </Link>))}</div></section>)}
    {c.assets && c.assets.length > 0 && (
      <section><h3 className="sec-h">Assets here</h3>
        <div className="list scan-list">{c.assets.map((a) => (
          <Link key={a.id} to={`/assets/${a.id}`} className="list-row"><Boxes size={15} className="faint" /><span className="grow t">{a.name}</span><ArrowRight size={14} className="faint" /></Link>))}</div></section>)}
    {r.entity_type === "part" && c.on_hand !== undefined && !c.non_stock && (
      <p className="small muted" style={{ margin: 0 }}>{c.part_number && <><span className="mono">{c.part_number}</span> · </>}{c.on_hand} {c.unit} on hand · {c.available} available</p>)}
    {r.entity_type === "meter" && <p className="small muted" style={{ margin: 0 }}>Last reading: {c.last_value != null ? `${c.last_value} ${c.unit}` : "none yet"}</p>}
    {r.entity_type === "procedure" && c.published === false && <p className="small muted" style={{ margin: 0 }}>This procedure is a draft, so an inspection can't start yet.</p>}
    {r.entity_type === "asset" && (c.work_orders?.length ?? 0) === 0 && r.actions.some((a) => a.key === "start_wo") && (
      <p className="small muted row" style={{ margin: 0, gap: 6 }}><Plus size={14} />No open work on this asset. Starting will create a work order.</p>)}
  </>;
}
