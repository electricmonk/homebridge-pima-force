## [0.1.20](https://github.com/electricmonk/homebridge-pima-force/compare/v0.1.19...v0.1.20) (2026-05-17)

## [0.1.19](https://github.com/electricmonk/homebridge-pima-force/compare/v0.1.18...v0.1.19) (2026-05-12)

## [0.1.18](https://github.com/electricmonk/homebridge-pima-force/compare/v0.1.17...v0.1.18) (2026-05-12)

## [0.1.17](https://github.com/electricmonk/homebridge-pima-force/compare/v0.1.16...v0.1.17) (2026-05-12)

### Bug Fixes

* serialize all HA→AS traffic on the wire — DATA-REQ and OPERATION now share a single in-flight slot, so back-to-back commands no longer race (the panel was answering the first and rejecting / dropping the rest with `NAK counter=0 "JSON frame"`; the visible symptom was partition state stuck on partition 1 only after startup) ([20da6ab](https://github.com/electricmonk/homebridge-pima-force/commit/20da6abc618334d1828d1b5e499983623f6320c8))
* `arm` / `disarm` / `setOutput` now resolve only after the panel ACKs and reject on counter-matched NAK / per-request timeout / disconnect (previously they resolved on write-complete, so failures were silently lost) ([20da6ab](https://github.com/electricmonk/homebridge-pima-force/commit/20da6abc618334d1828d1b5e499983623f6320c8))
* dedup successive same-counter inbound retransmits before forwarding to driver handlers; spec §4.5.2 retransmits no longer fire HomeKit handlers twice (zone open, alarm triggered, etc.). ACKs are still re-sent on every retransmit ([20da6ab](https://github.com/electricmonk/homebridge-pima-force/commit/20da6abc618334d1828d1b5e499983623f6320c8))
* paginated DATA responses now fail fast if the panel ever returns `more: yes` with empty parameters — previously this re-issued the same DATA-REQ forever, starving the Node event loop ([20da6ab](https://github.com/electricmonk/homebridge-pima-force/commit/20da6abc618334d1828d1b5e499983623f6320c8))
* validate `requestTimeoutMs` at the driver boundary; non-finite / `≤ 0` values would have silently turned every request into an instant timeout ([20da6ab](https://github.com/electricmonk/homebridge-pima-force/commit/20da6abc618334d1828d1b5e499983623f6320c8))

### Refactor

* split wire transport (`PimaTransport`) out of the driver — the transport owns the socket, counter allocator, request queue, panel verification and inbound ACKing; the driver shrinks to domain translation (arm modes ↔ optypes, event decoding) ([20da6ab](https://github.com/electricmonk/homebridge-pima-force/commit/20da6abc618334d1828d1b5e499983623f6320c8))

## [0.1.16](https://github.com/electricmonk/homebridge-pima-force/compare/v0.1.15...v0.1.16) (2026-05-11)

### Refactor

* drop `homebridge` as a runtime peer dependency — the plugin no longer needs a Homebridge install at runtime (only at build time for HAP types) ([3825e93](https://github.com/electricmonk/homebridge-pima-force/commit/3825e93))

### CI

* bump GitHub Actions to the latest major versions ([#20](https://github.com/electricmonk/homebridge-pima-force/pull/20)) ([35634a2](https://github.com/electricmonk/homebridge-pima-force/commit/35634a2))

## [0.1.15](https://github.com/electricmonk/homebridge-pima-force/compare/v0.1.14...v0.1.15) (2026-05-11)

### Features

* support Homebridge 2.0 while retaining compatibility with 1.x — `peerDependencies` now accepts `^1.8.0 || ^2.0.0`, and the E2E test matrix covers both ([9ad32ad](https://github.com/electricmonk/homebridge-pima-force/commit/9ad32ad))

## [0.1.14](https://github.com/electricmonk/homebridge-pima-force/compare/v0.1.13...v0.1.14) (2026-05-11)

### Features

* query partition state on panel connect (issue [#16](https://github.com/electricmonk/homebridge-pima-force/issues/16)) ([63b6f1b](https://github.com/electricmonk/homebridge-pima-force/commit/63b6f1b3f1222eba4180bc6831f7b97456ce7a2b))

### Bug Fixes

* address baz review comments on partition state query ([bfc0a02](https://github.com/electricmonk/homebridge-pima-force/commit/bfc0a02deab507fb960ca522fc5d3aa15a4dcbe7))
* address remaining baz comments — credential write gating and startup timeout ([d419b09](https://github.com/electricmonk/homebridge-pima-force/commit/d419b09badf77325460b644839d7c6690a1526e6))

## [0.1.13](https://github.com/electricmonk/homebridge-pima-force/compare/v0.1.12...v0.1.13) (2026-05-10)

### Bug Fixes

* address baz review comments (encoding default, reverseStrings deprecation, discovery retry) ([50a07fa](https://github.com/electricmonk/homebridge-pima-force/commit/50a07fa7528e3517a95bca190fc79db25ee6ca22))
* address baz review comments (NAK correlation, pagination test, config safety) ([bce2d37](https://github.com/electricmonk/homebridge-pima-force/commit/bce2d3705548ee0449c444936c624fc02a92fa9a))
* address review comments from zone-discovery PR ([ec8428f](https://github.com/electricmonk/homebridge-pima-force/commit/ec8428fcfe9f3b5ab0389c4e36793affc221328f))

## [0.1.12](https://github.com/electricmonk/homebridge-pima-force/compare/v0.1.11...v0.1.12) (2026-05-10)

### Bug Fixes

* do not start driver when no partitions are configured ([a701760](https://github.com/electricmonk/homebridge-pima-force/commit/a7017602389878b8b5e6fa8bc9bc01ee8626fcfc))
* **e2e:** filter bridge accessory from unconfigured-plugin accessory assertion ([9234717](https://github.com/electricmonk/homebridge-pima-force/commit/92347174e6561dbcc62ebca06d8fec3c75b008bb))
* **e2e:** replace sleep with polling loop in unconfigured port test ([e5ac865](https://github.com/electricmonk/homebridge-pima-force/commit/e5ac865757c951e8153e497d383047f113b97eb9))

## [0.1.11](https://github.com/electricmonk/homebridge-pima-force/compare/v0.1.10...v0.1.11) (2026-05-10)

### Features

* add CHANGELOG.md and automated changelog generation ([dc3cb0f](https://github.com/electricmonk/homebridge-pima-force/commit/dc3cb0f392da68c30a2eb5ecc3bbb989da6989e9))

## [0.1.10](https://github.com/electricmonk/homebridge-pima-force/compare/v0.1.8...v0.1.10) (2026-05-09)

### Features

* add CHANGELOG.md and automated changelog generation ([dc3cb0f](https://github.com/electricmonk/homebridge-pima-force/commit/dc3cb0f392da68c30a2eb5ecc3bbb989da6989e9))

# Changelog

All notable changes to `homebridge-pima-force` will be documented in this file.

## [0.1.8] - 2026-05-09

### Added
- Siren switch: global HomeKit `Switch` accessory driven by panel output events (CID 770). Turning it off sends a de-activate-output command; turning it on is rejected (the plugin must never sound the siren on demand).
- Idempotent siren off: de-activate-output is always sent even when cached state is already off, fixing the "alarm sounding, toggle off, siren kept going" race.

### Changed
- Unknown partition/zone IDs observed from the panel are now logged at INFO on first occurrence (with a hint to add them to config) and at DEBUG for subsequent events — no log spam, but operators see new hardware in the journal.

### Fixed
- Zone sensor type change between runs now removes the old service before adding the new one, keeping the UUID stable so HomeKit automations don't orphan.
- ACK now echoes `account` as a number (not a string), matching the panel's expectation and preventing NAK / 60 s silence.
