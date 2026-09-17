# CLI verification and release

Builds are candidates until platform and browser acceptance is recorded. These commands use local
fixtures and isolated prefixes; they do not require a real account. Publishing requires separate
operator authorization. No CI job publishes or changes production.

## Reproducible candidate

Use a clean branch based on public `main`, not a local branch with unrelated history. Confirm npm
package `hirify-cli`, executable `hirify`, public source and published version before choosing the
next version. The current refactor is `0.5.0-rc.1`, an unpublished candidate, not a claim of release.

```sh
npm ci --ignore-scripts
npm test
npm run build
npm run test:package
npm run test:install
npm audit --omit=dev
```

`build` checks metadata, syntax, skill budget and artifact allowlist, and writes a tarball plus
`release-manifest.json` in `.artifacts`. It records source SHA, dirty status, integrity and file hashes.
`test:package` installs that tarball in a temporary npm prefix with spaces, verifies every packaged
file, and invokes the native executable shim. `test:install` uses real npm with a synthetic local
HTTPS registry to stage, activate, execute and roll back the artifact. Test PEM files are synthetic,
public fixture keys, never production credentials; they are excluded from the package.

CI builds once and gives the same tarball to Windows/macOS/Linux on Node 22/24, plus Linux Node18/20
compatibility lanes. CLI subprocess tests run against the installed artifact. Module tests use
source from the same commit; the artifact hash check proves their runtime source is identical.
All actions are pinned. Keep CI logs and the artifact's SHA256 with acceptance evidence.

## Native manual acceptance on every release candidate

On **Windows** use both PowerShell and cmd.exe; on **macOS** use Terminal; on **Linux** use a desktop
terminal and a separate headless/SSH session. Install Node22 or 24, clone the candidate commit and
receive the **same tested tarball and release-manifest.json** in `.artifacts/` alongside the
candidate source checkout. Do not rebuild separately on each OS: that would test different artifacts.
Run the following commands on each native machine. `--test` runs the full subprocess suite against
the isolated installed package, then removes the temporary installation.

```sh
npm ci --ignore-scripts
npm run test:package -- --test
npm run test:install
node scripts/browser-smoke.mjs
node scripts/browser-smoke.mjs --no-browser
```

`npm run build` belongs to the single artifact-producing job only. Do not substitute a Linux mock
for native results. For an unpublished candidate, transfer its source bundle and `.artifacts/`
privately rather than publishing a package just to test it.

1. Run `node scripts/browser-smoke.mjs` in each desktop terminal, with `BROWSER` unset. The real
   default browser must open, visit the synthetic authorization endpoint with all parameters
   intact, return to the loopback callback and show PASS in the terminal. No real consent is used.
   Repeat with `--no-browser`, opening the printed link manually. Repeat with the browser launcher
   unavailable: the link must still be usable. Do not change the user's default browser for a test.
2. Run the smoke again, press Ctrl+C before opening its link, then immediately restart it. The
   cancelled run must not save access; the next run must bind and complete. Close a tab without
   confirming and verify a bounded timeout. The fixture redirects immediately after it is opened,
   so cancel before opening in manual mode.
3. On Linux run `npm test` inside a container without DISPLAY and without production credentials.
   In a disposable SSH account run `hirify login`: expect `interaction_required`. Run manual
   login with a fixed port and a matching `ssh -L` tunnel against a **staging** issuer; confirm the
   callback reaches the CLI host. Never expose the listener on 0.0.0.0. Repeat WSL-to-Windows browser
   smoke where WSL is supported. An unforwarded container callback must fail with timeout, not success.
4. Windows ACL: use an isolated XDG_CONFIG_HOME, pipe a synthetic key to `hirify auth --stdin`, inspect
   `(Get-Acl "$env:XDG_CONFIG_HOME\hirify\auth.json").Access`, and try reading it as another ordinary
   local user with `runas`. Expect access denied. Repeat after refresh, logout and update.
   On macOS/Linux inspect directory/file modes (`stat`): 0700/0600, and verify another user cannot read.
5. Run `npm run test:install` from a checkout path containing spaces and Unicode on all OSes.
   While a staged npm installation is active, interrupt it and verify the prior `hirify version`
   remains executable. Run two updates concurrently, then rollback; prior version must be retained.
   On Windows verify no orphan npm/node child process remains after cancellation.
6. With a **staging** account only: browser consent success/denial, existing scopes, legacy credential
   migration, refresh rotation, expired/revoked refresh and forced re-login. Stop all older CLI writers
   first. Drop a token response after the server rotates; the next command must require re-login.
   Check server logs for exactly one refresh across concurrent processes. A real production flow is
   a separate authorized verification, never part of automated tests.
7. Corporate proxy: run `npm run test:install` and tests behind the intended proxy/CA configuration;
   verify authenticated CONNECT and NO_PROXY. A registry requiring authenticated metadata should be
   managed with npm directly, not this CLI updater. Do not disable certificate verification.

## Migration and rollback

The existing config path and success JSON envelopes remain. Errors gain an opt-in schema; unknown
options, malformed successes, cross-origin metadata and missing flag values now fail deliberately.
No browser success is inferred from spawn alone. A saved sign-in is successful even when an optional
account read would fail. Refresh and logout use the same transaction lock and generation check.

This version is the credential-protocol bridge: metadata is additive, but older versions do not
honor its lock or refresh-pending marker. Finish their processes before migration. Prefer rollback
within this generation using `hirify update --rollback`, which pins the result. For a pre-bridge
fallback, set HIRIFY_NO_AUTO_UPDATE=1, install the exact archived npm version, terminate concurrent
writers and reauthenticate. Never restore a backup refresh token that may already have rotated.

Updates activate verified immutable per-user directories. The global npm package remains the
bootstrap; replacing it with npm resets its old activation pointer. Keep known-good tarballs and
integrities outside the ephemeral npm cache. No automatic garbage collection removes rollback copies.

## Publication gate (only after separate authorization)

Do not publish an untested rebuild. Verify public main equals the clean tested commit. Attach a
receipt to the exact artifact, in `.artifacts/acceptance.json`:

```json
{"source_commit":"<tested commit>","sha256":"<tarball SHA256>","passed":["windows","macos","linux","browser","consent"]}
```

Each entry requires linked evidence in the release record; this file is an attestation, not a test.
Set `HIRIFY_PUBLISH_APPROVED=1` only after the operator authorizes publication, then run
`node scripts/prepublish-check.mjs` explicitly. It fails closed on missing receipt, dirty/drifted
source or artifact, and unavailable public repository checks. Publish the already verified tarball
using the approved npm identity/provenance workflow; do not invoke a fresh source-directory build.
Never use `--ignore-scripts` to evade publication gates. CI and local build do not grant authorization.
Align the npm dist-tag, GitHub source, version, skill and release evidence in one approved operation.
A rollback of a published release requires its own authorization; publish a new fix version rather
than overwriting an existing npm version or public history.
