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
