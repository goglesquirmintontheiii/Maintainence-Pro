// MPro component library: buttons, fields, pills, avatars, modals, menus, empty states, skeletons.
import { useEffect, useId, useRef, useState, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes } from "react";
import { X } from "lucide-react";
import { avatarColor } from "../lib/format";

type BtnProps = ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "danger" | "ghost" | "default"; size?: "sm" | "md" | "lg"; icon?: boolean; block?: boolean };
export function Button({ variant = "default", size = "md", icon, block, className = "", ...rest }: BtnProps) {
  const cls = ["btn", variant !== "default" && variant, size !== "md" && size, icon && "icon", block && "block", className].filter(Boolean).join(" ");
  return <button type="button" className={cls} {...rest} />;
}

export function Field({ label, hint, error, children, className = "" }: { label: string; hint?: string; error?: string; children: (id: string) => ReactNode; className?: string }) {
  const id = useId();
  return (
    <div className={"field " + className}>
      <label htmlFor={id}>{label}</label>
      {children(id)}
      {error ? <span className="err" role="alert">{error}</span> : hint ? <span className="hint">{hint}</span> : null}
    </div>
  );
}

export const Input = (p: InputHTMLAttributes<HTMLInputElement>) => <input {...p} className={"input " + (p.className ?? "")} />;
export const Select = (p: SelectHTMLAttributes<HTMLSelectElement>) => <select {...p} className={"select " + (p.className ?? "")} />;

export const STATUS = { open: "Open", on_hold: "On Hold", in_progress: "In Progress", done: "Done", canceled: "Canceled" } as const;
export function StatusPill({ status, sub }: { status: keyof typeof STATUS; sub?: string }) {
  return <span className={"pill " + status} title={sub || undefined}><span className="dot" />{STATUS[status]}{sub ? <span className="sub">· {sub}</span> : null}</span>;
}
export const PRIORITY = { none: "None", low: "Low", medium: "Medium", high: "High" } as const;
export function PriorityBadge({ priority }: { priority: keyof typeof PRIORITY }) {
  return <span className={"prio " + priority}><span className="bars" aria-hidden="true"><i /><i /><i /></span>{PRIORITY[priority]}</span>;
}
export function Pill({ tone = "neutral", children }: { tone?: "neutral" | "info" | "success" | "warning" | "danger"; children: ReactNode }) {
  return <span className={"pill " + tone}>{children}</span>;
}

export function Avatar({ name, initials, size = "md" }: { name: string; initials?: string; size?: "sm" | "md" | "lg" | "xl" }) {
  const ini = initials ?? name.split(/\s+/).map((p) => p[0]).slice(0, 2).join("").toUpperCase();
  return <span className={"avatar " + (size !== "md" ? size : "")} style={{ background: avatarColor(name) }} title={name} aria-label={name}>{ini}</span>;
}
export function AvatarStack({ people, max = 4 }: { people: { name: string; initials?: string }[]; max?: number }) {
  const extra = people.length - max;
  return (
    <span className="avatars">
      {people.slice(0, max).map((p) => <Avatar key={p.name} name={p.name} initials={p.initials} size="sm" />)}
      {extra > 0 && <span className="avatar sm" style={{ background: "var(--c-text-3)" }}>+{extra}</span>}
    </span>
  );
}

export function Modal({ title, onClose, children, footer, width }: { title: string; onClose: () => void; children: ReactNode; footer?: ReactNode; width?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === "Escape" && !e.defaultPrevented) { e.preventDefault(); onClose(); } };
    window.addEventListener("keydown", k);
    const first = ref.current?.querySelector<HTMLElement>("input, select, textarea, button:not(.modal-x)");
    first?.focus();
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);
  return (
    <div className="overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={title} ref={ref} style={width ? { width: `min(${width}px, 100%)` } : undefined}>
        <div className="modal-head"><h2>{title}</h2><Button variant="ghost" icon className="modal-x" aria-label="Close" onClick={onClose}><X size={18} /></Button></div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

export function useClickAway<T extends HTMLElement>(open: boolean, close: () => void) {
  const ref = useRef<T>(null);
  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) close(); };
    const k = (e: KeyboardEvent) => { if (e.key === "Escape" && !e.defaultPrevented) { e.preventDefault(); close(); } };
    document.addEventListener("mousedown", h);
    document.addEventListener("keydown", k);
    return () => { document.removeEventListener("mousedown", h); document.removeEventListener("keydown", k); };
  }, [open, close]);
  return ref;
}

export function Dropdown({ trigger, children, align = "right", up = false, className = "", width }: { trigger: (open: boolean, toggle: () => void) => ReactNode; children: (close: () => void) => ReactNode; align?: "left" | "right"; up?: boolean; className?: string; width?: number }) {
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);
  const ref = useClickAway<HTMLDivElement>(open, close);
  return (
    <div ref={ref} style={{ position: "relative" }} className={className}>
      {trigger(open, () => setOpen((o) => !o))}
      {open && <div className="menu" role="menu" style={{ [align]: 0, ...(up ? { bottom: "calc(100% + 6px)" } : { top: "calc(100% + 6px)" }), width }}>{children(close)}</div>}
    </div>
  );
}

export function Checkbox({ checked, onChange, label, disabled, indeterminate }: { checked: boolean; onChange: (v: boolean) => void; label?: ReactNode; disabled?: boolean; indeterminate?: boolean }) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { if (ref.current) ref.current.indeterminate = !!indeterminate; }, [indeterminate]);
  return (
    <label className="check">
      <input ref={ref} type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      {label && <span>{label}</span>}
    </label>
  );
}

export function Toggle({ checked, onChange, label, hint, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: ReactNode; hint?: ReactNode; disabled?: boolean }) {
  return (
    <label className="toggle-row">
      <span className="grow"><span className="toggle-label">{label}</span>{hint && <span className="hint">{hint}</span>}</span>
      <input type="checkbox" role="switch" className="switch" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
    </label>
  );
}

export function Drawer({ title, onClose, children, footer, width = 560 }: { title: ReactNode; onClose: () => void; children: ReactNode; footer?: ReactNode; width?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === "Escape" && !e.defaultPrevented && !document.querySelector(".overlay")) { e.preventDefault(); onClose(); } };
    window.addEventListener("keydown", k);
    ref.current?.querySelector<HTMLElement>("input, textarea, select")?.focus();
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);
  return (
    <div className="drawer-wrap" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <aside className="drawer" role="dialog" aria-modal="true" aria-label={typeof title === "string" ? title : "Panel"} ref={ref} style={{ width: `min(${width}px, 100%)` }}>
        <div className="drawer-head"><h2>{title}</h2><Button variant="ghost" icon aria-label="Close" onClick={onClose}><X size={18} /></Button></div>
        <div className="drawer-body">{children}</div>
        {footer && <div className="drawer-foot">{footer}</div>}
      </aside>
    </div>
  );
}

export function EmptyState({ icon, title, children, action }: { icon?: ReactNode; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      {icon && <div className="empty-icon">{icon}</div>}
      <h2>{title}</h2>
      {children && <p>{children}</p>}
      {action}
    </div>
  );
}

export function Skeleton({ w = "100%", h = 14 }: { w?: number | string; h?: number }) {
  return <span className="skeleton" style={{ display: "block", width: w, height: h }} />;
}
export function ListSkeleton({ rows = 6 }: { rows?: number }) {
  return <div aria-busy="true" aria-label="Loading">{Array.from({ length: rows }, (_, i) => (
    <div className="list-row" key={i}><span className="skeleton" style={{ width: 32, height: 32, borderRadius: "50%" }} />
      <div className="grow stack" style={{ gap: 6 }}><Skeleton w="60%" /><Skeleton w="40%" h={11} /></div></div>))}</div>;
}
