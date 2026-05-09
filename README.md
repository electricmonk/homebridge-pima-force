# homebridge-pima-force

[![Downloads](https://img.shields.io/npm/dt/homebridge-pima-force.svg?color=critical)](https://www.npmjs.com/package/homebridge-pima-force)
[![Version](https://img.shields.io/npm/v/homebridge-pima-force)](https://www.npmjs.com/package/homebridge-pima-force)

[Homebridge](https://github.com/homebridge/homebridge) plugin for the **PIMA FORCE** alarm system. Exposes each partition as a HomeKit Security System, each configured zone as a contact / motion / leak / smoke sensor, and the external siren as a switch you can flip off to mute an active alarm.

### Requirements

<img src="https://img.shields.io/badge/node-%3E%3D22-brightgreen"> &nbsp;
<img src="https://img.shields.io/badge/homebridge-%3E%3D1.6-brightgreen">

Check with `node -v` and `homebridge -V`.

# Installation

The plugin can be installed and configured via the Homebridge Config UI X — search for `homebridge-pima-force`, install, and use the schema-driven settings page.

Manual install:

1. Install Homebridge: `sudo npm install -g homebridge --unsafe-perm`
2. Install this plugin: `sudo npm install -g homebridge-pima-force`
3. Add the platform block to your Homebridge `config.json` (see below).

\* Install from git: `sudo npm install -g git+https://github.com/electricmonk/homebridge-pima-force.git`

## Panel-side setup (important — the panel dials out to this plugin)

The PIMA FORCE alarm is the TCP *client* of this plugin's listener. You must configure a **CMS path** on the panel pointing at the Homebridge host:

1. At the keypad, hold **Quit** → enter your **Installer Code**.
2. **System Configuration → CMS & Communication → Monitoring Station → CMS2** (or CMS3 — leave any existing CMS1 you may have for an alarm-monitoring service alone).
3. **Event Reporting** — on the 4th screen, set **Zone/Output Toggle = ON**.
4. **Comm.Paths → Network (Ethernet)**:
   - **Account ID**: any decimal you want (e.g. `1234`). Must match `account` in the plugin config.
   - **IP/URL 1**: the IP of your Homebridge host.
   - **Port**: the same port you use in the plugin config (default `7780`).
5. On the 2nd screen of Network (Ethernet), set **Protocol = JSON**.
6. **General Settings → Remote Disarm = ON** (allows the plugin to disarm).

The panel can have up to three CMS paths active at once, so you can run this plugin alongside an existing monitoring company or Control4 driver without disturbing them.

## Config file

#### Basic config

```json
"platforms": [
  {
    "platform": "PimaForce",
    "name": "Pima FORCE",
    "port": 7780,
    "account": 1234,
    "partitions": [
      {
        "id": 1,
        "name": "Main",
        "userCode": "1234",
        "zones": [
          { "zone": 1, "name": "Front Door", "type": "contact" },
          { "zone": 2, "name": "Living Room PIR", "type": "motion" }
        ]
      }
    ]
  }
]
```

#### Advanced config (all features)

```json
"platforms": [
  {
    "platform": "PimaForce",
    "name": "Pima FORCE",
    "port": 7780,
    "account": 1234,
    "debug": false,
    "siren": {
      "enabled": true,
      "name": "Alarm Siren"
    },
    "partitions": [
      {
        "id": 1,
        "name": "Main",
        "userCode": "1234",
        "armModes": {
          "away": true,
          "stay": true,
          "night": false
        },
        "zones": [
          { "zone": 1, "name": "Front Door", "type": "contact" },
          { "zone": 2, "name": "Kitchen Smoke", "type": "smoke" },
          { "zone": 3, "name": "Bathroom Leak", "type": "leak" },
          { "zone": 4, "name": "Living Room PIR", "type": "motion" }
        ]
      },
      {
        "id": 2,
        "name": "Garage",
        "userCode": "5678",
        "armModes": { "away": true, "stay": false, "night": false },
        "zones": [
          { "zone": 16, "name": "Garage Door", "type": "contact" }
        ]
      }
    ]
  }
]
```

## Configuration Parameters

### Platform-wide settings

| Parameter   | Description                                                                                                              | Required | Default       | Type    |
|-------------|--------------------------------------------------------------------------------------------------------------------------|----------|---------------|---------|
| `name`      | How the plugin appears in Homebridge logs.                                                                              | No       | `Pima FORCE`  | String  |
| `port`      | TCP port the panel dials in to. Must match the CMS path port on the panel.                                              | Yes      | `7780`        | Integer |
| `account`   | Account ID configured on the panel's CMS path.                                                                          | Yes      | `1234`        | Integer |
| `debug`     | When on, every JSON frame received from / sent to the panel is logged at info level (passwords are redacted). Noisy.   | No       | `false`       | Boolean |
| `siren`     | External-siren accessory config — see "Siren settings" below.                                                            | No       | enabled       | Object  |
| `partitions`| One entry per panel partition you want to expose.                                                                       | Yes      | —             | Array   |

### Siren settings

| Parameter         | Description                                                                                                       | Required | Default        | Type    |
|-------------------|-------------------------------------------------------------------------------------------------------------------|----------|----------------|---------|
| `siren.enabled`   | Off to suppress the siren accessory entirely.                                                                     | No       | `true`         | Boolean |
| `siren.name`      | Display name in HomeKit.                                                                                           | No       | `Alarm Siren`  | String  |

### Partition settings

| Parameter            | Description                                                                                                                                       | Required | Default                | Type    |
|----------------------|---------------------------------------------------------------------------------------------------------------------------------------------------|----------|------------------------|---------|
| `partition.id`       | Partition number on the panel (1–16).                                                                                                              | Yes      | —                      | Integer |
| `partition.name`     | Display name in HomeKit.                                                                                                                           | Yes      | —                      | String  |
| `partition.userCode` | User code for arming / disarming this partition. Stored in plain text in `config.json` — protect access to the host accordingly.                  | Yes      | —                      | String  |
| `partition.armModes` | Per-partition checkboxes for which HomeKit armed modes to expose. DISARM is always available — see "Arm-mode mapping" below.                      | No       | all enabled            | Object  |
| `partition.zones`    | Zones in this partition exposed as HomeKit sensors.                                                                                                | No       | `[]`                   | Array   |

### Arm-mode mapping

HomeKit's Security System has three armed target states; each maps to a specific PIMA arm operation:

| HomeKit state | PIMA mode      | optype |
|---------------|----------------|--------|
| `AWAY_ARM`    | Full Arm       | 12     |
| `STAY_ARM`    | Home 1 Arm     | 13     |
| `NIGHT_ARM`   | Home 2 Arm     | 14     |
| `DISARM`      | Disarm         | 17     |

Per-partition `armModes` toggles correspond to those three armed states (`away`, `stay`, `night` — booleans). Disabling one removes it from the picker in the Home app for that partition. DISARM is always available.

### Zone settings

| Parameter       | Description                                                                                                              | Required | Default     | Type    |
|-----------------|--------------------------------------------------------------------------------------------------------------------------|----------|-------------|---------|
| `zone.zone`     | Zone number on the panel.                                                                                                | Yes      | —           | Integer |
| `zone.name`     | Display name in HomeKit.                                                                                                  | Yes      | —           | String  |
| `zone.type`     | HomeKit sensor type: `contact` (door/window), `motion`, `leak`, `smoke`. Affects only the HomeKit icon and automation primitives — the panel-side semantics are identical.       | No       | `contact`   | String  |

## Features

- Per-partition Security System accessory; tracks AWAY / STAY / NIGHT / DISARM and ALARM_TRIGGERED on burglary events.
- Per-zone HomeKit sensor of the configured type (contact / motion / leak / smoke).
- Global Switch for the external siren — toggle off to mute an active siren (turning it on from HomeKit is rejected; the plugin won't sound the siren on demand).
- State sync from any source (keypad, monitoring station, mobile app) reflected in HomeKit, not only changes initiated from the plugin.
- Graceful handling of events from unconfigured partitions / zones — logged once, never crash.
- Optional `debug` mode logs every JSON frame in / out of the panel (passwords redacted).

## Issues & Debug

If you experience any issues with the plugin please open an issue on [GitHub](https://github.com/electricmonk/homebridge-pima-force/issues). Set `"debug": true` in the platform config and include the relevant log lines — every frame in / out of the panel is logged at info level when debug is on, with passwords redacted, which makes diagnosing protocol-level issues much faster.

When the panel rejects a request (e.g. unknown user code or insufficient authority), the plugin logs a `panel NAK` line at warn level with the panel's reason string — useful when arm / disarm or siren-mute commands appear to do nothing.

-------------------------------------------

## Credits

100% of the code in this repository — driver, plugin, protocol layer, tests, CI, and this README — was written by **[Claude Code](https://claude.ai)** (Anthropic's AI coding assistant) under direction from [@electricmonk](https://github.com/electricmonk). Maintainer's contributions were the project goals, panel access for protocol reverse-engineering, real-world testing of every feature against an actual Pima FORCE installation, design review, and bug reports from production use. Mention if you fork or extend.

## License

This plugin is released under the [GNU Lesser General Public License v3.0 or later](https://www.gnu.org/licenses/lgpl-3.0.html). See [LICENSE](./LICENSE) for the full text.

## Support homebridge-pima-force

Plugin development and maintenance takes time. If this plugin saved you a few hours of poking at panel manuals and packet captures and you'd like to say thanks, donations are welcome:

<a target="_blank" href="https://www.paypal.com/paypalme/electricmonk"><img src="https://img.shields.io/badge/PayPal-Donate-blue.svg?logo=paypal"/></a>
