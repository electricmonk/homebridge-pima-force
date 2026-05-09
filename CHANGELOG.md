# Changelog

All notable changes to this project will be documented in this file.

This file is auto-generated from git commits using [conventional-changelog](https://github.com/conventional-changelog/conventional-changelog). To generate an updated changelog locally, run:

```
npm run changelog
```

## [0.1.8](https://github.com/electricmonk/homebridge-pima-force/compare/v0.1.7...v0.1.8) (2025-05-09)

### Features

* expose each partition as a HomeKit SecuritySystem accessory
* expose configured zones as contact / motion / leak / smoke sensors
* expose external siren as a HomeKit Switch (turn off only — turning on is blocked)
* full local state sync via CID events (407, 401, 760, 770, 130) — HomeKit always reflects actual panel state regardless of arm source
* AWAY_ARM → Full Arm, STAY_ARM → Home1, NIGHT_ARM → Home2, DISARM mapped from HomeKit
* per-partition `armModes` config to hide unused arm modes from the HomeKit picker
* log unknown partitions/zones at INFO on first sight; DEBUG thereafter — no crash, no silent drop
* `debug` mode logs every JSON frame in/out with passwords redacted
