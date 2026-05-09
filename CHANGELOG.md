# Changelog

All notable changes to this project will be documented in this file.

## [0.1.8] - 2026-05-09

### Features

* siren switch: always send de-activate command on HomeKit off, regardless of cached state (idempotent fix for "alarm sounding, toggle off, siren kept going")
* zone sensors: preserve UUID when zone `type` changes between runs by removing the old service before adding the new one
* unknown partitions/zones: log INFO on first observation, DEBUG on subsequent — no crashes, no silent drops

### Bug Fixes

* ACK echo `account` as number to prevent panel NAK / 60-second silence
* counter rollover at 9999 handled correctly for both AS and HA counters

[0.1.8]: https://github.com/electricmonk/homebridge-pima-force/releases/tag/v0.1.8
