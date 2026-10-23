import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
// Profile photo cropper (MP-116): pick a photo, drag to move, zoom, rotate, then save a square image.
import { useCallback, useEffect, useRef, useState } from "react";
import { ImagePlus, RotateCw, ZoomIn } from "lucide-react";
import { Button, Modal } from "./ui";
import { DropZone } from "./DropZone";
import "../styles/roles.css";
const VIEW = 280; // on-screen crop area (px)
const OUT = 512; // exported square (server re-encodes to 256 WebP)
/** Draws `img` into a square canvas of `size` px using the pose (offset relative to the view, zoom, rotation). */
function draw(ctx, img, pose, size, base) {
    const k = size / VIEW;
    ctx.save();
    ctx.clearRect(0, 0, size, size);
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, size, size);
    ctx.translate(size / 2 + pose.x * k, size / 2 + pose.y * k);
    ctx.rotate((pose.rot * Math.PI) / 180);
    const s = base * pose.zoom * k;
    ctx.drawImage(img, (-img.naturalWidth * s) / 2, (-img.naturalHeight * s) / 2, img.naturalWidth * s, img.naturalHeight * s);
    ctx.restore();
}
export function AvatarCropper({ file, onCancel, onSave, busy }) {
    const canvas = useRef(null);
    const [img, setImg] = useState(null);
    const [err, setErr] = useState("");
    const [pose, setPose] = useState({ x: 0, y: 0, zoom: 1, rot: 0 });
    const drag = useRef(null);
    useEffect(() => {
        const url = URL.createObjectURL(file);
        const im = new Image();
        let live = true; // the effect can be cleaned up (and the URL revoked) before the image loads
        im.onload = () => { if (live) {
            setErr("");
            setImg(im);
        } };
        im.onerror = () => { if (live)
            setErr("That file can't be opened as a photo. Try a JPG or PNG."); };
        im.src = url;
        return () => { live = false; im.src = ""; URL.revokeObjectURL(url); };
    }, [file]);
    // base scale makes the shorter side fill the circle
    const base = img ? VIEW / Math.min(img.naturalWidth, img.naturalHeight) : 1;
    useEffect(() => {
        const c = canvas.current;
        if (!c || !img)
            return;
        const ratio = window.devicePixelRatio || 1;
        c.width = VIEW * ratio;
        c.height = VIEW * ratio;
        const ctx = c.getContext("2d");
        draw(ctx, img, pose, VIEW * ratio, base);
    }, [img, pose, base]);
    const save = useCallback(() => {
        if (!img)
            return;
        const out = document.createElement("canvas");
        out.width = OUT;
        out.height = OUT;
        draw(out.getContext("2d"), img, pose, OUT, base);
        out.toBlob((b) => { if (b)
            onSave(b); }, "image/jpeg", 0.92);
    }, [img, pose, base, onSave]);
    const nudge = (dx, dy) => setPose((p) => ({ ...p, x: p.x + dx, y: p.y + dy }));
    return (_jsx(Modal, { title: "Profile photo", onClose: onCancel, width: 420, footer: _jsxs(_Fragment, { children: [_jsx(Button, { onClick: onCancel, children: "Cancel" }), _jsx(Button, { variant: "primary", disabled: !img || busy, onClick: save, children: busy ? "Saving…" : "Save photo" })] }), children: err ? _jsx("div", { className: "banner warning", role: "alert", children: err }) : (_jsxs("div", { className: "stack", style: { alignItems: "center" }, children: [_jsxs("div", { className: "crop-stage", style: { width: VIEW, height: VIEW }, children: [_jsx("canvas", { ref: canvas, style: { width: VIEW, height: VIEW }, tabIndex: 0, role: "img", "aria-label": "Photo preview. Drag or use the arrow keys to move it.", onPointerDown: (e) => { drag.current = { px: e.clientX, py: e.clientY, x: pose.x, y: pose.y }; e.currentTarget.setPointerCapture(e.pointerId); }, onPointerMove: (e) => { const d = drag.current; if (d)
                                setPose((p) => ({ ...p, x: d.x + e.clientX - d.px, y: d.y + e.clientY - d.py })); }, onPointerUp: () => { drag.current = null; }, onWheel: (e) => setPose((p) => ({ ...p, zoom: Math.min(5, Math.max(1, p.zoom - e.deltaY / 500)) })), onKeyDown: (e) => {
                                const step = e.shiftKey ? 20 : 5;
                                if (e.key === "ArrowLeft") {
                                    e.preventDefault();
                                    nudge(-step, 0);
                                }
                                else if (e.key === "ArrowRight") {
                                    e.preventDefault();
                                    nudge(step, 0);
                                }
                                else if (e.key === "ArrowUp") {
                                    e.preventDefault();
                                    nudge(0, -step);
                                }
                                else if (e.key === "ArrowDown") {
                                    e.preventDefault();
                                    nudge(0, step);
                                }
                            } }), _jsx("div", { className: "crop-mask", "aria-hidden": "true" })] }), _jsxs("label", { className: "row", style: { width: VIEW, gap: 10 }, children: [_jsx(ZoomIn, { size: 16, className: "faint", "aria-hidden": "true" }), _jsx("input", { type: "range", min: 1, max: 5, step: 0.01, value: pose.zoom, "aria-label": "Zoom", className: "grow", onChange: (e) => setPose((p) => ({ ...p, zoom: Number(e.target.value) })) })] }), _jsxs("div", { className: "row", children: [_jsxs(Button, { size: "sm", onClick: () => setPose((p) => ({ ...p, rot: (p.rot + 90) % 360 })), children: [_jsx(RotateCw, { size: 14 }), "Rotate"] }), _jsx(Button, { size: "sm", variant: "ghost", onClick: () => setPose({ x: 0, y: 0, zoom: 1, rot: 0 }), children: "Reset" })] }), _jsx("p", { className: "small faint", style: { margin: 0 }, children: "Drag to move, scroll or use the slider to zoom." })] })) }));
}
/** "Change photo" button + cropper; calls onBlob with the cropped square. */
export function PhotoPickerButton({ onBlob, busy, label = "Change photo" }) {
    const input = useRef(null);
    const [file, setFile] = useState(null);
    return _jsxs(DropZone, { className: "row-inline", multiple: false, accept: "image/jpeg,image/png,image/webp,image/gif", disabled: busy || !!file, label: "Drop a photo", onFiles: (fs) => setFile(fs[0]), children: [_jsxs(Button, { size: "sm", onClick: () => input.current?.click(), disabled: busy, children: [_jsx(ImagePlus, { size: 14 }), label] }), _jsx("input", { ref: input, type: "file", accept: "image/jpeg,image/png,image/webp,image/gif", hidden: true, "aria-label": "Choose a profile photo", onChange: (e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f)
                    setFile(f); } }), file && _jsx(AvatarCropper, { file: file, busy: busy, onCancel: () => setFile(null), onSave: (b) => { onBlob(b); setFile(null); } })] });
}
