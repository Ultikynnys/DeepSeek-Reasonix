// Bundles the ONNX WASM runtime into desktop/public/ so Vite and Tauri bundle
// it offline with the app. Whisper models are NOT bundled — they download on
// demand at runtime (into the browser cache) to keep the app bundle small.
import { createWriteStream, existsSync, mkdirSync, statSync } from "node:fs";
import https from "node:https";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const publicDir = join(here, "..", "public");
const wasmDir = join(publicDir, "wasm");

mkdirSync(wasmDir, { recursive: true });

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

const ORT_BASE = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.14.0/dist";

const WASM_FILES = [
  { url: `${ORT_BASE}/ort-wasm.wasm`, dest: join(wasmDir, "ort-wasm.wasm"), name: "ort-wasm.wasm" },
  {
    url: `${ORT_BASE}/ort-wasm-simd.wasm`,
    dest: join(wasmDir, "ort-wasm-simd.wasm"),
    name: "ort-wasm-simd.wasm",
  },
  {
    url: `${ORT_BASE}/ort-wasm-threaded.wasm`,
    dest: join(wasmDir, "ort-wasm-threaded.wasm"),
    name: "ort-wasm-threaded.wasm",
  },
  {
    url: `${ORT_BASE}/ort-wasm-simd-threaded.wasm`,
    dest: join(wasmDir, "ort-wasm-simd-threaded.wasm"),
    name: "ort-wasm-simd-threaded.wasm",
  },
];

console.log("=== Bundling ONNX WASM runtime ===");
for (const file of WASM_FILES) {
  await downloadFile(file.url, file.dest, file.name);
}

console.log("ONNX WASM runtime bundled successfully.");
