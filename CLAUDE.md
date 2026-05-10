# Project: homebridge-pima-force

Homebridge plugin for the **PIMA FORCE** alarm panel (Israeli vendor). Lets HomeKit arm/disarm and observe the panel without going through PIMA Cloud or 3rd party integrations.

The panel is the **TCP client**; this plugin is the listener. Configure on the panel's keypad → Installer → CMS & Communication → Monitoring Station → Network (Ethernet), Protocol = JSON. See `README.md` for the full panel-side setup.

## Architecture (what the plugin exposes)

- **Per partition**: a HomeKit `SecuritySystem` accessory.
- **Per zone**: a typed sensor — `contact` / `motion` / `leak` / `smoke` (chosen via config). All four share identical panel-side semantics; the type only affects HomeKit icon + automation primitives. When a zone's `type` changes between runs, the accessory must remove the old sensor service from the cached HAP accessory before adding the new one — keeps the UUID stable so user automations don't orphan.
- **Global siren**: a `Switch`. `On = siren sounding`, `Off = silent`; state is driven by panel `type=770` output events on the external-siren output. The user can only turn it **off** from HomeKit — turning on is rejected and the toggle snaps back, since the plugin must never sound the siren on demand. Toggling off always sends de-activate-output (optype 36, order 1) even if our cached state says it's already off (idempotent on the panel; this is the fix for "alarm sounding, HomeKit toggle off, siren kept going" when we missed the activation event). Disable entirely via `siren.enabled = false`.

### HomeKit ↔ PIMA arm-mode mapping (hardcoded for v1)

| HomeKit | PIMA | optype |
|---|---|---|
| AWAY_ARM | Full Arm | 12 |
| STAY_ARM | Home1 | 13 |
| NIGHT_ARM | Home2 | 14 |
| DISARM | Disarm | 17 |
| (CurrentState) ALARM_TRIGGERED = 4 | burglary CID 130 q=1 | — |

`armModes.{away,stay,night}` per-partition booleans hide modes from the HomeKit picker but DISARM is always available.

### State sync — non-negotiable

The HomeKit state of every accessory must reflect the **panel's actual state**, regardless of who arms / disarms / triggers — keypad, mobile app, Control4, this plugin, or any other CMS path. Driven by listening for CID `407` (remote arm/disarm), `401` (local user arm/disarm), `760` (zone open/close), `770` (output activate/deactivate), and `130` (burglary). Never assume that an arm command we sent is the only path to an arm state change.

### Unconfigured partitions / zones

The panel will emit events for partitions and zones the user hasn't listed in config (e.g. a new sensor wired up later). The plugin must not crash and must not silently drop them. **Required behaviour**: log at INFO the first time an unknown id is observed (with a hint that adding it to config will expose it as a HomeKit accessory), then DEBUG for subsequent events from the same id. Operators must see new ids in the journal without log spam.

## Protocol

`PROTOCOL.md` (in this repo) is the condensed cheat sheet — frame envelope, optypes, parameter IDs, zone-status bit map, full faults table, full CID event table, NAK reasons. Read it before reverse-engineering anything.

Hard-won protocol rules that have bitten us before:

- **ACK shape is picky.** `{"account":<NUMBER>,"counter":<N>,"frame_type":"ACK","kc":1}`. The panel sends `account` as a string in events; the ACK MUST echo it as a number. Any deviation → panel NAKs with `"data":"JSON frame"` and goes silent for ~60 s. `kc:1` is required to keep the connection.
- **Never ACK a NAK or an ACK** — feedback loop.
- **Retries reuse the same counter.** Dedupe inbound by counter, but always re-ACK; the panel re-sends until it sees the ACK.
- **Counter rollover at 9999.** AS and HA counters are independent.
- **`null` heartbeat** is padded to 250 bytes with `0x00`. Outbound DATA payloads ≤ 250 bytes total.
- **Hebrew names** use Windows-1255, not UTF-8. See `decodeBuffer` in `src/protocol.ts`.
- **Field order** in OPERATION/ACK matches the observed real behavior of the alarm panel — don't reorder; some panels are picky.

## Code conventions

- Pure protocol logic in `src/protocol.ts` — no I/O. Tested in `src/protocol.test.ts`. Keep them pure.
- Driver / network layer in `src/driver.ts`, tested in `src/driver.test.ts`. End-to-end with HomeBridge in `src/e2e.test.ts` - using HTTP rather than PlayWright to simplify stuff.
- Per-accessory classes: `src/partition-security-system.ts`, `src/zone-sensor.ts`, `src/siren-switch.ts`.
- Platform aggregator: `src/platform.ts` — wires driver events to accessory `.updateValue()` calls.
- `debug: true` in platform config logs every JSON frame in/out at INFO level **with passwords redacted**. Don't log unredacted passwords anywhere.

## Testing

- **Never put real user secrets in source.** Even when you captured them via tcpdump, even in a test fixture, even in a comment. Use clearly-fake placeholders like `'1111'`, `'2222'`, `'test-token'`. The user has caught real PINs in fixtures before — files leak into git, pastes, backups. If a wire-format test needs byte-for-byte parity with a captured payload, reconstruct the payload from fake creds rather than copy-pasting the real bytes; the encoding logic is identical. If a credential genuinely must live in a file, ask first.
- Run the full test suite before opening a PR (`npm test`).

## Release / CI gotchas

- Publish to npm uses **Trusted Publishing via GitHub Actions OIDC** (no NPM_TOKEN). The workflow needs `id-token: write` and a configured Trusted Publisher on the npm side.
- Trusted Publishing requires **npm CLI ≥ 11.5.1**. Node 20 ships npm 10.x and silently fails — the publish PUT goes out unauthenticated and npm returns a misleading `404 Not Found / 'pkg@version' is not in this registry`, even though Sigstore provenance signing succeeds (which makes it look like progress). Use Node 22+ on the publish job, or `npm install -g npm@latest` before publishing. The test matrix can keep older Nodes to honour `engines.node`; only the publish runner needs the modern CLI.
- When debugging TP claim mismatches: decode the OIDC JWT (`ACTIONS_ID_TOKEN_REQUEST_URL` with audience `npm:registry.npmjs.org`) and compare `repository`, `workflow_ref`, `sub`, `environment` against the npm TP UI.
