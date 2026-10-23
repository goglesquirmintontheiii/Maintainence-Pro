// Camera barcode scanning: the browser's BarcodeDetector when it has one, otherwise ZXing (loaded on demand).
// Formats: QR, Code 128, Data Matrix, EAN-13/8, UPC-A/E, Code 39.
const NATIVE_FORMATS = ["qr_code", "code_128", "data_matrix", "ean_13", "ean_8", "upc_a", "upc_e", "code_39"];
async function nativeDetector() {
    const Ctor = window.BarcodeDetector;
    if (!Ctor)
        return null;
    try {
        const supported = (await Ctor.getSupportedFormats?.()) ?? NATIVE_FORMATS;
        const formats = NATIVE_FORMATS.filter((f) => supported.includes(f));
        if (!formats.includes("qr_code"))
            return null;
        return new Ctor({ formats });
    }
    catch {
        return null;
    }
}
async function zxingReader() {
    const [{ BrowserMultiFormatReader }, { BarcodeFormat, DecodeHintType }] = await Promise.all([import("@zxing/browser"), import("@zxing/library")]);
    const hints = new Map();
    hints.set(DecodeHintType.POSSIBLE_FORMATS, [BarcodeFormat.QR_CODE, BarcodeFormat.CODE_128, BarcodeFormat.DATA_MATRIX, BarcodeFormat.EAN_13,
        BarcodeFormat.EAN_8, BarcodeFormat.UPC_A, BarcodeFormat.UPC_E, BarcodeFormat.CODE_39]);
    hints.set(DecodeHintType.TRY_HARDER, true);
    return new BrowserMultiFormatReader(hints, { delayBetweenScanAttempts: 150, delayBetweenScanSuccess: 600 });
}
/** Start the rear camera into `video` and call onCode once per distinct code. */
export async function startScanning(video, onCode) {
    if (!navigator.mediaDevices?.getUserMedia)
        throw new Error("This browser can't open the camera. Type the code or use a photo instead.");
    const stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } } });
    const track = stream.getVideoTracks()[0];
    let stopped = false;
    const caps = (track.getCapabilities?.() ?? {});
    const torch = caps.torch ? async (on) => {
        try {
            await track.applyConstraints({ advanced: [{ torch: on }] });
            return true;
        }
        catch {
            return false;
        }
    } : null;
    let last = "";
    const emit = (v) => { if (!stopped && v && v !== last) {
        last = v;
        onCode(v);
        setTimeout(() => { if (last === v)
            last = ""; }, 2500);
    } };
    const native = await nativeDetector();
    let stopEngine = () => { };
    if (native) {
        video.srcObject = stream;
        video.setAttribute("playsinline", "true");
        video.muted = true;
        await video.play().catch(() => { });
        let timer = 0;
        const tick = async () => {
            if (stopped)
                return;
            if (video.readyState >= 2) {
                try {
                    const r = await native.detect(video);
                    if (r[0]?.rawValue)
                        emit(r[0].rawValue);
                }
                catch { /* frame not ready */ }
            }
            timer = window.setTimeout(() => { void tick(); }, 160);
        };
        void tick();
        stopEngine = () => window.clearTimeout(timer);
    }
    else {
        const reader = await zxingReader();
        const controls = await reader.decodeFromStream(stream, video, (res) => { if (res)
            emit(res.getText()); });
        stopEngine = () => controls.stop();
    }
    return {
        engine: native ? "native" : "zxing",
        torch,
        stop: () => { stopped = true; stopEngine(); stream.getTracks().forEach((t) => t.stop()); video.srcObject = null; },
    };
}
/** Decode a code from a photo (no camera, or a blurry live view). */
export async function decodeImage(file) {
    const native = await nativeDetector();
    if (native && "createImageBitmap" in window) {
        try {
            const bmp = await createImageBitmap(file);
            const r = await native.detect(bmp);
            bmp.close?.();
            if (r[0]?.rawValue)
                return r[0].rawValue;
        }
        catch { /* fall through to ZXing */ }
    }
    const url = URL.createObjectURL(file);
    try {
        const reader = await zxingReader();
        const res = await reader.decodeFromImageUrl(url);
        return res.getText();
    }
    catch {
        return null;
    }
    finally {
        URL.revokeObjectURL(url);
    }
}
export function cameraError(e) {
    const name = e?.name;
    if (name === "NotAllowedError" || name === "SecurityError")
        return "Camera access is blocked. Allow the camera for this site in your browser settings, or type the code below.";
    if (name === "NotFoundError" || name === "OverconstrainedError")
        return "No camera was found. Type the code below or take a photo with your camera app.";
    if (name === "NotReadableError")
        return "The camera is busy in another app. Close it and try again.";
    if (!window.isSecureContext)
        return "The camera only works over HTTPS (or on this computer at localhost). Type the code below instead.";
    return e?.message || "Couldn't start the camera.";
}
