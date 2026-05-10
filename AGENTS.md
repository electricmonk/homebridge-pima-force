# AGENTS.md

This repo is **homebridge-pima-force**, a Homebridge plugin that exposes a PIMA FORCE alarm panel (Israeli vendor) to HomeKit so users can arm/disarm and observe partitions, zones, and the siren — without going through PIMA Cloud or third-party integrations. The panel is the TCP client; this plugin is the listener, speaking PIMA's JSON CMS protocol directly.

Instructions for coding agents working autonomously on this repo. Read alongside `CLAUDE.md` (project conventions) and `PROTOCOL.md` (panel wire format).

## Test coverage is mandatory

**Every code change must be covered by a test.** No exceptions.

- Pure protocol logic → unit test in `src/protocol.test.ts`.
- Driver / network behavior → unit test in `src/driver.test.ts`.
- Cross-component or HomeBridge wiring → integration / e2e test in `src/e2e.test.ts`.

If a change is genuinely untestable (e.g. a typo in a log message), say so explicitly in the PR description rather than skipping silently. "I couldn't figure out how to test this" is not the same as "this is untestable" — ask before opening the PR.

For bug fixes: write the failing test **first**, confirm it reproduces the bug, then fix. The test must fail without your fix and pass with it.

For new behavior: the test must exercise the behavior end-to-end at the appropriate layer, not just call the new function with a trivial input.

## Before opening a PR

- `npm test` — full suite must pass locally.
- `npm run lint` and `npm run build` (if defined) — must pass.
- New tests must actually fail without the production change. Verify by reverting the production change and re-running, or by writing the test before the fix.

## Hard rules carried over from CLAUDE.md

- **No real secrets in tests or fixtures.** Use placeholders like `'1111'`, `'test-token'`. Reconstruct captured payloads from fake credentials.
- **Don't log unredacted passwords.** Anywhere.
- **Don't reorder fields** in OPERATION / ACK frames — panels are picky about field order.
- **Don't ACK a NAK or an ACK** — feedback loop.
- **Counter handling**: dedupe inbound by counter, but always re-ACK retransmits.

## Scope discipline

- Don't expand scope. A bug fix should not bring refactors, dependency bumps, or unrelated cleanup along with it.
- Don't add features, fallbacks, or abstractions the task didn't ask for.
- If you find unrelated issues while working, note them in the PR description rather than fixing them in the same change.

## When in doubt

- `PROTOCOL.md` is the condensed cheat sheet — read it first. 
- If a panel-side behavior contradicts `PROTOCOL.md`, update `PROTOCOL.md` in the same PR with a note about how it was observed.
- If you can't reproduce or test a panel-specific behavior without hardware, stop and surface the question rather than guessing.
