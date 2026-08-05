# Reasonix Desktop — code signing

Walkthrough for shipping a signed Reasonix Desktop bundle (Windows installer).

The release workflow at `.github/workflows/release.yml` reads everything
below from repository **Secrets** — nothing in this repo holds keys.
Without these secrets set the workflow still builds, but installers come
out unsigned (Windows shows SmartScreen warnings).

## Tauri updater signing

Tauri's updater verifies bundle artifacts against a public key embedded
in the app. Generate once and commit the **public** half to
`tauri.conf.json`.

```bash
cd desktop
npx @tauri-apps/cli signer generate -w ~/.tauri/reasonix.key
```

Outputs:
- `~/.tauri/reasonix.key` — the **private** key. Never commit. Add a
  passphrase when prompted.
- `~/.tauri/reasonix.key.pub` — paste into `tauri.conf.json` under
  `plugins.updater.pubkey`, replacing `REPLACE_ME_RUN_tauri_signer_generate`.

Set repo secrets:
- `TAURI_SIGNING_PRIVATE_KEY` — full contents of `~/.tauri/reasonix.key`
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` — the passphrase

The workflow exports both as env vars; `tauri-action` picks them up and
signs the per-platform update bundle (`*.zip.sig`, `*.msi.zip.sig`, …)
automatically.

## Windows — Authenticode

You need a **code signing certificate** from a CA Microsoft trusts
(DigiCert, Sectigo, SSL.com, …). EV certs avoid SmartScreen reputation
ramp; OV certs work but warn until enough installs build trust.

### One-time: export the cert as PFX

The CA either ships a `.pfx` directly or a `.cer` + private key. If you
get the latter, combine with `openssl`:

```bash
openssl pkcs12 -export \
  -inkey reasonix.key \
  -in reasonix.cer \
  -out reasonix.pfx \
  -name "Reasonix Code Signing"
```

Set a strong export password — needed below.

### Wire into the release workflow

Tauri v2 reads three env vars on Windows:

| Secret | What it is |
|---|---|
| `WINDOWS_CERTIFICATE` | base64-encoded contents of `reasonix.pfx` |
| `WINDOWS_CERTIFICATE_PASSWORD` | the PFX export password |

Encode the cert before adding the secret:

```bash
base64 -w0 reasonix.pfx > reasonix.pfx.b64
```

The release workflow passes both to the `Build Tauri bundle (signed)`
step (gated on `WINDOWS_CERTIFICATE` being set); `tauri-action` v0
detects them and signs both the `.msi` and the `.exe` produced by NSIS.

### Verify locally before pushing the tag

```powershell
signtool verify /pa /v Reasonix_0.40.0_x64-setup.exe
```

Output should include `Successfully verified` and the certificate's
common name.

## Updater pubkey rotation

Rotating the updater key invalidates every previously installed
client's ability to verify updates. Avoid unless the private key
leaked. If it must happen:

1. Generate a new key pair (`tauri signer generate`).
2. Ship one transitional release signed with the **old** key whose
   notes tell users to download fresh installers manually.
3. Replace `tauri.conf.json#plugins.updater.pubkey` in the next release.
4. Update `TAURI_SIGNING_PRIVATE_KEY` in repo secrets.

## Troubleshooting

- **"The signature of the application is invalid"** after an update —
  almost always means the updater's `pubkey` in `tauri.conf.json`
  doesn't match the private key used by the workflow. Confirm both
  halves come from the same `signer generate` run.
- **SmartScreen still warns "Unknown publisher"** after signing — the
  warning persists until enough users install the signed build to
  build reputation; EV certs ramp faster than OV.
