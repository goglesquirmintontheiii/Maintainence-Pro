// 0.5.0 supplier product links: API shapes (mpro/suppliers/services.py).
export type Availability = "" | "in_stock" | "limited" | "out_of_stock" | "discontinued";
export type LinkRole = "listing" | "spare_part" | "purchased_from";

export type Product = {
  id: string; supplier_key: string; supplier_name: string; external_id: string; url: string; title: string; brand: string;
  image_url: string | null; thumb_url: string | null; price: string | null; currency: string; price_unit: string;
  availability: Availability; sku: string; mpn: string; replacement_url: string; specs: Record<string, string>;
  source: string; fetched_at: string | null; fetch_status: "pending" | "ok" | "blocked" | "failed" | string; fetch_error: string;
  price_may_have_changed: boolean;
};

export type ProductLink = {
  id: string; entity_type: "part" | "asset"; entity_id: string; role: LinkRole; url: string; supplier_key: string; supplier_name: string;
  external_id: string; vendor_id: string | null; supplier_sku: string; mpn: string; pack_size: string | null; unit: string; preferred: boolean;
  note: string; manual_title: string; manual_price: string | null; last_paid_price: string | null; alert_price_change_pct: string | null;
  alert_out_of_stock: boolean; title: string; price: string | null; price_from: "site" | "typed" | null; product: Product | null; created_at: string;
};

export type Recognized = { supplier_key: string; supplier_name: string; external_id: string; id_label: string; url: string; needs_resolving: boolean; connector: string };
export type PricePoint = { at: string; price: string | null; currency: string; availability: Availability };
export type CompareRow = { link_id: string; supplier_name: string; unit_price: string | null; currency: string; availability: Availability; preferred: boolean; replacement_url: string; best?: boolean };

export type ConnectorField = { name: string; label: string; secret: boolean; type?: "select" | "file"; options?: [string, string][]; placeholder?: string };
export type ConnectorSpec = { key: string; name: string; supplier_key: string; fields: ConnectorField[]; docs: string; kind: "api" | "punchout"; needs_account: boolean };
export type Connection = {
  id: string; connector: string; connector_name: string; kind: "api" | "punchout"; supplier_key: string; name: string; settings: Record<string, string>;
  secrets_set: Record<string, boolean>; secrets_masked: Record<string, string>; enabled: boolean; last_success_at: string | null;
  last_error_at: string | null; last_error: string; verified: boolean;
};
export type SupplierSite = { id: string; key: string; name: string; category: string; domains: string[]; id_patterns: string[]; id_label: string;
  product_url: string; vendor_id: string | null; enabled: boolean; builtin: boolean };

export const AVAILABILITY: Record<string, { label: string; tone: "success" | "warning" | "danger" | "neutral" }> = {
  in_stock: { label: "In stock", tone: "success" }, limited: { label: "Limited stock", tone: "warning" },
  out_of_stock: { label: "Out of stock", tone: "danger" }, discontinued: { label: "Discontinued", tone: "danger" },
};
