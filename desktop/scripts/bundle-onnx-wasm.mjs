// Bundles the ONNX WASM runtime into desktop/public/ so Vite and Tauri bundle
// it offline with the app. Whisper models are NOT bundled: they download on
// demand at runtime (into the browser cache) to keep the app bundle small.
import { copyFileSync, createWriteStream, existsSync, mkdirSync, statSync } from "node:fs";
import https from "node:https";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const publicDir = join(here, "..", "public");
const wasmDir = join(publicDir, "wasm");

mkdirSync(wasmDir, { recursive: true });

const localDistDirs = [
  join(
    here,
    "..",
    "node_modules",
    "@huggingface",
    "transformers",
    "node_modules",
    "onnxruntime-web",
    "dist",
  ),
  join(here, "..", "node_modules", "onnxruntime-web", "dist"),
  join(here, "..", "..", "node_modules", "onnxruntime-web", "dist"),
];

const RUNTIME_FILES = [
  "ort-wasm-simd-threaded.jsep.wasm",
  "ort-wasm-simd-threaded.jsep.mjs",
  "ort-wasm-simd-threaded.wasm",
  "ort-wasm-simd-threaded.mjs",
];

const ORT_BASE = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0-dev.20250409-89f8206ba4/dist";

function downloadFile(url, dest, label) {
  return new Promise((resolve, reject) => {
    if (existsSync(dest) && statSync(dest).size > 0) {
      const mb = (statSync(dest).size / 1024 / 1024).toFixed(2);
      console.log(`[skip] ${label} already present (${mb} MB)`);
      return resolve();
    }

    const tmp = `${dest}.tmp`;
    const follow = (curUrl, redirects = 5) => {
      https
        .get(curUrl, (res) => {
          const status = res.statusCode ?? 0;
          if (
            (status === 301 || status === 302 || status === 307 || status === 308) &&
            res.headers.location &&
            redirects > 0
          ) {
            res.resume();
            return follow(new URL(res.headers.location, curUrl).toString(), redirects - 1);
          }
          if (status !== 200) {
            return reject(new Error(`HTTP ${status} fetching ${curUrl}`));
          }
          const file = createWriteStream(tmp);
          const total = Number.parseInt(res.headers["content-length"] ?? "0", 10);
          let got = 0;
          let last = 0;
          res.on("data", (chunk) => {
            got += chunk.length;
            if (total && Date.now() - last > 300) {
              process.stdout.write(
                `\r  ${label}: ${(got / 1024 / 1024).toFixed(1)} / ${(total / 1024 / 1024).toFixed(1)} MB`,
              );
              last = Date.now();
            }
          });
          res.pipe(file);
          file.on("finish", () => {
            file.close(() => {
              import("node:fs").then(({ renameSync }) => {
                renameSync(tmp, dest);
                if (total) {
                  process.stdout.write(
                    `\r  ${label}: ${(total / 1024 / 1024).toFixed(1)} MB [done]\n`,
                  );
                } else {
                  console.log(`  ${label} [done]`);
                }
                resolve();
              });
            });
          });
          file.on("error", (err) => {
            reject(err);
          });
        })
        .on("error", reject);
    };

    follow(url);
  });
}

console.log("=== Bundling ONNX WASM & WebGPU runtime ===");
for (const fileName of RUNTIME_FILES) {
  const dest = join(wasmDir, fileName);
  let copied = false;
  for (const localDir of localDistDirs) {
    const src = join(localDir, fileName);
    if (existsSync(src)) {
      copyFileSync(src, dest);
      const mb = (statSync(dest).size / 1024 / 1024).toFixed(2);
      console.log(`[local] Copied ${fileName} (${mb} MB)`);
      copied = true;
      break;
    }
  }

  if (!copied) {
    await downloadFile(`${ORT_BASE}/${fileName}`, dest, fileName);
  }
}

console.log("ONNX runtime bundled successfully.");
