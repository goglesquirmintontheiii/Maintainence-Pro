// 0.5.0 asset "Spare parts" tab (MP-089): parts used on the asset with their stock and preferred supplier,
// spare parts to buy, and where the asset was purchased.
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../lib/api";
import { useSession } from "../../lib/session";
import { Pill } from "../../components/ui";
import { ProductCard, ProductLinksPanel } from "./ProductLinksPanel";
import type { ProductLink } from "./types";
import "./suppliers.css";

type SparePart = { id: string; name: string; part_number: string; unit: string; on_hand: string; reserved: string; non_stock: boolean; link: ProductLink | null };

export function SparePartsTab({ assetId, canEdit }: { assetId: string; canEdit: boolean }) {
  const { can } = useSession();
  const q = useQuery({ queryKey: ["asset-spare-parts", assetId], queryFn: () => api<{ parts: SparePart[] }>(`/assets/${assetId}/spare-parts`) });
  const parts = q.data?.parts ?? [];
  return (
    <div className="stack">
      {can("parts.view") && <section className="card">
        <div className="card-head"><h3 className="sec-h" style={{ margin: 0 }}>Parts for this asset</h3></div>
        {q.isLoading ? <div className="card-body small faint">Loading…</div>
          : parts.length === 0 ? <div className="card-body small faint">No parts are linked to this asset. Add the asset on a part to see it here.</div>
            : parts.map((p) => <div key={p.id}>
              <Link to={`/parts/${p.id}`} className="list-row">
                <span className="grow"><span className="t">{p.name}</span><span className="s">{[p.part_number, p.non_stock ? "Non-stock" : `${Number(p.on_hand)} ${p.unit || ""} on hand`].filter(Boolean).join(" · ")}</span></span>
                {!p.non_stock && Number(p.on_hand) <= 0 && <Pill tone="danger">Out of stock</Pill>}
              </Link>
              {p.link && <ProductCard link={p.link} canEdit={false} compact queryKey={["asset-spare-parts", assetId]} />}
            </div>)}
      </section>}
      <ProductLinksPanel entityType="asset" entityId={assetId} role="spare_part" canEdit={canEdit} />
      <ProductLinksPanel entityType="asset" entityId={assetId} role="purchased_from" canEdit={canEdit} />
    </div>
  );
}
