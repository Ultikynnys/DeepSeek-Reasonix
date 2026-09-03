// Bundles the lightweight Xenova/whisper-tiny.en model and ONNX WASM runtime
// into desktop/public/ so Vite and Tauri bundle them offline with the app.
import { createWriteStream, existsSync, mkdirSync, statSync } from "node:fs";
import https from "node:https";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const publicDir = join(here, "..", "public");
const modelDir = join(publicDir, "models", "whisper-tiny.en");
const modelOnnxDir = join(modelDir, "onnx");
const wasmDir = join(publicDir, "wasm");

mkdirSync(modelDir, { recursive: true });
mkdirSync(modelOnnxDir, { recursive: true });
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

const HF_BASE = "https://huggingface.co/Xenova/whisper-tiny.en/resolve/main";
const ORT_BASE = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.14.0/dist";

const MODEL_FILES = [
  { url: `${HF_BASE}/config.json`, dest: join(modelDir, "config.json"), name: "config.json" },
  {
    url: `${HF_BASE}/generation_config.json`,
    dest: join(modelDir, "generation_config.json"),
    name: "generation_config.json",
  },
  {
    url: `${HF_BASE}/preprocessor_config.json`,
    dest: join(modelDir, "preprocessor_config.json"),
    name: "preprocessor_config.json",
  },
  {
    url: `${HF_BASE}/tokenizer.json`,
    dest: join(modelDir, "tokenizer.json"),
    name: "tokenizer.json",
  },
  {
    url: `${HF_BASE}/tokenizer_config.json`,
    dest: join(modelDir, "tokenizer_config.json"),
    name: "tokenizer_config.json",
  },
  {
    url: `${HF_BASE}/onnx/encoder_model_quantized.onnx`,
    dest: join(modelOnnxDir, "encoder_model_quantized.onnx"),
    name: "encoder_model_quantized.onnx",
  },
  {
    url: `${HF_BASE}/onnx/decoder_model_merged_quantized.onnx`,
    dest: join(modelOnnxDir, "decoder_model_merged_quantized.onnx"),
    name: "decoder_model_merged_quantized.onnx",
  },
];

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

console.log("=== Bundling lightweight transcription model ===");
for (const file of MODEL_FILES) {
  await downloadFile(file.url, file.dest, file.name);
}

console.log("=== Bundling ONNX WASM runtime ===");
for (const file of WASM_FILES) {
  await downloadFile(file.url, file.dest, file.name);
}

console.log("Transcription model and WASM runtime bundled successfully.");
