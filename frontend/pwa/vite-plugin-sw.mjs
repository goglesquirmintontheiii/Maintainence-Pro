// The phone app's service worker (0.6.0, MP-053): pwa/sw.template.js + this build's file list → sw.js.
// A new build gets a new BUILD id, which is how installed apps notice there's an update.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

export function serviceWorker() {
  return {
    name: "mpro-service-worker",
    apply: "build",
    generateBundle(_opts, bundle) {
      const files = Object.keys(bundle).filter((f) => f.startsWith("assets/") && /\.(js|css|woff2?|svg|png|webp)$/.test(f)).sort();
      const shell = [...files.map((f) => "/" + f), "/manifest.webmanifest", "/favicon.svg", "/icons/icon-192.png", "/icons/icon-512.png"];
      const template = readFileSync(new URL("./sw.template.js", import.meta.url), "utf8");
      const build = createHash("sha256").update(files.join("|") + template).digest("hex").slice(0, 12);
      const source = template.replace("const BUILD = \"__BUILD__\";", `const BUILD = "${build}";`).replace("const SHELL = __SHELL__;", `const SHELL = ${JSON.stringify(shell)};`);
      this.emitFile({ type: "asset", fileName: "sw.js", source });
    },
  };
}
