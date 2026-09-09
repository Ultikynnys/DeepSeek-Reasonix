// Pulls the Playwright MCP Chrome extension into desktop/src-tauri/binaries/
// so the Windows installer can bundle it as an offline/unpacked-install
// fallback (see tauri.windows.conf.json → assets/playwright-extension).
// The primary install path is the Chrome Web Store — this exists for users
// who can't reach it.
//
// The extension ships no prebuilt artifact (source lives in the playwright
// monorepo, packages/extension/, built by its own tooling), so we fetch the
// signed CRX from the Chrome Web Store's public download endpoint and strip
// the CRX3 envelope: magic "Cr24" + u32 version + u32 header length, then the
// zip payload starts at 12 + headerLen. No protobuf parsing needed.
//
// Windows-only, run before `tauri build` (same contract as bundle:node —
// tauri refuses to build when a resources-map source dir is missing).
// Other platforms aren't packaged.
import { execSync } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import https from "node:https";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// "Playwright Extension" — official store listing by Microsoft.
const EXTENSION_ID = "mmlmfjhmonkocbjadbfplnigmagldckm";

const here = dirname(fileURLToPath(import.meta.url));
const binDir = join(here, "..", "src-tauri", "binaries");
const targetDir = join(binDir, "playwright-extension");

if (process.platform !== "win32") {
  console.error("Windows-only: run this script on win32 (the release workflow does).");
  process.exit(1);
}

if (existsSync(join(targetDir, "manifest.json"))) {
  console.log(`${targetDir} already present — delete it to refetch`);
  process.exit(0);
}

mkdirSync(binDir, { recursive: true });

function follow(url, dest, redirects = 5) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, (res) => {
      const status = res.statusCode ?? 0;
      if (
        (status === 301 || status === 302 || status === 307 || status === 308) &&
        res.headers.location &&
        redirects > 0
      ) {
        res.resume();
        follow(new URL(res.headers.location, url).toString(), dest, redirects - 1).then(
          resolve,
          reject,
        );
        return;
      }
      if (status !== 200) {
        reject(new Error(`HTTP ${status} fetching ${url}`));
        return;
      }
      const file = createWriteStream(dest);
      let got = 0;
      res.on("data", (chunk) => {
        got += chunk.length;
        if (got % (512 * 1024) < chunk.length) {
          process.stdout.write(`\r  ${(got / 1024).toFixed(0)} KB`);
        }
      });
      res.pipe(file);
      file.on("finish", () => file.close((err) => (err ? reject(err) : resolve())));
      file.on("error", reject);
    });
    req.on("error", reject);
  });
}

/** CRX3 = 4-byte magic "Cr24" + u32 version + u32 header length, then zip bytes. */
function crxZipSlice(buf) {
  const magic = buf.subarray(0, 4).toString("latin1");
  if (magic !== "Cr24") throw new Error(`not a CRX file (magic ${JSON.stringify(magic)})`);
  const version = buf.readUInt32LE(4);
  if (version !== 3) throw new Error(`unexpected CRX version ${version} — expected CRX3`);
  const headerLen = buf.readUInt32LE(8);
  return buf.subarray(12 + headerLen);
}

async function fetchAndExtract() {
  const crxUrl =
    `https://clients2.google.com/service/update2/crx` +
    `?response=redirect&prodversion=130&acceptformat=crx3` +
    `&x=id%3D${EXTENSION_ID}%26uc`;
  const crxPath = join(binDir, "_playwright-extension.crx");
  const extractDir = join(binDir, "_extension-extract");

  console.log("Downloading Playwright Extension CRX ...");
  await follow(crxUrl, crxPath);
  process.stdout.write("\n");

  const buf = readFileSync(crxPath);
  const zip = crxZipSlice(buf);

  rmSync(extractDir, { recursive: true, force: true });
  mkdirSync(extractDir, { recursive: true });
  const zipPath = join(extractDir, "extension.zip");
  writeFileSync(zipPath, zip);

  console.log("Extracting ...");
  execSync(
    `powershell -NoProfile -Command "Expand-Archive -Force -Path '${zipPath}' -DestinationPath '${extractDir}'"`,
    { stdio: "inherit" },
  );

  // The zip may nest one folder — find where manifest.json actually landed.
  const entries = readdirSync(extractDir);
  const withManifest = entries.find((e) => existsSync(join(extractDir, e, "manifest.json")));
  if (!withManifest) {
    console.error(`No manifest.json found after extracting (entries: ${entries.join(", ") || "none"})`);
    process.exit(1);
  }
  const inner = join(extractDir, withManifest);
  rmSync(crxPath);
  rmSync(zipPath);
  return { inner, extractDir };
}

const { inner, extractDir } = await fetchAndExtract();

rmSync(targetDir, { recursive: true, force: true });
// robocopy exits 1 on successful copy — execSync would treat that as a throw,
// so tolerate any exit and verify the result directly instead.
try {
  execSync(`robocopy "${inner}" "${targetDir}" /E /NFL /NDL /NJH /NJS`, { stdio: "ignore" });
} catch {
  /* verified below */
}
if (!existsSync(join(targetDir, "manifest.json"))) {
  console.error(`Copy failed — manifest.json not found in ${targetDir}`);
  process.exit(1);
}
const manifest = JSON.parse(readFileSync(join(targetDir, "manifest.json"), "utf8"));
writeFileSync(join(targetDir, "_store_version.txt"), String(manifest.version ?? "unknown"));
rmSync(extractDir, { recursive: true, force: true });

const fileCount = readdirSync(targetDir).length;
console.log(`Done: ${targetDir} (v${manifest.version}, ${fileCount} entries)`);