// Asset Hub (0.5.0, r115): OEM equipment packages — asset type, fields, spare parts, procedures and work order
// templates for a manufacturer's model range — plus suggestions for existing assets that match. Admins only.
import { useRef, useState } from "react";
import { DropZone } from "../../components/DropZone";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Boxes, Check, PackageCheck, Upload, X } from "lucide-react";
import { api, ApiError, getCsrf } from "../../lib/api";
import { useSession } from "../../lib/session";
import { timeAgo } from "../../lib/format";
import { useToast } from "../../components/Toast";
import { Button, EmptyState, ListSkeleton, Modal, Pill } from "../../components/ui";
import "../../styles/external.css";

type Pkg = {
  id: string; key: string; name: string; manufacturer: string; model: string; models: string[]; version: string; description: string; notice: string;
  source: "builtin" | "imported"; installed: boolean; installed_at: string | null; includes: Record<"fields" | "parts" | "procedures" | "templates", number>;
  asset_type: string; matches: Partial<Record<"suggested" | "applied" | "dismissed", number>>; matching_assets: number;
};
type PkgDetail = Pkg & {
  contents: { fields: { name: string; type: string }[]; parts: { name: string; unit: string; unit_cost: string; description: string }[];
    procedures: { name: string; category: string; fields: number }[]; templates: { name: string; title: string }[] };
};
export type PkgMatch = { id: string; status: string; package: { id: string; name: string; manufacturer: string; model: string };
  asset: { id: string; name: string; manufacturer: string; model: string }; adds: { asset_type: string; parts: number } };

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

function useMatchActions(onDone: () => void) {
  const { toast } = useToast();
  const fail = (e: unknown) => toast((e as ApiError).message, { kind: "error" });
  const apply = useMutation({ mutationFn: (m: PkgMatch) => api(`/asset-package-matches/${m.id}/apply`, { method: "POST" }),
    onSuccess: (_d, m) => { toast(`Applied ${m.package.name} to ${m.asset.name}`); onDone(); }, onError: fail });
  const dismiss = useMutation({ mutationFn: (m: PkgMatch) => api(`/asset-package-matches/${m.id}/dismiss`, { method: "POST" }), onSuccess: onDone, onError: fail });
  return { apply, dismiss };
}

function MatchRow({ m, apply, dismiss, showAsset = true }: { m: PkgMatch; apply: (m: PkgMatch) => void; dismiss: (m: PkgMatch) => void; showAsset?: boolean }) {
  return (
    <div className="list-row" style={{ alignItems: "center" }}>
      <div className="grow small">
        {showAsset ? <><Link to={`/assets/${m.asset.id}`}><b>{m.asset.name}</b></Link> <span className="muted">{m.asset.manufacturer} {m.asset.model}</span></>
          : <><b>{m.package.name}</b> matches this asset's manufacturer and model.</>}
        <div className="faint">Adds the {m.adds.asset_type} type and links {plural(m.adds.parts, "spare part")}.</div>
      </div>
      <Button size="sm" variant="primary" onClick={() => apply(m)}><Check size={13} />Apply</Button>
      <Button size="sm" variant="ghost" onClick={() => dismiss(m)} aria-label="Dismiss"><X size={14} /></Button>
    </div>
  );
}

/** Suggestions on an asset's page (only for people who manage packages, only when something matches). */
export function AssetPackageSuggestions({ assetId }: { assetId: string }) {
  const { can } = useSession();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["asset", assetId, "package-suggestions"], enabled: can("assets.packages"),
    queryFn: () => api<{ items: PkgMatch[] }>(`/assets/${assetId}/package-suggestions`) });
  const { apply, dismiss } = useMatchActions(() => { qc.invalidateQueries({ queryKey: ["asset", assetId] }); qc.invalidateQueries({ queryKey: ["asset-hub"] }); });
  if (!q.data?.items.length) return null;
  return <div className="banner info stack" style={{ alignItems: "stretch", gap: 4 }}>
    <div className="row"><PackageCheck size={18} /><b className="grow">Asset Hub suggestion</b></div>
    {q.data.items.map((m) => <MatchRow key={m.id} m={m} showAsset={false} apply={(x) => apply.mutate(x)} dismiss={(x) => dismiss.mutate(x)} />)}
  </div>;
}

function PackageDialog({ id, onClose }: { id: string; onClose: () => void }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const d = useQuery({ queryKey: ["asset-hub", id], queryFn: () => api<PkgDetail>(`/asset-packages/${id}`) });
  const matches = useQuery({ queryKey: ["asset-hub", id, "matches"], enabled: !!d.data?.installed,
    queryFn: () => api<{ items: PkgMatch[] }>(`/asset-packages/${id}/matches`) });
  const refresh = () => qc.invalidateQueries({ queryKey: ["asset-hub"] });
  const { apply, dismiss } = useMatchActions(refresh);
  const install = useMutation({
    mutationFn: () => api<{ result: { created: number; linked: number; suggested: number } }>(`/asset-packages/${id}/install`, { method: "POST" }),
    onSuccess: (r) => { refresh(); toast(`Installed: ${r.result.created} created, ${r.result.linked} already there${r.result.suggested ? `, ${plural(r.result.suggested, "asset")} to review` : ""}`); },
    onError: (e) => toast((e as ApiError).message, { kind: "error" }),
  });
  const del = useMutation({ mutationFn: () => api(`/asset-packages/${id}`, { method: "DELETE" }), onSuccess: () => { refresh(); onClose(); } });
  const p = d.data;
  return (
    <Modal title={p?.name ?? "Package"} width={680} onClose={onClose}
      footer={<>{p?.source === "imported" && <Button variant="ghost" style={{ color: "var(--c-danger)", marginRight: "auto" }} onClick={() => del.mutate()}>Delete package</Button>}
        <Button onClick={onClose}>Close</Button>
        <Button variant="primary" disabled={!p || install.isPending} onClick={() => install.mutate()}>{p?.installed ? "Install again" : "Install"}</Button></>}>
      {!p ? <ListSkeleton rows={4} /> : <div className="stack">
        <div className="small muted">{p.manufacturer} · fits {p.models.join(", ")} · version {p.version}{p.installed_at && ` · installed ${timeAgo(p.installed_at)}`}</div>
        {p.description && <p>{p.description}</p>}
        {p.notice && <div className="banner warning small">{p.notice}</div>}
        <div className="hub-grid">
          <div><h4 className="sec-h">Asset type and fields</h4><ul className="small"><li>{p.asset_type}</li>{p.contents.fields.map((f) => <li key={f.name}>{f.name}</li>)}</ul></div>
          <div><h4 className="sec-h">Spare parts</h4><ul className="small">{p.contents.parts.map((x) => <li key={x.name}>{x.name}</li>)}</ul></div>
          <div><h4 className="sec-h">Procedures</h4><ul className="small">{p.contents.procedures.map((x) => <li key={x.name}>{x.name} <span className="faint">({plural(x.fields, "field")})</span></li>)}</ul></div>
          <div><h4 className="sec-h">Work order templates</h4><ul className="small">{p.contents.templates.map((x) => <li key={x.name}>{x.name}</li>)}</ul></div>
        </div>
        <p className="small muted">Installing creates what you don't have yet and links what you do (by name), so it's safe to run again.</p>
        {p.installed && <div className="stack" style={{ gap: 0 }}>
          <h4 className="sec-h">Matching assets</h4>
          {matches.data?.items.map((m) => <MatchRow key={m.id} m={m} apply={(x) => apply.mutate(x)} dismiss={(x) => dismiss.mutate(x)} />)}
          {matches.data && !matches.data.items.length && <p className="small muted">No assets waiting. Assets with manufacturer {p.manufacturer} and a matching model get a suggestion.</p>}
        </div>}
      </div>}
    </Modal>
  );
}

export function AssetHubPage() {
  const { can } = useSession();
  const qc = useQueryClient();
  const { toast } = useToast();
  const [open, setOpen] = useState<string | null>(null);
  const file = useRef<HTMLInputElement>(null);
  const list = useQuery({ queryKey: ["asset-hub"], enabled: can("assets.packages"), queryFn: () => api<{ items: Pkg[] }>("/asset-packages") });
  const pending = useQuery({ queryKey: ["asset-hub", "suggested"], enabled: can("assets.packages"), queryFn: () => api<{ items: PkgMatch[] }>("/asset-package-matches") });
  const { apply, dismiss } = useMatchActions(() => qc.invalidateQueries({ queryKey: ["asset-hub"] }));
  const importFile = async (f: File) => {
    const fd = new FormData();
    fd.append("file", f);
    const res = await fetch("/api/v1/asset-packages", { method: "POST", body: fd, credentials: "same-origin", headers: { "X-CSRF-Token": getCsrf() } });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { toast(data.message || "Couldn't import that package.", { kind: "error" }); return; }
    qc.invalidateQueries({ queryKey: ["asset-hub"] });
    toast(`Imported ${data.name}`);
    setOpen(data.id);
  };
  if (!can("assets.packages")) return <div className="page"><EmptyState title="Asset Hub">Only administrators can install asset packages.</EmptyState></div>;
  return (
    <div className="page stack">
      <Link to="/assets" className="row small"><ArrowLeft size={14} />Assets</Link>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <div><h1>Asset Hub</h1><p className="muted small" style={{ margin: 0 }}>Ready-made equipment packages: asset type, fields, spare parts, procedures and work order templates.</p></div>
        <DropZone inline accept="application/json,.json" multiple={false} label="Drop a package file" onFiles={(fs) => void importFile(fs[0])}><div className="row">
          <Button onClick={() => file.current?.click()}><Upload size={14} />Import package</Button>
          <input ref={file} type="file" accept="application/json,.json" hidden onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void importFile(f); }} />
        </div></DropZone>
      </div>
      {(pending.data?.items.length ?? 0) > 0 && <section className="card">
        <div className="card-head"><h2>Suggested for your assets</h2><span className="small muted">{plural(pending.data!.items.length, "asset")}</span></div>
        {pending.data!.items.map((m) => <MatchRow key={m.id} m={m} apply={(x) => apply.mutate(x)} dismiss={(x) => dismiss.mutate(x)} />)}
      </section>}
      {list.isLoading ? <ListSkeleton rows={4} /> : <div className="hub-cards">
        {(list.data?.items ?? []).map((p) => (
          <button key={p.id} type="button" className="card card-pad hub-card" onClick={() => setOpen(p.id)}>
            <div className="row"><Boxes size={18} className="faint" /><b className="grow">{p.name}</b>{p.installed ? <Pill tone="success">Installed</Pill> : p.source === "imported" ? <Pill>Imported</Pill> : null}</div>
            <div className="small muted">{p.manufacturer} · {p.models.slice(0, 4).join(", ")}{p.models.length > 4 ? "…" : ""}</div>
            <div className="small">{plural(p.includes.parts, "part")} · {plural(p.includes.procedures, "procedure")} · {plural(p.includes.templates, "template")}</div>
            {p.matching_assets > 0 && <div className="small"><Pill tone="info">{plural(p.matching_assets, "of your assets")} match</Pill></div>}
          </button>))}
      </div>}
      {open && <PackageDialog id={open} onClose={() => setOpen(null)} />}
    </div>
  );
}
