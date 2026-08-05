// Pulls the Node 22 runtime for Windows into desktop/src-tauri/binaries/.
// The Windows installer bundles node.exe alongside the app (see
// tauri.windows.conf.json). Other platforms aren't packaged.
import { execSync } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import https from "node:https";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const NODE_VERSION = "22.13.0";

const here = dirname(fileURLToPath(import.meta.url));
const binDir = join(here, "..", "src-tauri", "binaries");

if (process.platform !== "win32") {
  console.error("Windows-only: run this script on win32 (the release workflow does).");
  process.exit(1);
}

const targetExe = join(binDir, "node.exe");

if (existsSync(targetExe) && statSync(targetExe).size > 1024 * 1024) {
  const mb = (statSync(targetExe).size / 1024 / 1024).toFixed(1);
  console.log(`${targetExe} already present (${mb} MB) — delete to refetch`);
  process.exit(0);
}

mkdirSync(binDir, { recursive: true });

function follow(url, dest, redirects = 5) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, (res) => {
      const status = res.statusCode ?? 0;
      if ((status === 301 || status === 302 || status === 307 || status === 308) && res.headers.location && redirects > 0) {
        res.resume();
        follow(new URL(res.headers.location, url).toString(), dest, redirects - 1).then(resolve, reject);
        return;
      }
      if (status !== 200) {
        reject(new Error(`HTTP ${status} fetching ${url}`));
        return;
      }
      const file = createWriteStream(dest);
      const total = Number.parseInt(res.headers["content-length"] ?? "0", 10);
      let got = 0;
      let last = 0;
      res.on("data", (chunk) => {
        got += chunk.length;
        if (total && Date.now() - last > 250) {
          process.stdout.write(`\r  ${(got / 1024 / 1024).toFixed(1)} / ${(total / 1024 / 1024).toFixed(1)} MB`);
          last = Date.now();
        }
      });
      res.pipe(file);
      file.on("finish", () => file.close((err) => (err ? reject(err) : resolve())));
      file.on("error", reject);
    });
    req.on("error", reject);
  });
}

async function fetchAndExtract() {
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  const archiveBase = `node-v${NODE_VERSION}-win-${arch}`;
  const archiveFile = `${archiveBase}.zip`;
  const url = `https://nodejs.org/dist/v${NODE_VERSION}/${archiveFile}`;
  const archivePath = join(binDir, archiveFile);
  const extractDir = join(binDir, "_extract");

  console.log(`Downloading ${archiveFile} ...`);
  await follow(url, archivePath);
  process.stdout.write("\n");

  rmSync(extractDir, { recursive: true, force: true });
  mkdirSync(extractDir, { recursive: true });

  console.log("Extracting ...");
  execSync(
    `powershell -NoProfile -Command "Expand-Archive -Force -Path '${archivePath}' -DestinationPath '${extractDir}'"`,
    { stdio: "inherit" },
  );

  const inner = join(extractDir, archiveBase, "node.exe");
  if (!existsSync(inner)) {
    console.error(`Extracted binary not found at expected path: ${inner}`);
    process.exit(1);
  }

  rmSync(archivePath);
  return { inner, extractDir };
}

const { inner, extractDir } = await fetchAndExtract();

if (existsSync(targetExe)) rmSync(targetExe);
renameSync(inner, targetExe);
rmSync(extractDir, { recursive: true, force: true });

const mb = (statSync(targetExe).size / 1024 / 1024).toFixed(1);
console.log(`Done: ${targetExe} (${mb} MB)`);
