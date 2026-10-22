// Copies the on-device OCR files (tesseract.js worker, WebAssembly core, English model) into public/ocr so
// nameplate scanning works offline and from our own origin (the CSP doesn't allow CDNs). Run on install and build.
import { copyFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "public", "ocr");
const nm = join(root, "node_modules");
const files = [
  ["tesseract.js/dist/worker.min.js", "worker.min.js"],
  // LSTM-only cores (we always run OEM 1): plain, SIMD and relaxed-SIMD builds; the worker picks one.
  ["tesseract.js-core/tesseract-core-lstm.wasm.js", "tesseract-core-lstm.wasm.js"],
  ["tesseract.js-core/tesseract-core-simd-lstm.wasm.js", "tesseract-core-simd-lstm.wasm.js"],
  ["tesseract.js-core/tesseract-core-relaxedsimd-lstm.wasm.js", "tesseract-core-relaxedsimd-lstm.wasm.js"],
  ["@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz", "eng.traineddata.gz"],
];
mkdirSync(out, { recursive: true });
let copied = 0;
for (const [from, to] of files) {
  const src = join(nm, from), dst = join(out, to);
  if (!existsSync(src)) { console.warn(`copy-ocr: missing ${from} (run npm install)`); continue; }
  if (existsSync(dst) && statSync(dst).size === statSync(src).size) continue;
  copyFileSync(src, dst);
  copied++;
}
console.log(`copy-ocr: ${copied} file(s) updated in public/ocr`);
