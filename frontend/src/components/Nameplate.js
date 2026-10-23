import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
// Read an equipment nameplate from a photo, on this device (r594). Tesseract.js runs in a worker; its code, WebAssembly
// core and English model are served from /ocr on our own origin (copied by scripts/copy-ocr.mjs), so it works offline.
import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Camera, ImageUp, Loader2, ScanText } from "lucide-react";
import "../styles/scan.css";
import { api } from "../lib/api";
import { Button, Field, Input, Modal } from "./ui";
const STOP = /\b(SERIAL|S\/N|SER\.?\s*NO|SN|MODEL|MOD\.?|M\/N|CAT\.?\s*NO|VOLTS?|AMPS?|HZ|PHASE|PH|RPM|HP|KW|PSI|YEAR|MFG|MFD|DATE|TYPE)\b/;
/** Pull manufacturer, model, serial and year out of OCR text. Exported for tests. */
export function parseNameplate(text, manufacturers) {
    const lines = text.split(/\r?\n/).map((l) => l.replace(/[|_]+/g, " ").replace(/\s+/g, " ").trim()).filter(Boolean);
    const up = lines.map((l) => l.toUpperCase());
    const after = (re, valueRe) => {
        for (let i = 0; i < up.length; i++) {
            const m = re.exec(up[i]);
            if (!m)
                continue;
            let rest = lines[i].slice(m.index + m[0].length).replace(/^[\s:#.\-=]+/, "");
            const cut = STOP.exec(rest.toUpperCase());
            if (cut && cut.index > 0)
                rest = rest.slice(0, cut.index);
            if (!rest.trim() && i + 1 < lines.length)
                rest = lines[i + 1]; // value on the next line
            const v = valueRe.exec(rest.trim());
            if (v)
                return v[0].replace(/[.,;:]+$/, "").trim();
        }
        return "";
    };
    const model = after(/\b(MODEL\s*(NO\.?|NUMBER|#)?|MOD\.?|M\/N|CAT\.?\s*NO\.?)(?=[\s:#.]|$)/, /^[A-Z0-9][A-Z0-9\-\/. ]{0,30}[A-Z0-9]|^[A-Z0-9]/i)
        .split(" ").slice(0, 3).join(" ");
    const serial = after(/\b(SERIAL\s*(NO\.?|NUMBER|#)?|S\/N|SER\.?\s*NO\.?|SN)(?=[\s:#.]|$)/, /^[A-Z0-9][A-Z0-9\-\/]{2,30}/i);
    let year = null, yearConf = "none";
    const yr = (s) => { const m = /\b(19[5-9]\d|20[0-3]\d)\b/.exec(s); return m && +m[1] <= 2035 ? +m[1] : null; };
    for (let i = 0; i < up.length && year === null; i++) {
        if (/\b(YEAR|YR|MFG|MFD|MANUFACTURED|DATE|BUILT)\b/.test(up[i])) {
            year = yr(up[i]) ?? (i + 1 < up.length ? yr(up[i + 1]) : null);
            if (year)
                yearConf = "found";
        }
    }
    if (year === null) {
        const cleaned = up.join(" ").replace(serial.toUpperCase(), " ").replace(model.toUpperCase(), " ");
        year = yr(cleaned);
        if (year)
            yearConf = "guess";
    }
    const norm = (s) => s.toUpperCase().replace(/[^A-Z0-9]/g, "");
    const flat = norm(text);
    let manufacturer = "";
    for (const name of manufacturers) {
        const n = norm(name);
        if (n.length >= 3 && flat.includes(n) && n.length > norm(manufacturer).length)
            manufacturer = name;
    }
    return { manufacturer, model, serial_number: serial, year,
        confidence: { manufacturer: manufacturer ? "found" : "none", model: model ? "found" : "none", serial_number: serial ? "found" : "none", year: yearConf } };
}
async function downscale(file, max = 1800) {
    try {
        const bmp = await createImageBitmap(file);
        const s = Math.min(1, max / Math.max(bmp.width, bmp.height));
        if (s === 1) {
            bmp.close?.();
            return file;
        }
        const c = document.createElement("canvas");
        c.width = Math.round(bmp.width * s);
        c.height = Math.round(bmp.height * s);
        c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
        bmp.close?.();
        return await new Promise((res) => c.toBlob((b) => res(b ?? file), "image/png"));
    }
    catch {
        return file;
    }
}
export async function ocrImage(img, onProgress) {
    const T = await import("tesseract.js");
    const worker = await T.createWorker("eng", 1 /* LSTM only */, {
        workerPath: "/ocr/worker.min.js", corePath: "/ocr", langPath: "/ocr", gzip: true, workerBlobURL: false,
        logger: (m) => onProgress?.(m.progress, m.status),
    });
    try {
        const r = await worker.recognize(img);
        return { text: r.data.text, confidence: r.data.confidence };
    }
    finally {
        await worker.terminate();
    }
}
export function NameplateScan({ onResult, onClose }) {
    const cat = useQuery({ queryKey: ["asset-catalog"], queryFn: () => api("/asset-catalog"), staleTime: 300_000 });
    const camIn = useRef(null);
    const fileIn = useRef(null);
    const [file, setFile] = useState(null);
    const [preview, setPreview] = useState("");
    const [stage, setStage] = useState("pick");
    const [progress, setProgress] = useState({ p: 0, s: "" });
    const [text, setText] = useState("");
    const [conf, setConf] = useState(0);
    const [found, setFound] = useState(null);
    const [f, setF] = useState({ manufacturer: "", model: "", serial_number: "", year: null });
    const [err, setErr] = useState("");
    useEffect(() => () => { if (preview)
        URL.revokeObjectURL(preview); }, [preview]);
    const run = async (picked) => {
        if (!picked)
            return;
        if (!picked.type.startsWith("image/")) {
            setErr("Pick a photo of the nameplate.");
            setStage("error");
            return;
        }
        setFile(picked);
        setPreview(URL.createObjectURL(picked));
        setStage("reading");
        setErr("");
        setProgress({ p: 0, s: "Loading the text reader" });
        try {
            const r = await ocrImage(await downscale(picked), (p, s) => setProgress({ p, s }));
            const parsed = parseNameplate(r.text, cat.data?.manufacturers ?? []);
            setText(r.text);
            setConf(Math.round(r.confidence));
            setFound(parsed.confidence);
            setF({ manufacturer: parsed.manufacturer, model: parsed.model, serial_number: parsed.serial_number, year: parsed.year });
            setStage("review");
        }
        catch (e) {
            const m = e?.message || String(e);
            setErr(/fetch|load|import|network|wasm|worker/i.test(m)
                ? "The text reader couldn't load on this device. You can still type the details yourself." : `Couldn't read the photo: ${m}`);
            setStage("error");
        }
    };
    const label = (k, base) => found ? `${base}${found[k] === "none" ? " (not found)" : found[k] === "guess" ? " (best guess)" : ""}` : base;
    const statusText = (s) => ({ "loading tesseract core": "Loading the text reader", "initializing tesseract": "Starting up",
        "loading language traineddata": "Loading the English model", "initializing api": "Starting up", "recognizing text": "Reading the nameplate" }[s] ?? s);
    return (_jsx(Modal, { title: "Read a nameplate", onClose: onClose, width: 560, footer: stage === "review" ? _jsxs(_Fragment, { children: [_jsx(Button, { onClick: () => { setStage("pick"); setFile(null); }, children: "Try another photo" }), _jsx(Button, { variant: "primary", onClick: () => onResult({ ...f, text, file: file }), children: "Use these details" })] })
            : _jsx(Button, { onClick: onClose, children: "Cancel" }), children: _jsxs("div", { className: "stack", children: [_jsx("input", { ref: camIn, type: "file", accept: "image/*", capture: "environment", hidden: true, onChange: (e) => { void run(e.target.files?.[0]); e.target.value = ""; } }), _jsx("input", { ref: fileIn, type: "file", accept: "image/*", hidden: true, onChange: (e) => { void run(e.target.files?.[0]); e.target.value = ""; } }), stage === "pick" && _jsxs(_Fragment, { children: [_jsx("p", { className: "muted", style: { margin: 0 }, children: "Take a straight-on photo of the manufacturer's plate, filling the frame. The text is read on this device; nothing is sent anywhere until you save." }), _jsxs("div", { className: "row wrap", children: [_jsxs(Button, { variant: "primary", onClick: () => camIn.current?.click(), children: [_jsx(Camera, { size: 15 }), "Take a photo"] }), _jsxs(Button, { onClick: () => fileIn.current?.click(), children: [_jsx(ImageUp, { size: 15 }), "Choose a photo"] })] })] }), preview && stage !== "pick" && _jsx("img", { src: preview, alt: "Nameplate photo", className: "np-photo" }), stage === "reading" && _jsxs("div", { className: "stack", role: "status", "aria-live": "polite", children: [_jsxs("div", { className: "row", style: { gap: 8 }, children: [_jsx(Loader2, { className: "spin", size: 16 }), statusText(progress.s), "\u2026"] }), _jsx("div", { className: "progress", "aria-hidden": "true", children: _jsx("span", { style: { width: `${Math.round(progress.p * 100)}%` } }) }), _jsx("span", { className: "small faint", children: "The first time takes a little longer while the model loads." })] }), stage === "error" && _jsxs(_Fragment, { children: [_jsx("div", { className: "banner warning", role: "alert", children: err }), _jsx("div", { className: "row", children: _jsx(Button, { onClick: () => setStage("pick"), children: "Try again" }) })] }), stage === "review" && _jsxs(_Fragment, { children: [_jsxs("div", { className: "banner " + (conf >= 70 ? "info" : "warning"), children: [_jsx(ScanText, { size: 16 }), _jsxs("div", { children: ["Read with ", conf, "% confidence. Check each field against the plate and correct anything that's off."] })] }), _jsxs("div", { className: "form-grid", children: [_jsx(Field, { label: label("manufacturer", "Manufacturer"), children: (id) => _jsxs(_Fragment, { children: [_jsx(Input, { id: id, list: "np-mfrs", value: f.manufacturer, onChange: (e) => setF({ ...f, manufacturer: e.target.value }) }), _jsx("datalist", { id: "np-mfrs", children: (cat.data?.manufacturers ?? []).map((m) => _jsx("option", { value: m }, m)) })] }) }), _jsx(Field, { label: label("model", "Model"), children: (id) => _jsx(Input, { id: id, value: f.model, onChange: (e) => setF({ ...f, model: e.target.value }) }) }), _jsx(Field, { label: label("serial_number", "Serial number"), children: (id) => _jsx(Input, { id: id, value: f.serial_number, onChange: (e) => setF({ ...f, serial_number: e.target.value }) }) }), _jsx(Field, { label: label("year", "Year"), children: (id) => _jsx(Input, { id: id, type: "number", min: 1800, max: 2200, value: f.year ?? "", onChange: (e) => setF({ ...f, year: e.target.value ? Number(e.target.value) : null }) }) })] }), _jsxs("details", { className: "small", children: [_jsx("summary", { children: "Text read from the photo" }), _jsx("pre", { className: "np-text", children: text || "(no text found)" })] })] })] }) }));
}
