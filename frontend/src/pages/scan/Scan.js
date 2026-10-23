import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
// Scan a QR code or barcode with the camera (or type it, or decode a photo) and open what it belongs to.
import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Camera, CameraOff, Flashlight, ImageUp, Keyboard, Loader2, ScanLine } from "lucide-react";
import "../../styles/scan.css";
import { Button, Input } from "../../components/ui";
import { DropZone } from "../../components/DropZone";
import { ScanOutcome, resolveScan } from "./resolve";
import { cameraError, decodeImage, startScanning } from "./scanner";
const hasCamera = () => !!navigator.mediaDevices?.getUserMedia;
export function ScanPage() {
    const nav = useNavigate();
    const video = useRef(null);
    const session = useRef(null);
    const photoIn = useRef(null);
    const [state, setState] = useState("idle");
    const [camErr, setCamErr] = useState("");
    const [torchOn, setTorchOn] = useState(false);
    const [typed, setTyped] = useState("");
    const [busy, setBusy] = useState(false);
    const [result, setResult] = useState(null);
    const [msg, setMsg] = useState("");
    const paused = useRef(false);
    const stop = useCallback(() => { session.current?.stop(); session.current = null; setTorchOn(false); }, []);
    const handle = useCallback(async (value) => {
        if (paused.current)
            return;
        paused.current = true;
        setBusy(true);
        setMsg("");
        setResult(null);
        try {
            const r = await resolveScan(value);
            if (r.status === "found") {
                stop();
                nav(r.url);
                return;
            }
            setResult(r);
            navigator.vibrate?.(60);
        }
        catch (e) {
            setMsg(e.message);
            paused.current = false;
        }
        finally {
            setBusy(false);
        }
    }, [nav, stop]);
    const start = useCallback(async () => {
        if (!video.current)
            return;
        stop();
        setState("starting");
        setCamErr("");
        try {
            session.current = await startScanning(video.current, (v) => { void handle(v); });
            setState("live");
        }
        catch (e) {
            setCamErr(cameraError(e));
            setState("error");
        }
    }, [handle, stop]);
    useEffect(() => {
        if (hasCamera())
            void start();
        else {
            setCamErr(cameraError(new Error("This browser can't open the camera. Type the code or use a photo instead.")));
            setState("error");
        }
        return () => { session.current?.stop(); session.current = null; };
    }, []); // eslint-disable-line react-hooks/exhaustive-deps
    useEffect(() => {
        const vis = () => { if (document.hidden)
            stop();
        else if (state === "live" && !session.current)
            void start(); };
        document.addEventListener("visibilitychange", vis);
        return () => document.removeEventListener("visibilitychange", vis);
    }, [state, start, stop]);
    const again = () => { setResult(null); setMsg(""); paused.current = false; if (!session.current && state !== "error")
        void start(); };
    const fromPhoto = async (f) => {
        if (!f)
            return;
        setBusy(true);
        setMsg("");
        paused.current = false;
        const v = await decodeImage(f);
        setBusy(false);
        if (v)
            void handle(v);
        else
            setMsg("No QR code or barcode found in that photo. Try a closer, sharper picture.");
    };
    return (_jsxs("div", { className: "page scan-page", children: [_jsx("div", { className: "page-head", children: _jsxs("div", { children: [_jsx("h1", { children: "Scan a code" }), _jsx("p", { className: "sub", children: "Point the camera at a QR code or barcode on equipment, a location or a meter." })] }) }), _jsxs("div", { className: "scan-view" + (state === "live" ? " live" : ""), children: [_jsx("video", { ref: video, playsInline: true, muted: true, "aria-label": "Camera view" }), state === "live" && _jsxs("div", { className: "scan-frame", "aria-hidden": "true", children: [_jsx("span", {}), _jsx("i", {})] }), state === "starting" && _jsxs("div", { className: "scan-msg", children: [_jsx(Loader2, { className: "spin", size: 22 }), "Starting the camera\u2026"] }), state === "error" && _jsxs("div", { className: "scan-msg", children: [_jsx(CameraOff, { size: 26 }), _jsx("span", { children: camErr }), hasCamera() && _jsxs(Button, { onClick: () => void start(), children: [_jsx(Camera, { size: 15 }), "Try again"] })] }), state === "idle" && _jsx("div", { className: "scan-msg", children: _jsx(ScanLine, { size: 26 }) }), busy && _jsxs("div", { className: "scan-busy", role: "status", children: [_jsx(Loader2, { className: "spin", size: 18 }), "Looking it up\u2026"] }), state === "live" && session.current?.torch && (_jsx(Button, { className: "scan-torch", variant: torchOn ? "primary" : "default", icon: true, "aria-label": torchOn ? "Turn the light off" : "Turn the light on", "aria-pressed": torchOn, onClick: async () => { if (await session.current?.torch?.(!torchOn))
                            setTorchOn(!torchOn); }, children: _jsx(Flashlight, { size: 18 }) }))] }), result && _jsx(ScanOutcome, { result: result, onAgain: again }), msg && _jsx("div", { className: "banner warning", role: "alert", children: msg }), _jsxs("form", { className: "scan-manual card card-pad", onSubmit: (e) => { e.preventDefault(); paused.current = false; if (typed.trim())
                    void handle(typed.trim()); }, children: [_jsxs("label", { htmlFor: "scan-typed", className: "row small", style: { gap: 6, fontWeight: 600 }, children: [_jsx(Keyboard, { size: 15 }), "Type a code, barcode or serial number"] }), _jsxs("div", { className: "row", style: { gap: 8 }, children: [_jsx(Input, { id: "scan-typed", value: typed, onChange: (e) => setTyped(e.target.value), placeholder: "e.g. 7KQ2M9XH4P", autoCapitalize: "characters", autoComplete: "off" }), _jsx(Button, { type: "submit", variant: "primary", disabled: !typed.trim() || busy, children: "Find" })] }), _jsx("input", { ref: photoIn, type: "file", accept: "image/*", hidden: true, onChange: (e) => { void fromPhoto(e.target.files?.[0]); e.target.value = ""; } }), _jsx(DropZone, { multiple: false, accept: "image/*", disabled: busy, label: "Drop a photo of the code", onFiles: (fs) => void fromPhoto(fs[0]), children: _jsxs(Button, { onClick: () => photoIn.current?.click(), disabled: busy, children: [_jsx(ImageUp, { size: 15 }), "Read a code from a photo"] }) })] })] }));
}
