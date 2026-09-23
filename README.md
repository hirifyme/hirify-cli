# Hirify CLI

Search jobs, read your feeds and work with your Hirify account from a terminal or an AI agent.
The npm package is **hirify-cli**; the executable is **hirify**.

## Install

Node 18 or newer is required. Node 22 and 24 are the primary test lanes; 18 and 20 remain compatibility lanes.
Windows, macOS and Linux use the same npm artifact. Native desktop browser acceptance is a separate release check.

```sh
npm install -g hirify-cli
hirify --help
npx skills add hirifyme/hirify-cli
```

For a one-off sign-in, run `npx hirify-cli login`.
Without a global install, use `npx -y hirify-cli <command>`. npm may cache the package;
use `npx -y hirify-cli@<version>` when the version must be reproducible.
The skill supplies the agent's working rules; it does not install the executable.

## Sign in

```sh
hirify login
hirify auth status --json
```

Login prints a link first and tries the default browser when the terminal and environment permit it.
A launcher result does not prove that a browser opened. Confirm access yourself; agents should ask
you to do this. The callback listens only on a loopback IP, on a temporary port. PKCE and state
protect the exchange. The CLI reports success after access has been saved, independently of the account summary.

| Environment | Behavior |
|---|---|
| Local desktop terminal | Prints the link, tries the browser, waits for confirmation |
| Linux without a display | Prints the link; does not promise or try a graphical browser |
| Non-interactive terminal, CI, agent pipe | Fails promptly if a new browser sign-in is needed; use a key or explicit manual login |
| SSH | Requires explicit manual login and a forwarded fixed callback port, or a key |
| Container | Use a key, or manual login only if the browser can reach the container's loopback callback |
| WSL | Uses the maintained browser launcher when local and interactive; verify Windows-to-WSL loopback on your setup |

`hirify login --no-browser` prints the link without launching anything. It still needs a reachable
callback; it is not device authorization. For SSH, open a local terminal and run:

```sh
ssh -L 8765:127.0.0.1:8765 your-host
hirify login --no-browser --callback-port 8765
```

Open the printed link on the computer that owns the tunnel. Confirm access within five minutes;
a reminder appears every 30 seconds. Ctrl+C cancels and closes the listener. Start a fresh login
after cancellation. `hirify login --force` replaces an existing or unusable sign-in.

For unattended work, obtain a key at [API access](https://hirify.me/account/api-access), supply it
as `HIRIFY_KEY`, or pipe it to `hirify auth --stdin`. Avoid putting keys in shell history with
`hirify auth <key>`; that legacy form is still accepted. Never put a real key in a support report.
`HIRIFY_KEY` takes precedence over the saved sign-in. `hirify logout` removes local access only;
it neither clears your environment nor revokes access on the server.

## Work with jobs

```sh
hirify account show
hirify feed list
hirify feed show <id>
hirify filter guide
hirify vacancy search "senior go"
hirify vacancy read <slug>
hirify vacancy reveal <slug>
hirify vacancy hide <slug>...
hirify company hide "<name>"
hirify hidden list
hirify profile list
hirify vacancy apply <slug> --profile <id> --cover-file cover.txt
```

Lists and searches are free. Reading a vacancy in full, revealing its contact, and applying each
have a separate allowance. `hirify account show` supplies the current values. Shortlist from cards,
read to assess fit, then reveal what fits. Applying sends a real application and cannot be recalled:
get the person's approval first. External vacancies are applied to through the destination from `reveal`.
Hiding a vacancy or a company is free and has no limit: it stops coming back in search and feeds,
here and on the website. `--undo` brings it back; `hirify hidden list` shows what is hidden.

The server defines search filters. Read `hirify filter guide`, preview with `filters.preview`, refine,
and then run the final search. Do not infer filter names from an old example.

More commands: `hirify feed create`, `hirify feed deliver`, `hirify webhook list`,
`hirify webhook create`, `hirify feedback send`. Use each command's `--help` for arguments.
Webhook creation returns a secret once; save it securely. Feedback can be received or queued;
retain its reference and do not promise a reply or a fix.

## Scripts and agents

Successful `--json` data envelopes are preserved. Human text may change; parse JSON instead.
`--fields a,b` narrows human output. Use `--error-format=json` for a versioned error object on stderr.
Progress and diagnostic events also go to stderr; omit `--debug` when stderr must contain only errors.
Default generic `api call` still prints a server error body on stdout; structured-error mode suppresses it.

```sh
hirify capabilities list --json
hirify capabilities show <capability> --json
hirify api call <capability> --data-file request.json --json --error-format=json
```

`--data-file -` and `--cover-file -` read stdin. Files preserve quotes and Unicode without shell
escaping; JSON input must be an object. These inputs are limited to 1 MiB. Use a file for a
server-requested recovery action; never paste a server string into shell code.

Options support `--name value`, `--name=value`, and `--` before literal positional arguments.
Unknown options are rejected except server-owned search filters. Conflicting options and missing
values fail before requests. `--help` and `version` do not authenticate or update.

| Exit | Meaning |
|---|---|
| 0 | Success |
| 1 | Invalid arguments, authentication, network, server or local state error; inspect the error code |
| 2 | Server manifest version unsupported; update the CLI |
| 130 / 143 | SIGINT / SIGTERM cancellation on platforms delivering these signals |

Common error codes include `interaction_required`, `auth_required`, `state_corrupt`,
`issuer_mismatch`, `network_timeout`, `tls_error`, `command_timeout`, and `outcome_unknown`.
For `outcome_unknown`, check the account/server result before retrying: an application or change
may already have happened. Metered reads and mutations are never retried automatically.
Explicitly safe reads get bounded retries for transient network errors and 429/502/503/504.
Feedback accepts `--idempotency-key` when the server advertises caller-keyed deduplication;
keep the same key for a deliberate retry. The CLI prints a generated request reference otherwise.

## Codex and other sandboxed agents

Sign in once from your normal terminal. A local agent can reuse that sign-in when it has access
to the same configuration directory. It does not need a separate API key.
Reading an unexpired session does not create files or change permissions. Renewing an OAuth
session requires write access so the rotated token can be saved safely.

A Windows Codex sandbox can run with a restricted token or a different Windows account. Success
in `cmd` therefore does not prove the sandbox can access the saved sign-in. Keep credentials in
their normal private directory. If a command is denied, let Codex request approval for that specific
command using its normal permission mechanism. Do not disable the whole sandbox, grant `Everyone`
access, copy `auth.json` into the project, or paste a token into chat.
Read permission alone will not support token renewal. If approval is unavailable, report the
restriction instead of repeatedly running login. WSL and containers have separate home directories;
a Windows login is not automatically shared with them.

Compare `hirify version`, `hirify doctor`, and `hirify auth status --json --error-format=json`
inside the agent and in the terminal. These commands do not print tokens. `storage_unreadable`
means reading was denied or failed; `storage_unavailable`, `storage_lock_failed`, and
`storage_write_failed` identify preparation, locking, or saving failures. An access failure does
not by itself mean the sign-in expired. See [Codex Windows sandbox documentation](https://learn.chatgpt.com/docs/windows/windows-sandbox).

## Configuration and diagnostics

Access is stored in `auth.json` under `$XDG_CONFIG_HOME/hirify` when XDG_CONFIG_HOME is absolute,
otherwise `~/.config/hirify`, including Windows. POSIX directories/files use 0700/0600;
Windows uses a DACL for the current user. The file is not encrypted. Atomic writes and a shared
lock protect new CLI processes. Credentials are bound to the server that issued them.
A malformed file does not silently fall back to another identity. `login --force`, `auth --stdin`,
or `logout` can recover local state. Uncertain refresh rotation requires a new login.

| Setting | Purpose |
|---|---|
| `HIRIFY_KEY` | Credential for this process; overrides the saved sign-in |
| `HIRIFY_API` | Trusted server origin; HTTPS required except literal loopback HTTP for development |
| `XDG_CONFIG_HOME` | Absolute configuration base directory |
| `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`, `NO_PROXY` | Proxy selection; lowercase variants are supported |
| `NODE_EXTRA_CA_CERTS` | Additional trusted CA PEM file, set before starting Node |
| `BROWSER` | Explicit browser executable path, without shell arguments |
| `HIRIFY_NO_AUTO_UPDATE=1` | Disable automatic checking/installing, retaining an already active version |
| `HIRIFY_VERSION_PIN` | Exact version selection; disables automatic updates |
| `HIRIFY_DEBUG=1` / `--debug` | Sanitized local phase/reason events, never raw HTTP bodies |

TLS verification remains enabled. Redirects are rejected rather than forwarding credentials.
The usual command deadline is 30 seconds; login allows six minutes including network work,
and explicit update five minutes. `--timeout <seconds>` overrides it up to 3600 seconds.

Run `hirify doctor` for local platform, runtime, sign-in source and install-owner information.
It does not contact the API or expose token values. It may run `npm root --global` locally.
Attach its output and a sanitized `--debug` trace to a support request. There is no remote telemetry.
The login URL is sensitive and intentionally printed for the person; omit it from reports.

## Updates and rollback

Verified npm-global installations retain automatic updates before API commands. Local installs,
checkouts and npx executions do not update themselves. Failed checks are distinguishable from
"up to date" and the existing CLI remains usable. To make automation reproducible, set
`HIRIFY_NO_AUTO_UPDATE=1` and install an exact version.

```sh
hirify update --check
hirify update <version>
hirify update --rollback
hirify version
```

Updates install an exact version into a private per-user directory, verify the artifact and switch
an atomic pointer. They never overwrite executing global files. Exact versions and rollback are
pinned. An unavailable HIRIFY_VERSION_PIN fails explicitly; it never silently runs another version.
Unset that environment pin before selecting a different version or rolling back. `hirify update` without a version checks latest and removes the pin when it changes version.
The global npm package remains the bootstrap, so `npm list -g` can report its older version;
`hirify version` reports the active CLI. Replacing the bootstrap with npm invalidates its old pointer.
Old managed artifacts are retained for rollback. A checked version must support this update protocol.

Checks and installs use the same configured HTTPS npm registry. Registries requiring credentials
for metadata requests are currently unsupported by the CLI checker; use npm directly for them.
The updater respects Node compatibility and disables npm lifecycle scripts during staging.

Before migrating, finish processes running older CLI versions: they do not honor the new lock.
The existing credential path and legacy key import are retained, with additive schema metadata.
For downgrade outside this generation, use an exact npm version with auto-update disabled and
sign in again if needed. A copied refresh token cannot undo token rotation. Never run old and new
writers concurrently. A failed update before pointer activation leaves the prior version active.

See [the agent reference](skills/hirify/reference.md) and [release checks](scripts/RELEASE.md).
