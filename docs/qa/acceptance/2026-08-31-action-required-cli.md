# Focused acceptance: CLI action_required gate

This is a narrow independent acceptance of the post-release CLI delta only. Do not replay API,
frontend, or the full Security FSM release acceptance.

## Exact target

- CLI pin: `30d11406f70a24d68fa56ec4eb74680010183abd`; source: `git rev-parse HEAD` in the isolated CLI master worktree after the package version bump.
- Previously accepted CLI base: `4ff1535f17345e900b03cfe6fc4070d697d680a2`; source: `/home/igora/hirify-qa/2026-08-30-api-security-fsm/verdict.md`.
- Behavior commits between the accepted base and target: `3c8c2b4` and `2b91392`; source: `git log --oneline 4ff1535..30d1140`.
- Package version commit: `30d1140`; source: `git log -1 --oneline 30d1140`.

## Acceptance

1. Run `eco worktree verify` before inspection and again after the mutation is reverted. The exact
   target must be checked out and the final tree must be clean; source: tester command output.
2. Human CLI handling of canonical `error.code=action_required` must exit nonzero, print no useful
   result, make no automatic retry, and print the server notice plus a directly executable
   `hirify api call security.notices.ack --data ...` command containing the notice `id` and the
   advertised `action`; source: `bin/hirify.js` and executable CLI tests at the target pin.
3. Raw `hirify api call` must preserve the structured `action_required` envelope without replacing
   it with the human rendering; source: executable CLI test at the target pin.
4. An ordinary conflict and the existing `access_restricted` handling must retain their previous
   behavior; source: executable CLI tests at the target pin.
5. `package.json` must report `0.4.4`, while `npm run prepublishOnly` must pass without publishing;
   source: `node -p "require('./package.json').version"` and the prepublish command output.
6. Run the repository CLI test command and the prepublish check only. Do not run any API, frontend,
   database, Filament, browser, or full-release suite; source: this acceptance boundary.
7. Perform one focused mutation that disables recognition of `action_required` or turns it back
   into a successful notice. Save the red result, revert the mutation, rerun the directly affected
   tests or the small CLI suite, and save the green result; source: tester evidence files.

## Verdict artifact

Write the verdict and evidence under
`/home/igora/hirify-qa/2026-08-31-cli-agent-notice-gate/`. The verdict must explicitly state the
exact target pin, the focused checks run, the mutation red/green result, and final hermetic status.
Send one RESULT mail to the Security FSM master. Do not push or publish.
