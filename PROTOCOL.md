# PIMA FORCE JSON Protocol — condensed reference

Source: vendor PDF `Force Interface using JSON format 2.4` (in `hb-dev/`, gitignored).
This file: agent-optimized cheat sheet. Numeric constants live in `src/protocol.ts`; this doc carries what code doesn't (bit layouts, full enum tables, behavioural rules).

Transport: ASCII JSON over TCP. Panel = AS, opens connection. Plugin = HA, listens with static IP.

## Envelope

Every frame: `{frame_type, counter, account, ...}`

- `counter`: int 0–9999, rolls over. AS and HA counters are independent. ACK echoes the counter of the frame it acknowledges. Retries reuse the same counter — dedupe but always re-ACK.
- `account`: panel sends as **string**, ACK MUST send back as **number**. Mismatch → NAK `Invalid JSON frame` and 60 s of silence.
- `null` heartbeat: padded to 250 bytes with 0x00. Other frames natural length.

## Frame types

| type | dir | purpose |
|------|-----|---------|
| EVENT | AS→HA | CID-style report. ACK required. |
| OPERATION | HA→AS | arm / disarm / output. ACK or NAK. |
| DATA-REQ | HA→AS | poll a parameter. Reply: DATA or NAK. |
| DATA | both | AS→HA: response to DATA-REQ. HA→AS: config write, ≤250 B payload. |
| ACK | both | acknowledges other side. Never ACK an ACK or NAK. |
| NAK | AS→HA | rejection w/ reason string. |
| null | AS→HA | life signal; also emitted after AS drains its event buffer. ACK it. |
| ROUTE / CLOSE | HA→AS | TCP/UDP relay. Not used by this plugin. |

## EVENT

`{frame_type:"EVENT", counter, account, type, qualifier, zone, partition}`

- `type`: 3-digit CID (table below).
- `qualifier`: `1` = alarm/new/disarm, `3` = restore/arm.
- `zone`: zone#, user#, module#, or 0 — meaning depends on `type`.
- `partition`: 1–16, or 0 = all.

## ACK (HA→AS, for every non-ACK/NAK frame)

`{account:<num>, counter:<num>, frame_type:"ACK", kc:1}`

- `kc:1` → AS keeps TCP open. `kc:0` or absent → AS disconnects after pending events flush.
- `account` numeric, even though the panel sent it as a string.

## NAK

`{frame_type:"NAK", counter, account, DATA:"<reason>"}`

Reasons (Appendix D, debug-only — vendor reserves the right to change strings):
`Parameter Not Exist` · `Order Not Exist` · `Start-Stop Order Error` · `Parameter(s) Missing` · `Invalid JSON frame` · `Invalid Frame Type` · `Bit Error` · `Wrong User Code` · `Wrong Account ID` · `Wrong Sequence Number`.

## OPERATION

`{frame_type:"OPERATION", counter, account, password:"<PIN>", optype, opclass:1, order, partition, parameters?}`

- `partition`: 1–16, or 0 = all.
- For arm/disarm: `opclass=1`, `order=0` (spec also shows `order:1` — both accepted).
- For outputs: `opclass=1`, `order` = output# below.

Optypes (Appendix B):

| optype | command | order |
|---|---|---|
| 12 | Full Arm | 0 |
| 13 | Home1 Arm | 0 |
| 14 | Home2 Arm | 0 |
| 15 | Home3 Arm | 0 |
| 16 | Home4 Arm | 0 |
| 17 | Disarm | 0 (panel needs `Remote Disarm = ON`) |
| 43 | Shabbat Arm | 0 |
| 35 | Activate Output | 1=ext siren · 2=int siren · 34–41=controlled out 1–8 |
| 36 | De-activate Output | same orders as 35 |

## DATA-REQ / DATA

`{frame_type:"DATA-REQ", counter, account, password, id, start_order, stop_order?}`

- Omit `stop_order` → AS returns from `start_order` to end of array.
- AS may split: response carries `"more":"yes"` → re-request from `last_order+1` until `more` is missing or `"no"`.
- HA→AS DATA payloads ≤ 250 bytes.
- **Responses are privilege-filtered by `password`.** A per-partition user code only returns rows for its own partition; rows for other partitions are silently omitted. A master/global user code returns everything. The installer code is **rejected** for CMS DATA-REQ (`NAK "קוד שגוי"` / "wrong code") — it authenticates only at the keypad. Practical implication: query 2149/2310/etc. with the broadest available user code, or query with each partition code in turn and compare visibilities to deduce zone-partition membership.
- Adjacent IDs **261, 263, 264, 265** exist (the panel responds rather than `NAK "Parameter Not Exist"`) but reject every CMS-presentable code (user + master + installer) with `NAK "wrong code"`. They are presumed installer-config parameters and are not reachable from the JSON CMS surface. ID **262** is reachable with a user code and returns one byte per zone of unknown semantic — *not* partition.

Parameters (Appendix C):

| id | name | order | format |
|---|---|---|---|
| 180 | Exit Time (s) | 0 | num |
| 260 | Zone Name | zone 1–144 | str (≤48 chars; Hebrew = Windows-1255) |
| 411 | User Name | user 1–144 | str |
| 2148 | Number of installed zones | 0 | num |
| 2149 | Zone Status | — | hex bitfield (below) |
| 2150 | Bypass (read & write) | zone# | `"1"`=bypass, `"0"`=clear |
| 2250 | Faults | — | hex (below) |
| 2301 | Sirens / Outputs status | 1–2 sirens, 34–41 outputs | bitfield |
| 2310 | System Key Status | partition 1–16 | num |

### System Key Status (id 2310)

`1`=NotExist · `2`=Disarmed · `3`=FullArmed · `4`=Home1 · `5`=Home2 · `6`=Home3 · `7`=Home4 · `8`=Shabbat-ON · `9`=Shabbat-OFF.

Privilege-filtered (see DATA-REQ rules above): partitions outside the user code's scope return as `1` (NotExist) — indistinguishable from genuinely-unconfigured partitions. To reliably enumerate partitions, query with the master/global user code.

### Discovering zone-partition mapping

The protocol has no documented "zones-on-partition X" parameter. Three combinable approaches:

1. **Live `event type=760` frames** carry both `zone` and `partition` — every state change teaches the mapping. The driver already emits them.
2. **2149 cross-referenced across user codes:** query 2149 with each per-partition user code and with the master code. A zone that appears for code A but not code B is on partition A's scope. Caveat — 2149 omits closed-and-clear zones, so this only catches zones with persistent non-zero state (typically 24h: smoke / flood / panic).
3. **2310 with each partition code** confirms which partitions a code authorises (returns state for in-scope partitions, `1` for others).

### Zone Status bits (id 2149)

Each entry is a hex string, up to 4 bytes. Low byte = zone#. Upper bytes = bitfield.
**Closed-and-clear zones are omitted from the response** (only zones with non-zero status bytes appear).

Bit → meaning (counted across upper bytes, bit 0 of byte 1):

`0`=SupervisionLoss · `1`=LowBattery · `2`=Short · `3`=Cut(Tamper) · `4`=Soak · `5`=Chime · `6`=AntiMask · `7`=ManualBypass · `8`=AutoBypass · `9`=Alarmed · `10`=Armed · `11`=Open · `12`=Duress · `13`=Fire · `14`=Medical · `15`=Panic.

Example: `"0A0019"` → zone `0x19`=25, upper `0x0A00` has bits 9+11 → alarmed + open.

### Faults (id 2250)

Each fault = hex string `<order_byte><fault_id_byte>`. `order` only meaningful for some IDs (e.g. zone tamper carries the zone#).

Fault IDs (decimal / hex):

| dec | hex | description |
|---|---|---|
| 1 | 01 | AC Loss |
| 2 | 02 | Low Battery |
| 3 | 03 | Panel Tamper 1 |
| 4 | 04 | Panel Tamper 2 |
| 5 | 05 | Panel Aux Voltage |
| 6 | 06 | PSTN — DC |
| 7 | 07 | PSTN — Dial Tone |
| 8 | 08 | Panel Low DC |
| 9 | 09 | Zone Expander |
| 10 | 0A | Zone Expander Tamper |
| 11 | 0B | Zone Expander Voltage |
| 12 | 0C | Zone Expander AC |
| 13 | 0D | Zone Expander Low Battery |
| 14 | 0E | Zone Expander Aux Voltage |
| 15 | 0F | Local Expander |
| 16 | 10 | Local Expander Voltage |
| 17 | 11 | Local Expander Aux Voltage |
| 18 | 12 | Output Expander |
| 19 | 13 | Output Expander Tamper |
| 20 | 14 | Output Expander Voltage |
| 21 | 15 | Output Expander AC |
| 22 | 16 | Output Expander Low Battery |
| 23 | 17 | Output Expander Aux Voltage |
| 24 | 18 | Keypad |
| 25 | 19 | Keypad Tamper |
| 26 | 1A | Keypad Voltage |
| 27 | 1B | Wireless Receiver |
| 28 | 1C | Wireless Receiver Tamper |
| 29 | 1D | Wireless Receiver Voltage |
| 30 | 1E | Station PSTN Comm |
| 31 | 1F | Station GPRS |
| 32 | 20 | Station GSM Voice |
| 33 | 21 | Station Network Comm |
| 35 | 23 | Contact PSTN |
| 36 | 24 | Contact GSM Voice |
| 38 | 26 | Contact SMS |
| 39 | 27 | GSM Transmitter |
| 40 | 28 | GSM Link 1 |
| 41 | 29 | GSM Link 2 |
| 42 | 2A | GSM SIM 1 |
| 43 | 2B | GSM SIM 2 |
| 44 | 2C | GSM Boot 1 |
| 45 | 2D | GSM Boot 2 |
| 46 | 2E | GSM Registration 1 |
| 47 | 2F | GSM Registration 2 |
| 48 | 30 | GPRS Registration 1 |
| 49 | 31 | GPRS Registration 2 |
| 50 | 32 | GSM No SIM 1 |
| 51 | 33 | GSM No SIM 2 |
| 52 | 34 | GSM SIM PIN 1 |
| 53 | 35 | GSM SIM PIN 2 |
| 54 | 36 | GSM SIM Lock 1 |
| 55 | 37 | GSM SIM Lock 2 |
| 56 | 38 | GSM Module |
| 57 | 39 | Network |
| 58 | 3A | Network Invalid MAC |
| 59 | 3B | Wireless RX Jamming |
| 60 | 3C | Zone Tamper (`order` = zone#) |
| 61 | 3D | Anti-Mask Alarm |
| 62 | 3E | Wireless Zone Loss |
| 63 | 3F | Wireless Zone Fire Loss |
| 64 | 40 | Wireless Zone Low Battery |
| 65 | 41 | Wireless Zone Anti-Mask |
| 66 | 42 | Invalid Code Alarm |
| 67 | 43 | External Siren |
| 68 | 44 | Internal Siren |
| 69 | 45 | Time Not Set |
| 70 | 46 | Wireless Zone End-of-Life |
| 71 | 47 | Wireless Zone Low Sensitivity |
| 72 | 48 | Wireless Zone Clean-Me |
| 73 | 49 | Wireless Zone Power |
| 74 | 4A | Wireless Zone AC |
| 75 | 4B | Wireless Zone Trouble |
| 76 | 4C | Wireless Portable Unit Low Battery |
| 77 | 4D | Wireless Siren Loss |
| 78 | 4E | Wireless Siren Low Battery |
| 79 | 4F | Wireless Siren Tamper |
| 80 | 50 | Wireless Repeater Loss |
| 81 | 51 | Wireless Repeater Low Battery |
| 82 | 52 | Wireless Repeater Tamper |
| 83 | 53 | Wireless Repeater Jamming |
| 84 | 54 | Wireless Repeater AC |
| 85–88 | 55–58 | Wireless Gas 1–4 |
| 89 | 59 | Zone Expander Genuine |
| 90 | 5A | Wireless RX Genuine |
| 91 | 5B | Output Expander Genuine |
| 92 | 5C | Keypad Genuine |
| 93 | 5D | Local Expander Genuine |
| 95 | 5F | Wireless Arming Station Loss |
| 96 | 60 | Wireless Arming Station Low Battery |
| 97 | 61 | Wireless Arming Station Tamper |
| 98 | 62 | Wireless Arming Station Not Enrolled |

Empty `parameters: []` ⇒ no faults. `"more":"yes"` ⇒ paginate.

## CID events (Appendix A)

`type-qualifier-zone` semantics. Qualifier `1` = new event, `3` = restore — except arm-type events where `3` = arm and `1` = disarm.

| type | meaning (q=1 / q=3) | zone field |
|---|---|---|
| 100 | Medical alarm / restore | 0=keypad, N=zone |
| 110 | Fire alarm / restore | zone# |
| 115 | Pull-station fire alarm / restore | 0 |
| 120 | Keypad panic / restore | 0=keypad, N=zone |
| 121 | Duress alarm / restore | 0=code, N=zone/keyfob |
| 122 | Silent panic / restore | zone# |
| **130** | **Burglary alarm / restore** | zone# |
| 137 | Tamper 1/2 alarm / restore | 1 or 2 |
| 138 | Pre-alarm / restore | zone# |
| 143 | Expander fault / restore | module# |
| 144 | Cut/Short / restore | zone# |
| 145 | Expander tamper / restore | module# |
| 301 | AC loss / restore | 0 |
| 302 | Low battery / restore | 0 |
| 305 | System power-up | 0 |
| 306 | Panel program changed | 0 |
| 312 | Aux voltage fault / restore | 0=panel, N=expander |
| 321 | External siren trouble / restore | 1=wired, N=wireless |
| 322 | Internal siren trouble / restore | 2=wired, N=wireless |
| 338 | Expander low battery / restore | module# |
| 342 | Expander AC fault / restore | module# |
| 344 | Repeater wireless jamming / restore | module# |
| **350** | **CMS comm path trouble / restore** | 1=PSTN · 2=GPRS · 3=GSM voice · 4=Network |
| 351 | PSTN/GSM/Network/SIM detail fault | 0=PSTN · 1=GSM module · 2=Net · 3=SIM1 · 4=SIM2 |
| 373 | Wireless detector trouble / restore | zone# |
| 381 | Wireless zone supervision loss / restore | zone# |
| 384 | Wireless zone low battery / restore | zone# |
| 400 | Master code disarm / arm | 0 |
| **401** | **Local user disarm / arm** | 0=master, N=user |
| 403 | Auto arming | 0 (q=3 only) |
| **407** | **Remote disarm / arm (CMS, mobile, this plugin)** | 0=master, N=user |
| 408 | Fast arming | 0 (q=3) |
| 409 | Key-switch disarm / arm | zone# |
| 412 | Upload/Download remote | 0 |
| 421 | Access denied (invalid code / outside time window) | 0 |
| 441 | Home-X / Shabbat arm | 0=master, N=user (q=3) |
| 454 | Inactivity | 0 |
| 570 | Bypass / unbypass | zone# |
| 601 | Manual test (installer) | 0 |
| 602 | Auto periodic test | 0 |
| 625 | Time/Date changed | 0 |
| **760** | **Zone open / closed** | zone# (needs panel `Zone/Output Toggle = ON`) |
| **770** | **Output activated / de-activated** | output# (1–5 on-board) |

## Behavioural rules

- AS retries un-ACKed frames with the same counter — HA dedupes by counter but always re-ACKs.
- After draining its event buffer, AS emits a `null` heartbeat. ACK it, otherwise AS may close.
- `Zone/Output Toggle = ON` must be configured on the panel CMS path for 760/770 events.
- `Remote Disarm = ON` must be configured for optype 17 to be honoured on this channel.
- Hebrew names use Windows-1255, not UTF-8 — see `decodeBuffer` in `src/protocol.ts`.
- Frame size 250 B applies to HA→AS DATA. EVENT/ACK/OPERATION are natural length but stay small in practice.
- Field order in OPERATION/ACK matches the Chowmain C4 driver capture; some panels are picky if reordered.
- **Don't send a follow-up frame immediately after an OPERATION** — observed in zone-discovery probing: an `OPERATION` (e.g. disarm) followed within milliseconds by a `DATA-REQ` reaches the panel as one TCP segment (Nagle's), and the panel responds with `NAK counter=0 "JSON frame"` and silently drops *both*. The OPERATION never takes effect. Pause ≥500 ms after sending an OPERATION, or wait for the corresponding CID 401/407 confirmation event before sending the next HA→AS frame. Consider `socket.setNoDelay(true)` if back-to-back commands are ever needed.
- **One HA→AS request in flight at a time.** The same back-pressure applies to back-to-back DATA-REQs (and to OPERATION + DATA-REQ pairs): the panel processes the first and rejects the rest with `NAK counter=0 "JSON frame"`. Observed in v0.1.15: three concurrent `id=2310` partition-state queries — the panel answered the first, NAKed one of the others with counter=0, and silently dropped the third. The driver MUST serialise outbound requests on the wire; only send the next HA→AS frame after the response (DATA for DATA-REQ, ACK for OPERATION) or NAK to the previous one has been received (or the request has timed out). `src/transport.ts` enforces this.
