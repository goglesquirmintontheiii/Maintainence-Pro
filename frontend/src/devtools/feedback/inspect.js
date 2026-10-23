// TEMPORARY (feedback capture, 0.4.2). Remove by 1.9.0 (2.0.0 at the latest). See ./README.md.
// Describes DOM elements so a capture says *what* was picked without anyone typing "the X button on page Y".
const ROOT_ATTR = "data-mpro-feedback";
export const isOwn = (el) => !!el?.closest(`[${ROOT_ATTR}]`);
const clip = (s, n) => {
    const t = (s ?? "").replace(/\s+/g, " ").trim();
    return t.length > n ? t.slice(0, n - 1) + "…" : t;
};
const KEEP_ATTRS = ["name", "type", "href", "placeholder", "title", "alt", "value", "aria-label", "aria-expanded", "aria-selected",
    "aria-pressed", "aria-current", "aria-checked", "aria-disabled", "disabled", "checked", "for", "src", "role", "tabindex"];
function cssEsc(s) {
    return typeof CSS !== "undefined" && CSS.escape ? CSS.escape(s) : s.replace(/[^\w-]/g, (c) => "\\" + c);
}
function unique(sel) {
    try {
        return document.querySelectorAll(sel).length === 1;
    }
    catch {
        return false;
    }
}
function step(el) {
    const tag = el.tagName.toLowerCase();
    if (el.id && unique("#" + cssEsc(el.id)))
        return "#" + cssEsc(el.id);
    const test = el.getAttribute("data-testid");
    if (test)
        return `${tag}[data-testid="${test}"]`;
    const cls = [...el.classList].filter((c) => !/^\d/.test(c)).slice(0, 3).map((c) => "." + cssEsc(c)).join("");
    let s = tag + cls;
    const parent = el.parentElement;
    if (parent) {
        const same = [...parent.children].filter((c) => c.tagName === el.tagName);
        if (same.length > 1)
            s += `:nth-of-type(${same.indexOf(el) + 1})`;
    }
    return s;
}
export function selectorFor(el) {
    const parts = [];
    let cur = el;
    while (cur && cur !== document.body && parts.length < 8) {
        const st = step(cur);
        parts.unshift(st);
        const sel = parts.join(" > ");
        if (st.startsWith("#") || unique(sel))
            return sel;
        cur = cur.parentElement;
    }
    return parts.join(" > ");
}
function readablePath(el) {
    const out = [];
    let cur = el;
    while (cur && cur !== document.body && out.length < 7) {
        const tag = cur.tagName.toLowerCase();
        const cls = [...cur.classList].slice(0, 2).join(".");
        out.unshift(tag + (cur.id ? "#" + cur.id : "") + (cls ? "." + cls : ""));
        cur = cur.parentElement;
    }
    return out.join(" > ");
}
export function accessibleName(el) {
    const aria = el.getAttribute("aria-label");
    if (aria)
        return clip(aria, 120);
    const by = el.getAttribute("aria-labelledby");
    if (by) {
        const t = by.split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? "").join(" ");
        if (t.trim())
            return clip(t, 120);
    }
    if (el instanceof HTMLInputElement || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement) {
        const lab = el.labels?.[0]?.textContent || el.closest("label")?.textContent;
        if (lab)
            return clip(lab, 120);
        if ("placeholder" in el && el.placeholder)
            return clip(el.placeholder, 120);
    }
    const alt = el.getAttribute("alt") || el.getAttribute("title");
    if (alt)
        return clip(alt, 120);
    return clip(el.innerText ?? el.textContent, 120);
}
const INTERACTIVE = "a[href],button,input,select,textarea,summary,label,[role=button],[role=tab],[role=link],[role=checkbox],[role=switch],[role=menuitem],[role=option],[role=combobox],[contenteditable=true]";
const HEADING = ":scope > :is(h1,h2,h3,h4,h5,h6,legend,[role=heading]), :scope > :is(header,div,.card-head,.head,.panel-head) > :is(h1,h2,h3,h4,h5,h6,[role=heading])";
/** Section headings around an element, outermost first: e.g. ["Work Orders", "Chiller 1 inspection", "Procedures"]. */
export function sectionsOf(el) {
    const out = [];
    let cur = el.parentElement;
    while (cur && cur !== document.body) {
        let label = "";
        try {
            const h = cur.querySelector(HEADING);
            if (h && !h.contains(el))
                label = clip(h.textContent, 80);
        }
        catch { /* old browsers without :is() */ }
        const role = cur.getAttribute("role");
        if (!label && (role === "dialog" || role === "region" || role === "tabpanel" || cur.tagName === "NAV" || cur.tagName === "ASIDE")) {
            label = clip(cur.getAttribute("aria-label") || (role === "tabpanel" && document.getElementById(cur.getAttribute("aria-labelledby") || "")?.textContent) || "", 80);
            if (label && role)
                label = `${label} (${role})`;
        }
        if (label && out[0] !== label)
            out.unshift(label);
        cur = cur.parentElement;
    }
    return out.slice(-6);
}
const r = (n) => Math.round(n);
const boxOf = (rc) => ({ x: r(rc.left), y: r(rc.top), w: r(rc.width), h: r(rc.height) });
function shortHtml(el) {
    const c = el.cloneNode(true);
    // drop huge inline data (images, svg paths) so the snippet stays readable
    c.querySelectorAll("svg").forEach((s) => { s.innerHTML = ""; });
    c.querySelectorAll("[src^='data:'], [href^='data:']").forEach((n) => { n.setAttribute(n.hasAttribute("src") ? "src" : "href", "data:…"); });
    const h = c.outerHTML.replace(/\s+/g, " ");
    return h.length > 1500 ? h.slice(0, 1499) + "…" : h;
}
// ---- tables and grids: which column (header text) and row (its first cell or row header) an element sits in
const CELL = "td,th,[role=cell],[role=gridcell],[role=columnheader],[role=rowheader]";
// The cell that names a row: a row header, else the first other cell with real text (not just a checkbox or a picture).
function rowLabelCell(cells, mine) {
    const head = cells.find((c) => c.matches("th[scope=row],[role=rowheader]"));
    if (head && head !== mine)
        return head;
    for (const c of cells) {
        if (c === mine)
            return null;
        if (c.querySelector("input[type=checkbox],input[type=radio]") && !cellText(c, 60).replace(/^select\b.*/i, ""))
            continue;
        if (cellText(c))
            return c;
    }
    return null;
}
function cellText(c, n = 60) {
    return c ? clip(c.innerText?.split("\n").find((l) => l.trim()) ?? c.textContent, n) : "";
}
export function tableContext(el) {
    const out = {};
    const cell = el.closest(CELL);
    if (cell && (cell.tagName === "TD" || cell.tagName === "TH") && cell.closest("table")) {
        const tr = cell.parentElement;
        const table = cell.closest("table");
        let idx = 0;
        for (const c of tr.cells) {
            if (c === cell)
                break;
            idx += c.colSpan || 1;
        }
        const headRow = table.tHead?.rows[table.tHead.rows.length - 1] ?? [...table.rows].find((r) => [...r.cells].every((c) => c.tagName === "TH"));
        if (headRow && headRow !== tr) {
            let at = 0;
            for (const h of headRow.cells) {
                const span = h.colSpan || 1;
                if (idx >= at && idx < at + span) {
                    const t = cellText(h) || h.getAttribute("aria-label") || "";
                    if (t)
                        out.column = clip(t, 60);
                    break;
                }
                at += span;
            }
            const rt = cellText(rowLabelCell([...tr.cells], cell));
            if (rt)
                out.row = rt;
        }
        return out;
    }
    const grid = el.closest("[role=grid],[role=table],[role=treegrid]");
    if (!grid)
        return out;
    const row = el.closest("[role=row]");
    if (row && grid.contains(row)) {
        const cells = [...row.children].filter((c) => c.matches(CELL));
        const mine = cells.find((c) => c.contains(el));
        const headRow = [...grid.querySelectorAll("[role=row]")].find((r) => r.querySelector(":scope > [role=columnheader]"));
        if (mine && headRow && headRow !== row) {
            const heads = [...headRow.children].filter((c) => c.matches(CELL));
            const t = cellText(heads[cells.indexOf(mine)]);
            if (t)
                out.column = t;
            const rt = cellText(rowLabelCell(cells, mine));
            if (rt)
                out.row = rt;
        }
        return out;
    }
    // a grid without rows (the PM calendar): columns repeat every N cells
    const heads = [...grid.children].filter((c) => c.getAttribute("role") === "columnheader");
    const cells = [...grid.children].filter((c) => c.getAttribute("role") !== "columnheader");
    const mine = cells.find((c) => c.contains(el));
    if (mine && heads.length) {
        const t = cellText(heads[cells.indexOf(mine) % heads.length]);
        if (t)
            out.column = t;
        const rt = cellText(mine, 40);
        if (rt && mine !== el)
            out.row = rt;
    }
    return out;
}
export function describe(el, opts = {}) {
    const cs = getComputedStyle(el);
    const attrs = {};
    for (const a of KEEP_ATTRS) {
        const v = el.getAttribute(a);
        if (v != null)
            attrs[a] = a === "src" || a === "href" ? clip(v.startsWith("data:") ? "data:…" : v, 160) : clip(v, 120);
    }
    for (const a of el.getAttributeNames())
        if (a.startsWith("data-") && a !== ROOT_ATTR)
            attrs[a] = clip(el.getAttribute(a), 80);
    if (el instanceof HTMLInputElement && el.type !== "password")
        attrs.value = clip(el.value, 120);
    if (el instanceof HTMLSelectElement)
        attrs.value = clip(el.selectedOptions[0]?.textContent, 120);
    const info = {
        selector: selectorFor(el),
        path: readablePath(el),
        tag: el.tagName.toLowerCase(),
        rect: boxOf(el.getBoundingClientRect()),
    };
    if (el.id)
        info.id = el.id;
    if (el.classList.length)
        info.classes = [...el.classList];
    const role = el.getAttribute("role");
    if (role)
        info.role = role;
    const name = accessibleName(el);
    if (name)
        info.name = name;
    const text = clip(el.innerText ?? el.textContent, 300);
    if (text && text !== name)
        info.text = text;
    if (Object.keys(attrs).length)
        info.attrs = attrs;
    const sec = sectionsOf(el);
    if (sec.length)
        info.sections = sec;
    if (opts.style !== false)
        info.style = {
            color: cs.color, background: cs.backgroundColor, font: `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily.split(",")[0]}`,
            display: cs.display, ...(cs.opacity !== "1" ? { opacity: cs.opacity } : {}), ...(cs.visibility !== "visible" ? { visibility: cs.visibility } : {}),
        };
    if (opts.html !== false)
        info.html = shortHtml(el);
    const cell = tableContext(el);
    if (cell.column)
        info.column = cell.column;
    if (cell.row)
        info.row = cell.row;
    const host = el.parentElement?.closest(INTERACTIVE);
    if (host && host !== document.body && !isOwn(host)) {
        info.within = { selector: selectorFor(host), tag: host.tagName.toLowerCase() };
        const n = accessibleName(host);
        if (n)
            info.within.name = n;
        const href = host.getAttribute("href");
        if (href)
            info.within.href = href;
        const role = host.getAttribute("role");
        if (role)
            info.within.role = role;
    }
    return info;
}
export function shortLabel(el) {
    const tag = el.tagName.toLowerCase();
    const id = el.id ? "#" + el.id : "";
    const cls = [...el.classList].slice(0, 2).map((c) => "." + c).join("");
    return tag + id + cls;
}
// ---- area captures: which meaningful elements are inside the rectangle
const MEANINGFUL = INTERACTIVE + ",h1,h2,h3,h4,h5,h6,th,img[alt],[role=heading],[role=dialog],[role=alert],[role=status],[aria-label],[data-testid],legend,.badge,.pill,.chip,.tag";
function visible(el, rc) {
    if (rc.width < 2 || rc.height < 2)
        return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== "hidden" && cs.display !== "none" && cs.opacity !== "0";
}
function ownText(el) {
    let t = "";
    for (const n of el.childNodes)
        if (n.nodeType === Node.TEXT_NODE)
            t += n.textContent;
    return t.replace(/\s+/g, " ").trim();
}
// Is any part of the element inside the area actually on top (not hidden behind a panel or dialog)?
function onTop(el, x1, y1, x2, y2) {
    const pts = [[(x1 + x2) / 2, (y1 + y2) / 2], [x1 + 1, y1 + 1], [x2 - 1, y1 + 1], [x1 + 1, y2 - 1], [x2 - 1, y2 - 1]];
    for (const [px, py] of pts) {
        const top = document.elementsFromPoint(px, py).find((e) => !isOwn(e));
        if (!top || top === el || el.contains(top) || top.contains(el))
            return true;
        if (!covers(top, el))
            return true;
    }
    return false;
}
// Does `top` (or a parent of it short of a shared ancestor) paint something opaque over `el`?
function covers(top, el) {
    for (let n = top; n && !n.contains(el); n = n.parentElement) {
        if (/^(IMG|CANVAS|VIDEO|IFRAME|EMBED|OBJECT|svg)$/.test(n.tagName))
            return true;
        const bg = getComputedStyle(n).backgroundColor;
        if (bg && bg !== "transparent" && !/rgba?\([^)]*,\s*0\)$/.test(bg))
            return true;
    }
    return false;
}
/** Elements inside `area` (viewport CSS px), with their place in the screenshot (scaled by `scale`).
 * Elements partly inside count (they're cut at the edge in the screenshot); elements hidden behind something don't.
 * Elements that hold the whole area (a panel, a card, a dialog) are listed separately as containers. */
export function elementsIn(area, scale, max = 60) {
    const ax2 = area.x + area.w, ay2 = area.y + area.h;
    const inside = (rc) => rc.left < ax2 && rc.right > area.x && rc.top < ay2 && rc.bottom > area.y;
    const holds = (rc) => rc.left <= area.x && rc.top <= area.y && rc.right >= ax2 && rc.bottom >= ay2;
    const picked = [];
    const containers = [];
    const notes = new Set();
    for (const el of document.body.querySelectorAll("*")) {
        if (isOwn(el))
            continue;
        const rc = el.getBoundingClientRect();
        if (!inside(rc) || !visible(el, rc))
            continue;
        if (/^(IFRAME|EMBED|OBJECT)$/.test(el.tagName))
            notes.add("Part of the area shows an embedded document (" + el.tagName.toLowerCase() + "); its contents aren't in the screenshot.");
        const meaningful = el.matches(MEANINGFUL) || (ownText(el).length > 0 && ownText(el).length < 200);
        if (!meaningful)
            continue;
        if (holds(rc) && (rc.width > area.w + 4 || rc.height > area.h + 4)) {
            containers.push(el);
            continue;
        }
        // skip text inside something already picked (a button's label span, a link's text)
        if (picked.some((p) => p.contains(el) && p.matches(INTERACTIVE)))
            continue;
        const x1 = Math.max(rc.left, area.x), y1 = Math.max(rc.top, area.y), x2 = Math.min(rc.right, ax2), y2 = Math.min(rc.bottom, ay2);
        if (!onTop(el, x1, y1, x2, y2))
            continue;
        picked.push(el);
        if (picked.length >= max * 2)
            break;
    }
    const chosen = picked
        .map((el) => ({ el, rc: el.getBoundingClientRect() }))
        .sort((a, b) => (Math.round(a.rc.top / 8) - Math.round(b.rc.top / 8)) || (a.rc.left - b.rc.left))
        .slice(0, max);
    const elements = chosen.map(({ el, rc }, i) => {
        const info = describe(el, { html: false, style: false });
        delete info.sections;
        delete info.path;
        delete info.rect; // the page context and the box cover these
        const x = Math.max(rc.left, area.x), y = Math.max(rc.top, area.y);
        const x2 = Math.min(rc.right, ax2), y2 = Math.min(rc.bottom, ay2);
        info.box = { x: r((x - area.x) * scale), y: r((y - area.y) * scale), w: r((x2 - x) * scale), h: r((y2 - y) * scale) };
        info.n = i + 1;
        return info;
    });
    const holders = containers.slice(-4).map((el) => {
        const info = describe(el, { html: false, style: false });
        delete info.sections;
        delete info.path;
        delete info.rect;
        delete info.attrs;
        if (info.text)
            info.text = clip(info.text, 120);
        return info;
    });
    return { elements, containers: holders, notes: [...notes] };
}
/** What page this is: route, title, main heading, the open dialog, the selected tabs and the active nav item. */
export function pageContext() {
    const txt = (sel) => clip(document.querySelector(sel)?.textContent, 120) || undefined;
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
