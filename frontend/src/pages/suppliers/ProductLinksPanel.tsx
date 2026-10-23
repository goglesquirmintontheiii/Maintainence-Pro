// 0.5.0 supplier product cards on a part or an asset (MP-084/085/087/088/089).
// Everything shown comes from MPro's own copy: product text is plain text (React escapes it) and pictures are the
// copies saved in MPro's file storage, never the supplier's image address.
import { Fragment, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, BarChart3, ExternalLink, MoreHorizontal, Package, Pencil, Plus, RefreshCw, ShoppingCart, Star, Trash2 } from "lucide-react";
import { api, ApiError } from "../../lib/api";
import { useSession } from "../../lib/session";
import { currency, dateTime, timeAgo } from "../../lib/format";
import { useToast } from "../../components/Toast";
import { Button, Checkbox, Dropdown, Field, Input, Modal, Pill } from "../../components/ui";
import { AVAILABILITY, type CompareRow, type LinkRole, type PricePoint, type Product, type ProductLink, type Recognized } from "./types";
import { PunchOutButton } from "./PunchOut";
import "./suppliers.css";

const ROLE_TITLE: Record<LinkRole, string> = { listing: "Supplier products", spare_part: "Spare parts to buy", purchased_from: "Purchased from" };
const ROLE_EMPTY: Record<LinkRole, string> = {
  listing: "Paste a link to this part on a supplier's site (Grainger, McMaster-Carr, Amazon…) to see its price and stock here.",
  spare_part: "Paste links to spare parts for this asset on supplier sites.",
  purchased_from: "Paste the link to where this asset was bought.",
};

const linksKey = (entityType: string, entityId: string, role?: string) => ["product-links", entityType, entityId, role ?? "all"];

export function ProductLinksPanel({ entityType, entityId, role, canEdit = false }: { entityType: "part" | "asset"; entityId: string; role?: LinkRole; canEdit?: boolean }) {
  const { can } = useSession();
  const r: LinkRole = role ?? (entityType === "part" ? "listing" : "spare_part");
  const q = useQuery({
    queryKey: linksKey(entityType, entityId, r),
    queryFn: () => api<{ items: ProductLink[] }>(`/product-links?entity_type=${entityType}&entity_id=${entityId}&role=${r}`),
    enabled: can("parts.view") || can("assets.view"),
    // keep polling briefly while a newly added product is still being read
    refetchInterval: (query) => (query.state.data?.items.some((l) => l.product?.fetch_status === "pending") ? 3000 : false),
  });
  const [adding, setAdding] = useState(false);
  const [comparing, setComparing] = useState(false);
  const edit = canEdit && can("suppliers.links");
  const items = q.data?.items ?? [];
  if (q.isError) return null;
  return (
    <section className="card">
      <div className="card-head">
        <h3 className="sec-h" style={{ margin: 0 }}>{ROLE_TITLE[r]}</h3>
        <div className="row">
          {items.length > 1 && <Button size="sm" variant="ghost" onClick={() => setComparing(true)}><BarChart3 size={14} />Compare</Button>}
          {r === "listing" && can("po.request") && <PunchOutButton />}
          {edit && <Button size="sm" onClick={() => setAdding(true)}><Plus size={14} />Add link</Button>}
        </div>
      </div>
      {q.isLoading ? <div className="card-body small faint">Loading…</div>
        : items.length === 0 ? <div className="card-body small faint">{ROLE_EMPTY[r]}</div>
          : <div className="pl-list">{items.map((l) => <ProductCard key={l.id} link={l} canEdit={edit} queryKey={linksKey(entityType, entityId, r)} />)}</div>}
      {adding && <AddLinkDialog entityType={entityType} entityId={entityId} role={r} onClose={() => setAdding(false)} queryKey={linksKey(entityType, entityId, r)} />}
      {comparing && <CompareDialog entityType={entityType} entityId={entityId} onClose={() => setComparing(false)} />}
    </section>
  );
}

export function ProductCard({ link, canEdit, queryKey, compact }: { link: ProductLink; canEdit: boolean; queryKey: unknown[]; compact?: boolean }) {
  const { session, can } = useSession();
  const { toast } = useToast();
  const qc = useQueryClient();
  const nav = useNavigate();
  const [editing, setEditing] = useState(false);
  const [history, setHistory] = useState(false);
  const [reorder, setReorder] = useState(false);
  const p = link.product;
  const cur = p?.currency || session.org?.currency || "USD";
  const err = (e: unknown) => toast((e as ApiError).message, { kind: "error" });
  const done = () => qc.invalidateQueries({ queryKey });
  const refresh = useMutation({ mutationFn: () => api(`/product-links/${link.id}/refresh`, { method: "POST" }), onSuccess: () => { toast("Checking the supplier's page…"); setTimeout(done, 1500); }, onError: err });
  const prefer = useMutation({ mutationFn: () => api(`/product-links/${link.id}`, { method: "PATCH", body: { preferred: true } }), onSuccess: done, onError: err });
  const del = useMutation({ mutationFn: () => api(`/product-links/${link.id}`, { method: "DELETE" }), onSuccess: () => { done(); toast("Link removed"); }, onError: err });
  const avail = p?.availability ? AVAILABILITY[p.availability] : undefined;
  return (
    <div className="pl-card">
      <ProductImage product={p} />
      <div className="pl-body">
        <a className="pl-title" href={link.url} target="_blank" rel="noopener noreferrer nofollow">{link.title || link.url} <ExternalLink size={12} /></a>
        <div className="pl-meta">
          <span>{link.supplier_name}</span>
          {(link.supplier_sku || link.external_id) && <span className="mono">{link.supplier_sku || link.external_id}</span>}
          {link.mpn && <span>MPN <span className="mono">{link.mpn}</span></span>}
          {link.pack_size && <span>Pack of {Number(link.pack_size)}{link.unit ? ` ${link.unit}` : ""}</span>}
          {link.preferred && !compact && <Pill tone="info">Preferred</Pill>}
          {avail && <Pill tone={avail.tone}>{avail.label}</Pill>}
        </div>
        <div className="row" style={{ gap: 12, flexWrap: "wrap" }}>
          {link.price && <span className="pl-price">{currency(link.price, cur)}{p?.price_unit ? <span className="small faint"> / {p.price_unit}</span> : null}</span>}
          {link.price_from === "typed" && <span className="small faint">price typed in</span>}
          {link.last_paid_price && <span className="small muted">Last paid {currency(link.last_paid_price, session.org?.currency)}</span>}
          {p?.fetched_at && <span className="small faint" title={dateTime(p.fetched_at)}>Checked {timeAgo(p.fetched_at)}</span>}
        </div>
        {p?.price_may_have_changed && p.price && <div className="pl-note"><AlertTriangle size={13} />Price may have changed: last checked over a day ago.</div>}
        {p?.fetch_status === "pending" && <div className="small faint">Reading the supplier's page…</div>}
        {(p?.fetch_status === "blocked" || p?.fetch_status === "failed") && <div className="small faint">{p.fetch_error || "Couldn't read this page."} The link still works.</div>}
        {p?.availability === "discontinued" && <div className="pl-note danger"><AlertTriangle size={13} />Discontinued.
          {p.replacement_url && <> <a href={p.replacement_url} target="_blank" rel="noopener noreferrer nofollow">See the replacement</a></>}</div>}
        {link.note && <div className="small muted">{link.note}</div>}
      </div>
      <div className="pl-actions">
        {link.entity_type === "part" && can("po.request") && <Button size="sm" onClick={() => setReorder(true)}><ShoppingCart size={14} />Reorder</Button>}
        {!link.preferred && canEdit && link.role !== "purchased_from" && <Button size="sm" variant="ghost" icon title="Make preferred" aria-label="Make preferred" onClick={() => prefer.mutate()}><Star size={15} /></Button>}
        {link.preferred && !compact && link.role !== "purchased_from" && <Star size={15} className="pl-star" aria-label="Preferred" />}
        <Dropdown trigger={(_o, t) => <Button size="sm" variant="ghost" icon aria-label="More" onClick={t}><MoreHorizontal size={16} /></Button>}>
          {(close) => <>
            <button className="menu-item" onClick={() => { close(); setHistory(true); }}><BarChart3 size={15} />Price history</button>
            {canEdit && <button className="menu-item" onClick={() => { close(); refresh.mutate(); }}><RefreshCw size={15} />Check now</button>}
            {canEdit && <button className="menu-item" onClick={() => { close(); setEditing(true); }}><Pencil size={15} />Edit</button>}
            {canEdit && <><div className="menu-sep" /><button className="menu-item" style={{ color: "var(--c-danger)" }} onClick={() => { close(); del.mutate(); }}><Trash2 size={15} />Remove link</button></>}
          </>}
        </Dropdown>
      </div>
      {editing && <EditLinkDialog link={link} onClose={() => setEditing(false)} queryKey={queryKey} />}
      {history && p && <HistoryDialog link={link} product={p} onClose={() => setHistory(false)} />}
      {reorder && <ReorderDialog link={link} onClose={() => setReorder(false)} onDone={(url) => { setReorder(false); nav(url); }} />}
    </div>
  );
}

export function ProductImage({ product }: { product: Product | null }) {
  const src = product?.thumb_url || product?.image_url;
  const [broken, setBroken] = useState(false);
  return <div className="pl-img">{src && !broken ? <img src={src} alt="" loading="lazy" onError={() => setBroken(true)} /> : <Package size={24} />}</div>;
}

function AddLinkDialog({ entityType, entityId, role, onClose, queryKey }: { entityType: string; entityId: string; role: LinkRole; onClose: () => void; queryKey: unknown[] }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [url, setUrl] = useState("");
  const [title, setTitle] = useState("");
  const [price, setPrice] = useState("");
  const [packSize, setPackSize] = useState("");
  const [error, setError] = useState("");
  const rec = useQuery({
    queryKey: ["recognize", url],
    queryFn: () => api<Recognized>("/suppliers/recognize", { method: "POST", body: { url } }),
    enabled: url.trim().length > 6, retry: false, staleTime: 60_000,
  });
  const add = useMutation({
    mutationFn: () => api<ProductLink>("/product-links", { method: "POST", body: { entity_type: entityType, entity_id: entityId, role, url,
      manual_title: title, manual_price: price || null, pack_size: packSize || null } }),
    onSuccess: () => { qc.invalidateQueries({ queryKey }); toast("Link added. Reading the product page…"); onClose(); },
    onError: (e) => setError((e as ApiError).message),
  });
  const m = rec.data;
  return (
    <Modal title="Add a supplier link" onClose={onClose} width={520}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!url.trim() || add.isPending} onClick={() => add.mutate()}>Add link</Button></>}>
      <div className="stack">
        <Field label="Product link" error={error}>{(id) => <Input id={id} autoFocus placeholder="https://www.grainger.com/product/…" value={url} onChange={(e) => { setUrl(e.target.value); setError(""); }} />}</Field>
        {m && <div className="small muted">
          {m.supplier_key === "other" ? "Not a supplier MPro knows yet. It will still try to read the page."
            : <>{m.supplier_name}{m.external_id && <> · {m.id_label || "Item"} <span className="mono">{m.external_id}</span></>}{m.needs_resolving && " · short link, opened to find the product"}</>}
        </div>}
        {rec.isError && <div className="small" style={{ color: "var(--c-danger)" }}>{(rec.error as ApiError).message}</div>}
        <div className="small faint">Some sites block automatic readers. If yours does, the name and price you type below are shown instead.</div>
        <div className="pl-grid2">
          <Field label="Name (optional)">{(id) => <Input id={id} value={title} onChange={(e) => setTitle(e.target.value)} />}</Field>
          <Field label="Price (optional)">{(id) => <Input id={id} inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} />}</Field>
        </div>
        <Field label="Pack size" hint="How many units one purchase gives you.">{(id) => <Input id={id} inputMode="decimal" placeholder="1" value={packSize} onChange={(e) => setPackSize(e.target.value)} />}</Field>
      </div>
    </Modal>
  );
}

function EditLinkDialog({ link, onClose, queryKey }: { link: ProductLink; onClose: () => void; queryKey: unknown[] }) {
  const qc = useQueryClient();
  const [f, setF] = useState({
    supplier_sku: link.supplier_sku, mpn: link.mpn, pack_size: link.pack_size ?? "", unit: link.unit, note: link.note,
    manual_title: link.manual_title, manual_price: link.manual_price ?? "", alert_price_change_pct: link.alert_price_change_pct ?? "",
    alert_out_of_stock: link.alert_out_of_stock,
  });
  const [error, setError] = useState("");
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });
  const save = useMutation({
    mutationFn: () => api(`/product-links/${link.id}`, { method: "PATCH", body: { ...f, pack_size: f.pack_size || null, manual_price: f.manual_price || null,
      alert_price_change_pct: f.alert_price_change_pct || null } }),
    onSuccess: () => { qc.invalidateQueries({ queryKey }); onClose(); },
    onError: (e) => setError((e as ApiError).message),
  });
  return (
    <Modal title="Edit supplier link" onClose={onClose} width={560}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={save.isPending} onClick={() => save.mutate()}>Save</Button></>}>
      <div className="stack">
        {error && <div className="small" style={{ color: "var(--c-danger)" }}>{error}</div>}
        <div className="pl-grid2">
          <Field label="Supplier SKU">{(id) => <Input id={id} value={f.supplier_sku} onChange={set("supplier_sku")} />}</Field>
          <Field label="Manufacturer part number (MPN)">{(id) => <Input id={id} value={f.mpn} onChange={set("mpn")} />}</Field>
          <Field label="Pack size">{(id) => <Input id={id} inputMode="decimal" value={f.pack_size} onChange={set("pack_size")} />}</Field>
          <Field label="Unit">{(id) => <Input id={id} placeholder="each, box, ft" value={f.unit} onChange={set("unit")} />}</Field>
          <Field label="Name if the page can't be read">{(id) => <Input id={id} value={f.manual_title} onChange={set("manual_title")} />}</Field>
          <Field label="Price if the page can't be read">{(id) => <Input id={id} inputMode="decimal" value={f.manual_price} onChange={set("manual_price")} />}</Field>
        </div>
        <Field label="Note">{(id) => <Input id={id} value={f.note} onChange={set("note")} />}</Field>
        <h4 className="sec-h" style={{ margin: "8px 0 0" }}>Alerts</h4>
        <Field label="Email me when the price changes by at least (%)" hint="Leave empty for no price alerts.">{(id) => <Input id={id} inputMode="decimal" placeholder="10" value={f.alert_price_change_pct} onChange={set("alert_price_change_pct")} />}</Field>
        <Checkbox checked={f.alert_out_of_stock} onChange={(v) => setF({ ...f, alert_out_of_stock: v })} label="Email me when it goes out of stock or is discontinued" />
        <div className="small faint">Alerts go to whoever added the link and to the teams on the part.</div>
      </div>
    </Modal>
  );
}

function HistoryDialog({ link, product, onClose }: { link: ProductLink; product: Product; onClose: () => void }) {
  const q = useQuery({ queryKey: ["product-prices", product.id], queryFn: () => api<{ items: PricePoint[] }>(`/products/${product.id}/prices`) });
  const pts = (q.data?.items ?? []).filter((x) => x.price !== null);
  const specs = Object.entries(product.specs || {});
  return (
    <Modal title={link.title || "Price history"} onClose={onClose} width={640} footer={<Button onClick={onClose}>Close</Button>}>
      <div className="stack">
        {q.isLoading ? <div className="small faint">Loading…</div> : pts.length === 0 ? <div className="small faint">No prices recorded yet.</div>
          : <PriceChart points={pts} cur={product.currency || "USD"} />}
        {pts.length > 0 && <div className="small muted">{pts.length} price {pts.length === 1 ? "check" : "checks"} in the last year. Lowest {currency(Math.min(...pts.map((x) => Number(x.price))), product.currency || "USD")}, highest {currency(Math.max(...pts.map((x) => Number(x.price))), product.currency || "USD")}.</div>}
        {specs.length > 0 && <><h4 className="sec-h" style={{ margin: "8px 0 0" }}>Details from the supplier</h4>
          <dl className="pl-specs">{specs.slice(0, 30).map(([k, v]) => <Fragment key={k}><dt>{k}</dt><dd>{v}</dd></Fragment>)}</dl></>}
      </div>
    </Modal>
  );
}

export function PriceChart({ points, cur }: { points: PricePoint[]; cur: string }) {
  const W = 600, H = 180, L = 56, R = 12, T = 12, B = 26;
  const xs = points.map((p) => new Date(p.at).getTime());
  const ys = points.map((p) => Number(p.price));
  const x0 = Math.min(...xs), x1 = Math.max(...xs, x0 + 1);
  const lo = Math.min(...ys), hi = Math.max(...ys);
  const pad = (hi - lo) * 0.15 || hi * 0.1 || 1;
  const y0 = Math.max(0, lo - pad), y1 = hi + pad;
  const sx = (x: number) => L + ((x - x0) / (x1 - x0)) * (W - L - R);
  const sy = (y: number) => T + (1 - (y - y0) / (y1 - y0)) * (H - T - B);
  // a price holds until the next check: draw steps
  let d = "";
  points.forEach((_, i) => { d += i === 0 ? `M${sx(xs[i])},${sy(ys[i])}` : `H${sx(xs[i])}V${sy(ys[i])}`; });
  const ticks = [y0, (y0 + y1) / 2, y1];
  const fmtDate = (t: number) => new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  return (
    <svg className="pl-chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Price over time">
      {ticks.map((t) => <g key={t}><line className="grid" x1={L} x2={W - R} y1={sy(t)} y2={sy(t)} /><text x={L - 6} y={sy(t) + 4} textAnchor="end">{currency(t, cur)}</text></g>)}
      <path className="ln" d={d} />
      {points.map((p, i) => <circle key={p.at + i} className="dot" cx={sx(xs[i])} cy={sy(ys[i])} r={3}><title>{`${dateTime(p.at)}: ${currency(p.price, cur)}`}</title></circle>)}
      <text x={L} y={H - 6}>{fmtDate(x0)}</text>
      <text x={W - R} y={H - 6} textAnchor="end">{fmtDate(x1)}</text>
    </svg>
  );
}

function CompareDialog({ entityType, entityId, onClose }: { entityType: string; entityId: string; onClose: () => void }) {
  const q = useQuery({ queryKey: ["product-compare", entityType, entityId], queryFn: () => api<{ items: CompareRow[] }>(`/product-links/compare?entity_type=${entityType}&entity_id=${entityId}`) });
  return (
    <Modal title="Compare suppliers" onClose={onClose} width={620} footer={<Button onClick={onClose}>Close</Button>}>
      {q.isLoading ? <div className="small faint">Loading…</div> : <>
        <table className="pl-cmp">
          <thead><tr><th>Supplier</th><th>Price per unit</th><th>Stock</th><th /></tr></thead>
          <tbody>{(q.data?.items ?? []).map((r) => <tr key={r.link_id} className={r.best ? "best" : ""}>
            <td>{r.supplier_name}{r.preferred && <span className="small faint"> · preferred</span>}</td>
            <td>{r.unit_price ? currency(r.unit_price, r.currency || "USD") : "—"}</td>
            <td>{r.availability ? AVAILABILITY[r.availability]?.label : <span className="faint">Unknown</span>}</td>
            <td>{r.best && <Pill tone="success">Best price in stock</Pill>}</td></tr>)}</tbody>
        </table>
        <p className="small faint" style={{ marginTop: 12 }}>Prices are divided by the pack size. Currencies aren't converted.</p></>}
    </Modal>
  );
}

function ReorderDialog({ link, onClose, onDone }: { link: ProductLink; onClose: () => void; onDone: (url: string) => void }) {
  const { session } = useSession();
  const line = useQuery({ queryKey: ["po-line", link.id], queryFn: () => api<{ quantity: string; unit_cost: string | null; description: string; vendor_id: string | null }>(`/product-links/${link.id}/po-line`) });
  const [qty, setQty] = useState<string | null>(null);
  const [error, setError] = useState("");
  const quantity = qty ?? line.data?.quantity ?? "1";
  const go = useMutation({
    mutationFn: () => api<{ purchase_order_id: string; url: string }>(`/product-links/${link.id}/reorder`, { method: "POST", body: { quantity } }),
    onSuccess: (r) => onDone(r.url),
    onError: (e) => setError((e as ApiError).message),
  });
  const cost = line.data?.unit_cost;
  return (
    <Modal title="Reorder" onClose={onClose} width={460}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={go.isPending || !line.data} onClick={() => go.mutate()}><ShoppingCart size={14} />Create purchase order</Button></>}>
      <div className="stack">
        <div><div className="pl-title">{link.title}</div><div className="small muted">{link.supplier_name}{link.supplier_sku && ` · ${link.supplier_sku}`}</div></div>
        <Field label="Quantity" hint="Suggested from the part's minimum and maximum stock.">{(id) => <Input id={id} inputMode="decimal" value={quantity} onChange={(e) => setQty(e.target.value)} />}</Field>
        {cost && <div className="small muted">Unit cost {currency(cost, session.org?.currency)} · total {currency(Number(cost) * Number(quantity || 0), session.org?.currency)}</div>}
        <div className="small faint">You can review the purchase order before it's sent to the supplier.</div>
        {error && <div className="small" style={{ color: "var(--c-danger)" }}>{error}</div>}
      </div>
    </Modal>
  );
}
