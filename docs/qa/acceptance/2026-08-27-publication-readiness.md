# Hirify CLI publication readiness acceptance

- Source: Admin request on 27 August to verify public copy, make filter preview mandatory in the
  installed skill, and publish GitHub and npm together.
- Environment: pinned local worktree and local test servers. No production mutation during
  acceptance.

## Criteria

1. `eco worktree verify` proves the tester is on the supplied clean, hermetic pin.
2. `node scripts/test.mjs` passes all 77 tests. Deliberately removing or moving the preview step
   makes the workflow-order test fail.
3. The installed `SKILL.md` orders every self-built search as: server guide, compact
   `filters.preview`, inspection and refinement, then final `vacancy search`. It remains at or below
   8,192 bytes.
4. README, CLI help, skill and reference consistently report three metered actions and do not claim
   that the agent allowance is always shared with the website.
5. The final search is documented as rejecting unknown criteria; a misspelt value is not confused
   with an unknown key.
6. `npm pack --dry-run --ignore-scripts` contains only `LICENSE`, `NOTICE`, `README.md`,
   `bin/hirify.js`, `package.json`, `skills/hirify/SKILL.md`, and
   `skills/hirify/reference.md`.
7. Every shipped text is English, contains no long dash, contains no internal Hirify metaphors, and
   contains no credential-shaped literal.
8. Black-box local scenario: starting only from a natural-language job request, an agent can read
   the server guide, call `filters.preview`, refine a deliberately bad first filter, and issue the
   final search through this CLI without a hardcoded filter name in the package.
9. The GitHub repository remains private and the npm package remains unpublished during acceptance.
   Record exact pin, commands, outputs, mutation evidence, package file list, skill byte size, and
   verdict outside the repository.
