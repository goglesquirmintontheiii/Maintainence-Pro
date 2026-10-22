// TEMPORARY (feedback capture, 0.4.2). Remove by 1.9.0 (2.0.0 at the latest). See ./README.md.
// Describes DOM elements so a capture says *what* was picked without anyone typing "the X button on page Y".

export type Box = { x: number; y: number; w: number; h: number };

export type ElementInfo = {
  selector: string;          // a CSS selector that finds this element on the page
  path: string;              // readable ancestry, e.g. "main.page > section.card > button.btn"
  tag: string;
  id?: string;
  classes?: string[];
  role?: string;
  name?: string;             // accessible name: aria-label, label text, alt, title or text
  text?: string;             // visible text (trimmed)
  attrs?: Record<string, string>;
  sections?: string[];       // headings of the sections it sits in, outermost first
  rect: Box;                 // CSS pixels in the viewport
  style?: Record<string, string>;
  html?: string;             // outerHTML, shortened
  within?: { selector: string; tag: string; name?: string; href?: string; role?: string }; // the link/button it sits in
  box?: Box;                 // area captures: where it is in the screenshot (image pixels)
  n?: number;                // area captures: its number on the screenshot
};

const ROOT_ATTR = "data-mpro-feedback";
export const isOwn = (el: Element | null) => !!el?.closest(`[${ROOT_ATTR}]`);

const clip = (s: string | null | undefined, n: number) => {
  const t = (s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
};

const KEEP_ATTRS = ["name", "type", "href", "placeholder", "title", "alt", "value", "aria-label", "aria-expanded", "aria-selected",
  "aria-pressed", "aria-current", "aria-checked", "aria-disabled", "disabled", "checked", "for", "src", "role", "tabindex"];

function cssEsc(s: string) {
  return typeof CSS !== "undefined" && CSS.escape ? CSS.escape(s) : s.replace(/[^\w-]/g, (c) => "\\" + c);
}

function unique(sel: string) {
  try { return document.querySelectorAll(sel).length === 1; } catch { return false; }
}

function step(el: Element): string {
  const tag = el.tagName.toLowerCase();
  if (el.id && unique("#" + cssEsc(el.id))) return "#" + cssEsc(el.id);
  const test = el.getAttribute("data-testid");
  if (test) return `${tag}[data-testid="${test}"]`;
  const cls = [...el.classList].filter((c) => !/^\d/.test(c)).slice(0, 3).map((c) => "." + cssEsc(c)).join("");
  let s = tag + cls;
  const parent = el.parentElement;
  if (parent) {
    const same = [...parent.children].filter((c) => c.tagName === el.tagName);
    if (same.length > 1) s += `:nth-of-type(${same.indexOf(el) + 1})`;
  }
  return s;
}

export function selectorFor(el: Element): string {
  const parts: string[] = [];
  let cur: Element | null = el;
  while (cur && cur !== document.body && parts.length < 8) {
    const st = step(cur);
    parts.unshift(st);
    const sel = parts.join(" > ");
    if (st.startsWith("#") || unique(sel)) return sel;
    cur = cur.parentElement;
  }
  return parts.join(" > ");
}

function readablePath(el: Element): string {
  const out: string[] = [];
  let cur: Element | null = el;
  while (cur && cur !== document.body && out.length < 7) {
    const tag = cur.tagName.toLowerCase();
    const cls = [...cur.classList].slice(0, 2).join(".");
    out.unshift(tag + (cur.id ? "#" + cur.id : "") + (cls ? "." + cls : ""));
    cur = cur.parentElement;
  }
  return out.join(" > ");
}

export function accessibleName(el: Element): string {
  const aria = el.getAttribute("aria-label");
  if (aria) return clip(aria, 120);
  const by = el.getAttribute("aria-labelledby");
  if (by) {
    const t = by.split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? "").join(" ");
    if (t.trim()) return clip(t, 120);
  }
  if (el instanceof HTMLInputElement || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement) {
    const lab = el.labels?.[0]?.textContent || el.closest("label")?.textContent;
    if (lab) return clip(lab, 120);
    if ("placeholder" in el && el.placeholder) return clip(el.placeholder, 120);
  }
  const alt = el.getAttribute("alt") || el.getAttribute("title");
  if (alt) return clip(alt, 120);
  return clip((el as HTMLElement).innerText ?? el.textContent, 120);
}

const INTERACTIVE = "a[href],button,input,select,textarea,summary,label,[role=button],[role=tab],[role=link],[role=checkbox],[role=switch],[role=menuitem],[role=option],[role=combobox],[contenteditable=true]";
const HEADING = ":scope > :is(h1,h2,h3,h4,h5,h6,legend,[role=heading]), :scope > :is(header,div,.card-head,.head,.panel-head) > :is(h1,h2,h3,h4,h5,h6,[role=heading])";

/** Section headings around an element, outermost first: e.g. ["Work Orders", "Chiller 1 inspection", "Procedures"]. */
export function sectionsOf(el: Element): string[] {
  const out: string[] = [];
  let cur: Element | null = el.parentElement;
  while (cur && cur !== document.body) {
    let label = "";
    try {
      const h = cur.querySelector(HEADING);
      if (h && !h.contains(el)) label = clip(h.textContent, 80);
    } catch { /* old browsers without :is() */ }
    const role = cur.getAttribute("role");
    if (!label && (role === "dialog" || role === "region" || role === "tabpanel" || cur.tagName === "NAV" || cur.tagName === "ASIDE")) {
      label = clip(cur.getAttribute("aria-label") || (role === "tabpanel" && document.getElementById(cur.getAttribute("aria-labelledby") || "")?.textContent) || "", 80);
      if (label && role) label = `${label} (${role})`;
    }
    if (label && out[0] !== label) out.unshift(label);
    cur = cur.parentElement;
  }
  return out.slice(-6);
}

const r = (n: number) => Math.round(n);
const boxOf = (rc: DOMRect): Box => ({ x: r(rc.left), y: r(rc.top), w: r(rc.width), h: r(rc.height) });

function shortHtml(el: Element): string {
  const c = el.cloneNode(true) as Element;
  // drop huge inline data (images, svg paths) so the snippet stays readable
  c.querySelectorAll("svg").forEach((s) => { s.innerHTML = ""; });
  c.querySelectorAll("[src^='data:'], [href^='data:']").forEach((n) => { n.setAttribute(n.hasAttribute("src") ? "src" : "href", "data:…"); });
  const h = c.outerHTML.replace(/\s+/g, " ");
  return h.length > 1500 ? h.slice(0, 1499) + "…" : h;
}

export function describe(el: Element, opts: { html?: boolean; style?: boolean } = {}): ElementInfo {
  const cs = getComputedStyle(el);
  const attrs: Record<string, string> = {};
  for (const a of KEEP_ATTRS) {
    const v = el.getAttribute(a);
    if (v != null) attrs[a] = a === "src" || a === "href" ? clip(v.startsWith("data:") ? "data:…" : v, 160) : clip(v, 120);
  }
  for (const a of el.getAttributeNames()) if (a.startsWith("data-") && a !== ROOT_ATTR) attrs[a] = clip(el.getAttribute(a), 80);
  if (el instanceof HTMLInputElement && el.type !== "password") attrs.value = clip(el.value, 120);
  if (el instanceof HTMLSelectElement) attrs.value = clip(el.selectedOptions[0]?.textContent, 120);
  const info: ElementInfo = {
    selector: selectorFor(el),
    path: readablePath(el),
    tag: el.tagName.toLowerCase(),
    rect: boxOf(el.getBoundingClientRect()),
  };
  if (el.id) info.id = el.id;
  if (el.classList.length) info.classes = [...el.classList];
  const role = el.getAttribute("role");
  if (role) info.role = role;
  const name = accessibleName(el);
  if (name) info.name = name;
  const text = clip((el as HTMLElement).innerText ?? el.textContent, 300);
  if (text && text !== name) info.text = text;
  if (Object.keys(attrs).length) info.attrs = attrs;
  const sec = sectionsOf(el);
  if (sec.length) info.sections = sec;
  if (opts.style !== false) info.style = {
    color: cs.color, background: cs.backgroundColor, font: `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily.split(",")[0]}`,
    display: cs.display, ...(cs.opacity !== "1" ? { opacity: cs.opacity } : {}), ...(cs.visibility !== "visible" ? { visibility: cs.visibility } : {}),
  };
  if (opts.html !== false) info.html = shortHtml(el);
  const host = el.parentElement?.closest(INTERACTIVE);
  if (host && host !== document.body && !isOwn(host)) {
    info.within = { selector: selectorFor(host), tag: host.tagName.toLowerCase() };
    const n = accessibleName(host); if (n) info.within.name = n;
    const href = host.getAttribute("href"); if (href) info.within.href = href;
    const role = host.getAttribute("role"); if (role) info.within.role = role;
  }
  return info;
}

export function shortLabel(el: Element): string {
  const tag = el.tagName.toLowerCase();
  const id = el.id ? "#" + el.id : "";
  const cls = [...el.classList].slice(0, 2).map((c) => "." + c).join("");
  return tag + id + cls;
}

// ---- area captures: which meaningful elements are inside the rectangle

const MEANINGFUL = INTERACTIVE + ",h1,h2,h3,h4,h5,h6,th,img[alt],[role=heading],[role=dialog],[role=alert],[role=status],[aria-label],[data-testid],legend,.badge,.pill,.chip,.tag";

function visible(el: Element, rc: DOMRect) {
  if (rc.width < 2 || rc.height < 2) return false;
  const cs = getComputedStyle(el);
  return cs.visibility !== "hidden" && cs.display !== "none" && cs.opacity !== "0";
}

function ownText(el: Element) {
  let t = "";
  for (const n of el.childNodes) if (n.nodeType === Node.TEXT_NODE) t += n.textContent;
  return t.replace(/\s+/g, " ").trim();
}

/** Up to `max` elements inside `area` (viewport CSS px), with their place in the screenshot (scaled by `scale`). */
export function elementsIn(area: Box, scale: number, max = 60): ElementInfo[] {
  const inside = (rc: DOMRect) => rc.left < area.x + area.w && rc.right > area.x && rc.top < area.y + area.h && rc.bottom > area.y;
  const picked: Element[] = [];
  const all = document.body.querySelectorAll("*");
  for (const el of all) {
    if (isOwn(el)) continue;
    const rc = el.getBoundingClientRect();
    if (!inside(rc) || !visible(el, rc)) continue;
    const meaningful = el.matches(MEANINGFUL) || (ownText(el).length > 0 && ownText(el).length < 200);
    if (!meaningful) continue;
    // skip text inside something already picked (a button's label span, a link's text)
    if (picked.some((p) => p.contains(el) && p.matches(INTERACTIVE))) continue;
    picked.push(el);
    if (picked.length >= max * 2) break;
  }
  const chosen = picked
    .map((el) => ({ el, rc: el.getBoundingClientRect() }))
    .sort((a, b) => (Math.round(a.rc.top / 8) - Math.round(b.rc.top / 8)) || (a.rc.left - b.rc.left))
    .slice(0, max);
  return chosen.map(({ el, rc }, i) => {
    const info = describe(el, { html: false, style: false });
    delete info.sections; // the page-level sections cover these
    const x = Math.max(rc.left, area.x), y = Math.max(rc.top, area.y);
    const x2 = Math.min(rc.right, area.x + area.w), y2 = Math.min(rc.bottom, area.y + area.h);
    info.box = { x: r((x - area.x) * scale), y: r((y - area.y) * scale), w: r((x2 - x) * scale), h: r((y2 - y) * scale) };
    info.n = i + 1;
    return info;
  });
}

/** What page this is: route, title, main heading, the open dialog, the selected tabs and the active nav item. */
export function pageContext() {
  const txt = (sel: string) => clip(document.querySelector(sel)?.textContent, 120) || undefined;
  const dialog = document.querySelector("[role=dialog]:not([data-mpro-feedback] *), dialog[open]");
  const tabs = [...document.querySelectorAll("[role=tab][aria-selected=true]")].filter((t) => !isOwn(t)).map((t) => clip(t.textContent, 60)).filter(Boolean);
  return {
    url: location.href,
    path: location.pathname + location.search + location.hash,
    title: document.title,
    heading: txt("main h1") ?? txt("h1"),
    nav: txt("[aria-current=page]") ?? txt("nav .active"),
    dialog: dialog ? clip(dialog.getAttribute("aria-label") || dialog.querySelector("h1,h2,h3,[role=heading]")?.textContent, 120) || "(open)" : undefined,
    tabs: tabs.length ? tabs : undefined,
    viewport: { w: innerWidth, h: innerHeight },
    dpr: devicePixelRatio,
    theme: document.documentElement.dataset.theme,
    userAgent: navigator.userAgent,
  };
}
