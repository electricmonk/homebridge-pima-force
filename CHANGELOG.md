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
