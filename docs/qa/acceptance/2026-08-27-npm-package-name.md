# Acceptance: publishable npm package name

- Source: Admin asked to make the public CLI installable from npm.
- Environment: local and public npm registry. Mutations: no product mutation during acceptance.

## Criteria

1. `eco worktree verify` proves the tester is on the exact supplied commit.
2. `npm test` passes without network-dependent test behavior.
3. `npm pack --dry-run --json` identifies `hirify-cli@0.4.1` and contains only the intended seven
   runtime files.
4. Installing the packed tarball into a fresh temporary prefix exposes a working `hirify` binary;
   `hirify --help` exits zero and names the supported commands.
5. Public installation text consistently names `npm install -g hirify-cli` and
   `npx hirify-cli`; no shipped text still instructs `npx hirify` or installs package `hirify`.
6. The diff from public GitHub tag `v0.4.0` is limited to the npm package name, patch version,
   corresponding install text, its focused test, and this acceptance specification.
