// TEMPORARY (feedback capture, 0.4.2). Remove by 1.9.0 (2.0.0 at the latest). See ./README.md.
// Screenshots and the capture code.
//
// Code format "MPRO-FB2:" (0.4.3): base85 text of a deflate-raw stream holding
//   [4-byte big-endian JSON length][JSON (UTF-8)][screenshot bytes, if any]
// The screenshot travels as raw bytes, not base64 inside the JSON, and base85 is ~6% shorter than base64. The base85
// alphabet is printable ASCII without " & ' * < > \ _ ` so codes survive Markdown, HTML and chat boxes.
// The checklist still reads 0.4.2's "MPRO-FB1:" codes (gzip + base64 JSON).
export const PREFIX = "MPRO-FB2:";
// Screenshots: 1.5× (sharp enough for 1px borders and small text) at WebP quality 0.72. That's about half the size of
// 0.4.2's 2× / 0.86. Big areas step down until the image fits the budget.
const MAX_SCALE = 1.5;
const QUALITY = 0.72;
const MAX_SIDE = 1600; // image pixels
const BUDGET = 160_000; // image bytes
// ---------------------------------------------------------------- scroll positions
// html-to-image redraws a copy of the page, and a copy has no scroll positions: a scrolled list would come out showing
// its top. While the screenshot is taken, each scrolled box is reset to 0 and its children are shifted by the same
// amount with a transform (the page looks the same), and anything sticky is moved back to where it was.
function freezeScroll() {
    const undo = [];
    const own = (e) => !!e.closest("[data-mpro-feedback]");
    const scrolled = [...document.body.querySelectorAll("*")].filter((e) => (e.scrollTop || e.scrollLeft) && !own(e));
    if (!scrolled.length)
        return () => { };
    // sticky things inside scrolled boxes: remember where they are now
    const sticky = [];
    for (const box of scrolled) {
        for (const e of box.querySelectorAll("*")) {
            if (getComputedStyle(e).position === "sticky") {
                const r = e.getBoundingClientRect();
                sticky.push({ el: e, top: r.top, left: r.left });
            }
        }
    }
    for (const box of scrolled) {
        const t = box.scrollTop, l = box.scrollLeft;
        const kids = [...box.children];
        const prev = kids.map((k) => k.style.transform);
        kids.forEach((k) => {
            const cs = getComputedStyle(k);
            if (cs.position === "fixed")
                return;
            k.style.transform = `translate(${-l}px, ${-t}px)${cs.transform && cs.transform !== "none" ? " " + cs.transform : ""}`;
        });
        box.scrollTop = 0;
        box.scrollLeft = 0;
        undo.push(() => { kids.forEach((k, i) => { k.style.transform = prev[i]; }); box.scrollTop = t; box.scrollLeft = l; });
    }
    for (const s of sticky) {
        const r = s.el.getBoundingClientRect();
        const dx = s.left - r.left, dy = s.top - r.top;
        if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5)
            continue;
        const prev = s.el.style.transform;
        const cs = getComputedStyle(s.el).transform;
        s.el.style.transform = `translate(${dx}px, ${dy}px)${cs && cs !== "none" ? " " + cs : ""}`;
        undo.push(() => { s.el.style.transform = prev; });
    }
    return () => { for (let i = undo.length - 1; i >= 0; i--)
        undo[i](); };
}
/** Screenshot of a viewport rectangle (CSS px). Our own overlay is left out. */
export async function screenshot(area) {
    const { toCanvas } = await import("html-to-image"); // loaded only when someone takes a screenshot
    const ratio = Math.max(1, Math.min(devicePixelRatio || 1, MAX_SCALE));
    const thaw = freezeScroll();
    let full;
    try {
        full = await toCanvas(document.body, {
            pixelRatio: ratio,
            width: innerWidth,
            height: innerHeight,
            skipFonts: true, // MPro uses system fonts; nothing to embed
            cacheBust: false,
            backgroundColor: getComputedStyle(document.body).backgroundColor || "#ffffff",
            style: scrollX || scrollY ? { transform: `translate(${-scrollX}px, ${-scrollY}px)` } : undefined,
            filter: (n) => !(n instanceof Element && n.hasAttribute("data-mpro-feedback")),
        });
    }
    finally {
        thaw();
    }
    let scale = Math.min(ratio, MAX_SIDE / Math.max(area.w, area.h));
    let quality = QUALITY;
    for (let attempt = 0;; attempt++) {
        const w = Math.max(1, Math.round(area.w * scale)), h = Math.max(1, Math.round(area.h * scale));
        const c = document.createElement("canvas");
        c.width = w;
        c.height = h;
        const g = c.getContext("2d");
        g.imageSmoothingQuality = "high";
        g.drawImage(full, area.x * ratio, area.y * ratio, area.w * ratio, area.h * ratio, 0, 0, w, h);
        let data = c.toDataURL("image/webp", quality);
        if (!data.startsWith("data:image/webp"))
            data = c.toDataURL("image/jpeg", quality + 0.1); // Safari can't encode WebP
        const bytes = Math.floor((data.length - data.indexOf(",") - 1) * 0.75);
        if (bytes <= BUDGET || attempt >= 6) {
            return { data, type: data.slice(5, data.indexOf(";")), w, h, scale: Math.round(scale * 1000) / 1000 };
        }
        if (scale > 1)
            scale = Math.max(1, scale * 0.8);
        else if (quality > 0.55)
            quality -= 0.08;
        else
            scale *= 0.8;
    }
}
// ---------------------------------------------------------------- base85
export const B85 = Array.from({ length: 94 }, (_, i) => String.fromCharCode(33 + i)).filter((ch) => !`"&'*<>\\_\``.includes(ch)).join("");
export function b85encode(bytes) {
    const out = [];
    const d = new Array(5);
    for (let i = 0; i < bytes.length; i += 4) {
        const n = Math.min(4, bytes.length - i);
        let v = 0;
        for (let k = 0; k < 4; k++)
            v = v * 256 + (k < n ? bytes[i + k] : 0);
        for (let k = 4; k >= 0; k--) {
            d[k] = B85[v % 85];
            v = Math.floor(v / 85);
        }
        out.push(n === 4 ? d.join("") : d.slice(0, n + 1).join(""));
    }
    return out.join("");
}
function dataUrlBytes(d) {
    const bin = atob(d.slice(d.indexOf(",") + 1));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++)
        out[i] = bin.charCodeAt(i);
    return out;
}
/** The text to paste into the checklist. */
export async function encode(c) {
    if (typeof CompressionStream === "undefined")
        throw new Error("This browser can't compress the capture. Use a current Chrome, Edge, Firefox or Safari.");
    const img = c.shot ? dataUrlBytes(c.shot.data) : new Uint8Array(0);
    const meta = { ...c, shot: c.shot ? { type: c.shot.type, w: c.shot.w, h: c.shot.h, scale: c.shot.scale, bytes: img.length } : undefined };
    const json = new TextEncoder().encode(JSON.stringify(meta));
    const raw = new Uint8Array(4 + json.length + img.length);
    new DataView(raw.buffer).setUint32(0, json.length);
    raw.set(json, 4);
    raw.set(img, 4 + json.length);
    const stream = new Blob([raw]).stream().pipeThrough(new CompressionStream("deflate-raw"));
    const packed = new Uint8Array(await new Response(stream).arrayBuffer());
    return PREFIX + b85encode(packed);
}
let cachedApp = null;
export async function appInfo() {
    if (cachedApp)
        return cachedApp;
    try {
        const r = await fetch("/api/v1/auth/session", { credentials: "same-origin", headers: { Accept: "application/json" } });
        const s = await r.json();
        cachedApp = { version: s.version, role: s.role_label || s.role || undefined, org: s.org?.name };
    }
    catch {
        cachedApp = {};
    }
    return cachedApp;
}
