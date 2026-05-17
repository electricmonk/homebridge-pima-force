# homebridge-pima-force

[![Downloads](https://img.shields.io/npm/dt/homebridge-pima-force.svg?color=critical)](https://www.npmjs.com/package/homebridge-pima-force)
[![Version](https://img.shields.io/npm/v/homebridge-pima-force)](https://www.npmjs.com/package/homebridge-pima-force)
[![verified-by-homebridge](https://img.shields.io/badge/_-verified-blueviolet?color=%23491F59&style=flat&logoColor=%23FFFFFF&logo=homebridge)](https://github.com/homebridge/homebridge/wiki/Verified-Plugins)

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
3. Configure the panel side (next section) so it dials in to your Homebridge host.
4. Add a platform block to your Homebridge `config.json` listing **only your partitions and their user codes** (see "First-run / zone discovery" below). Do not enumerate zones manually — the plugin will populate them on first connect.
5. Restart Homebridge. After the panel dials in, the plugin auto-discovers every zone, writes them into `config.json`, and registers each as a HomeKit sensor on the spot — they appear in the Home app immediately.

\* Install from git: `sudo npm install -g git+https://github.com/electricmonk/homebridge-pima-force.git`

## First-run / zone discovery

The intended setup flow is **partition-only configuration**: you list the partitions and the user code authorized to arm/disarm each, and the plugin handles zones automatically.

1. Configure the panel-side CMS path (next section) — this is what makes the panel dial in to the plugin's TCP listener.
2. Add the platform block to `config.json` with `account`, `port`, and one entry per partition (`id`, `name`, `userCode`). Skip `zones`. (See "Basic config" below.)
3. Start Homebridge. When the panel connects, the plugin queries it for the installed zone count and zone names, then **appends** each new zone to `config.json` as `{ "zone": N, "name": "<from panel>", "type": "contact" }` and **registers each as a HomeKit sensor in-process** — so they appear in the Home app immediately, without needing a Homebridge restart.
4. In the plugin settings UI (or directly in `config.json`), adjust each zone's `type` to one of `contact` / `motion` / `leak` / `smoke`. **Type changes take effect on the next Homebridge restart** — Homebridge doesn't reload the plugin's in-memory config when `config.json` changes. Zone names already came from the panel — usually no need to rename.
5. Auto-discovery is **append-only**. Names you've changed are never overwritten, types you've set are never reverted, and zones the panel temporarily stops reporting are not removed (a sensor going offline shouldn't drop the HomeKit accessory). Adding a new sensor to the panel later re-triggers discovery on the next plugin restart, and the new zone is appended + registered.

If your panel returns Hebrew names that arrive garbled in HomeKit (`?` characters), set `encoding` (default `windows-1255`) to whatever code page your panel uses — see the parameters table below.

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

#### Basic config (what you write yourself)

The minimum the plugin needs to start. After the panel dials in, the `zones` array is auto-populated.

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
        "userCode": "1234"
      }
    ]
  }
]
```

#### After auto-discovery (what `config.json` looks like once the panel has connected)

The plugin appended a `zones` block. You can adjust each zone's `type` here (or in the Homebridge UI); the plugin will not overwrite your changes.

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
        "userCode": "1234"
      }
    ],
    "zones": [
      { "zone": 1, "name": "Front Door",        "type": "contact" },
      { "zone": 2, "name": "Living Room PIR",   "type": "motion"  },
      { "zone": 3, "name": "Kitchen Smoke",     "type": "smoke"   },
      { "zone": 4, "name": "Bathroom Leak",     "type": "leak"    }
    ]
  }
]
```

#### Advanced config (all features)

Multiple partitions with per-partition `armModes`, an explicit siren block, and `debug` enabled. Zones are still auto-discovered — you only customize `type` after the fact.

```json
"platforms": [
  {
    "platform": "PimaForce",
    "name": "Pima FORCE",
    "port": 7780,
    "account": 1234,
    "encoding": "windows-1255",
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
        "armModes": { "away": true, "stay": true,  "night": false }
      },
      {
        "id": 2,
        "name": "Garage",
        "userCode": "5678",
        "armModes": { "away": true, "stay": false, "night": false }
      }
    ]
  }
]
```

## Configuration Parameters

### Platform-wide settings

| Parameter   | Description                                                                                                              | Required | Default          | Type    |
|-------------|--------------------------------------------------------------------------------------------------------------------------|----------|------------------|---------|
| `name`      | How the plugin appears in Homebridge logs.                                                                              | No       | `Pima FORCE`     | String  |
| `port`      | TCP port the panel dials in to. Must match the CMS path port on the panel.                                              | Yes      | `7780`           | Integer |
| `account`   | Account ID configured on the panel's CMS path.                                                                          | Yes      | `1234`           | Integer |
| `encoding`  | Character encoding for zone/user names returned by the panel. Set to `utf-8` for English-only installs; any encoding `TextDecoder` accepts is valid (`windows-1255`, `iso-8859-1`, etc.). If names appear as `?` in HomeKit the encoding is wrong. | No       | `windows-1255`   | String  |
| `debug`     | When on, every JSON frame received from / sent to the panel is logged at info level (passwords are redacted). Noisy.   | No       | `false`          | Boolean |
| `siren`     | External-siren accessory config — see "Siren settings" below.                                                            | No       | enabled          | Object  |
| `partitions`| One entry per panel partition you want to expose.                                                                       | Yes      | —                | Array   |
| `zones`     | Zones exposed as HomeKit sensors. **Auto-populated** by the plugin on first panel connect; appended to as new zones appear on the panel. You may edit each entry's `type` (and `name`, if you want to override the panel's name). Never delete entries unless the panel slot is genuinely gone.                                                                                       | No       | auto-populated   | Array   |


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
