# Hirify CLI public copy review

Scope: every file shipped to npm or the public GitHub repository - `README.md`, CLI help and
messages in `bin/hirify.js`, `skills/hirify/SKILL.md`, `skills/hirify/reference.md`, package metadata,
`LICENSE`, and `NOTICE`.

## Content and voice

Public copy should be calm, specific, and action-oriented. It should explain what the reader can do
next, avoid internal metaphors and implementation jargon, and make no claim that can drift from the
server. English copy follows the same Hirify voice: competent, friendly, concise, and honest.

## Remove

No user-facing line should be removed. The current README is short, every section supports setup or
use, and CLI errors provide a next action.

## Correct before publication

| Surface | Before | After | Reason |
|---|---|---|---|
| README intro | `which two commands spend an allowance` | `which three commands use an allowance` | Read, reveal, and apply are all metered in the release API. |
| CLI help and intro | `both allowances` | `allowances` | Account status now reports three independent budgets. |
| Skill and reference | An unknown search criterion `narrows nothing` | The final search refuses an unknown criterion | The refactored API validates search criteria. |
| Skill and reference | Read allowance is always shared with the website | No cross-surface promise | The server can run a separate agent budget while website ceilings are disabled. |
| Skill search workflow | Read the guide, then search | Guide, compact preview, refinement, then final search | Preview is a required part of the server-owned filter-generation method. |
| Public source comment | Apply quota was not consumed as of 25 August | Removed | The release API consumes the apply allowance. |

These corrections were explicitly approved as part of release preparation and are covered by the
CLI test suite. No stylistic rewrite was applied beyond them.

## Already good

- The README leads with browser sign-in and skill installation, without internal architecture.
- The skill separates free reading, metered actions, and irreversible application submission.
- Dynamic limits, abilities, filter names, and values are fetched from the server instead of frozen
  in the package.
- Errors say what happened and what to do next without hype, blame, or promises of support outcomes.
- Public files are English-only and contain no long dashes; both properties are test-gated.

## Mechanical checks

- No long dash or Cyrillic text in shipped files.
- No hype, emoji, or internal `door`/`surface`/`contour` metaphors in user-facing copy.
- Package dry run contains only the expected seven files.
- Skill remains below the 8,192-byte resident context budget.

## Product findings outside tone

The full natural-language search workflow still needs independent black-box acceptance: install the
skill, provide only a human job request, fetch the guide, preview and refine a filter, then run the
final search and assess relevance. Unit and contract tests cover each component, but the previous
independent run started from a ready-made query.
