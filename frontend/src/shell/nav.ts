import {
  Activity, BarChart3, Download, Boxes, Building2, CalendarClock, ClipboardCheck, ClipboardList, Gauge, Home, Inbox, LayoutDashboard,
  MapPin, MessageSquare, Package, QrCode, ScanLine, Settings, ShoppingCart, Tags, Truck, Users, Workflow, type LucideIcon,
} from "lucide-react";

export type NavItem = { id: string; label: string; path: string; icon: LucideIcon; group: string; phase?: string; blurb?: string; perm?: string; keywords?: string };

// Grouped like MaintainX's left navigation (Work / Optimize / Manage). `phase` marks modules that arrive later.
export const NAV: NavItem[] = [
  { id: "overview", label: "Overview", path: "/", icon: Home, group: "" },
  { id: "work-orders", label: "Work Orders", path: "/work-orders", icon: ClipboardList, group: "Work", perm: "wo.view",
    blurb: "Create, assign and complete work orders with statuses, priorities, time and costs, comments and photos.", keywords: "wo tasks jobs todo calendar workload board" },
  { id: "requests", label: "Requests", path: "/requests", icon: Inbox, group: "Work", phase: "0.6.0",
    blurb: "Anyone can report a problem, including from a QR code; approve requests to turn them into work orders." },
  { id: "pm", label: "Preventive Maintenance", path: "/preventive-maintenance", icon: CalendarClock, group: "Work", phase: "0.4.0",
    blurb: "Repeating work orders by calendar or meter readings, with a PM calendar and compliance.", keywords: "pm schedules" },
  { id: "procedures", label: "Procedures", path: "/procedures", icon: ClipboardCheck, group: "Work", phase: "0.4.0",
    blurb: "Checklists with every MaintainX field type, conditional logic and a reusable library.", keywords: "library checklists" },
  { id: "messages", label: "Messages", path: "/messages", icon: MessageSquare, group: "Work", phase: "0.6.0",
    blurb: "Real-time conversations with people, teams and on every work order." },
  { id: "dashboards", label: "Dashboards", path: "/dashboards", icon: LayoutDashboard, group: "Optimize", phase: "0.7.0",
    blurb: "Drag-and-drop dashboards and a TV mode for the shop floor." },
  { id: "reporting", label: "Reporting", path: "/reporting", icon: BarChart3, group: "Optimize", phase: "0.7.0",
    blurb: "MTTR, MTBF, PM compliance, downtime, costs and every export MaintainX offers." },
  { id: "meters", label: "Meters", path: "/meters", icon: Gauge, group: "Optimize", perm: "meters.view",
    blurb: "Hours, miles, cycles and sensor readings that can trigger work automatically.", keywords: "readings sensors thresholds triggers gauges" },
  { id: "automations", label: "Automations", path: "/automations", icon: Workflow, group: "Optimize", phase: "0.4.0",
    blurb: "Rules that create or update work when something happens." },
  { id: "assets", label: "Assets", path: "/assets", icon: Boxes, group: "Manage", perm: "assets.view",
    blurb: "Equipment hierarchy, downtime, QR codes, documents and full work history.", keywords: "equipment machines downtime warranty qr labels" },
  { id: "locations", label: "Locations", path: "/locations", icon: MapPin, group: "Manage", perm: "locations.view",
    blurb: "Sites, buildings and rooms in a hierarchy, with the assets and work in each.", keywords: "sites buildings rooms floor plans" },
  { id: "parts", label: "Parts & Inventory", path: "/parts", icon: Package, group: "Manage", phase: "0.5.0",
    blurb: "Stock per location, minimum quantities, supplier product cards and reordering." },
  { id: "purchase-orders", label: "Purchase Orders", path: "/purchase-orders", icon: ShoppingCart, group: "Manage", phase: "0.5.0",
    blurb: "Approvals, receiving, vendor emails, tax exemptions, receipts and invoices." },
  { id: "vendors", label: "Vendors", path: "/vendors", icon: Truck, group: "Manage", phase: "0.5.0",
    blurb: "Vendors, contacts and customers, linked to assets, parts and purchase orders." },
  { id: "categories", label: "Categories", path: "/categories", icon: Tags, group: "Manage", perm: "wo.view",
    blurb: "Organize work orders by type: Electrical, Safety, Inspection and more.", keywords: "labels tags" },
  { id: "people", label: "Teams & Users", path: "/people", icon: Users, group: "Manage", perm: "teams.view", keywords: "people users members roles invite" },
  { id: "settings", label: "Settings", path: "/settings", icon: Settings, group: "Manage", keywords: "organization audit jobs email outbox work order settings custom fields templates" },
  { id: "scan", label: "Scan a code", path: "/scan", icon: ScanLine, group: "hidden", perm: "org.view", keywords: "qr barcode scanner camera label" },
  { id: "downloads", label: "Download Center", path: "/downloads", icon: Download, group: "hidden", perm: "exports.use", keywords: "exports csv pdf" },
];

export const SETTINGS_NAV = [
  { path: "/settings/organization", label: "Organization", icon: Building2, perm: "org.view" },
  { path: "/settings/work-orders", label: "Work orders", icon: ClipboardList, perm: "wo.view" },
  { path: "/settings/assets", label: "Assets and locations", icon: Boxes, perm: "assets.view" },
  { path: "/settings/qr-codes", label: "QR codes and labels", icon: QrCode, perm: "qr.manage" },
  { path: "/settings/audit-log", label: "Audit log", icon: Activity, perm: "audit.view" },
  { path: "/settings/jobs", label: "Background jobs", icon: Workflow, perm: "jobs.view" },
  { path: "/settings/email", label: "Email outbox", icon: Inbox, perm: "mail.view" },
  { path: "/settings/design-system", label: "Design system", icon: LayoutDashboard },
];
