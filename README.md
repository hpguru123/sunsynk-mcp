# Sunsynk Solar MCP Server

A **read-only** [Model Context Protocol](https://modelcontextprotocol.io) server that gives Claude (or any MCP client) access to your Sunsynk inverter, battery and solar data through the Sunsynk Connect cloud API (`api.sunsynk.net`).

Ask Claude things like *"How much did the battery charge overnight?"* or *"Review my time-of-use settings against my tariff"*. It pulls live data, settings and history, and answers from them.

> **Unofficial project.** This is not affiliated with, endorsed by or supported by Sunsynk. It uses the undocumented API behind the Sunsynk Connect app, which may change or break without notice. Use at your own risk.

---

## Contents

1. [What it can and can't do](#what-it-can-and-cant-do)
2. [Requirements](#requirements)
3. [Installation](#installation)
4. [Configuration](#configuration)
5. [Command reference](#command-reference)
6. [Example prompts](#example-prompts)
7. [Reading the data](#reading-the-data)
8. [Troubleshooting](#troubleshooting)
9. [Security](#security)
10. [How it works](#how-it-works)
11. [Contributing](#contributing)
12. [Licence](#licence)

---

## What it can and can't do

**Can:**
- List your plants (sites) and inverters
- Show a real-time snapshot: PV, battery SOC/power/temperature, grid import/export and house load
- Show the power-flow diagram data from the app
- Pull energy history by day, month, year or lifetime
- Read inverter configuration: work mode, time-of-use slots, SOC targets, grid charge and battery limits
- Make raw read-only GET calls to other `api/v1/` endpoints

**Can't:**
- **Change any setting.** There are no write tools, by design. Claude can recommend settings, but you apply them in the Sunsynk app or portal.
- Log in when the account has MFA / verification codes enabled (see [Troubleshooting](#troubleshooting))
- Talk to the inverter locally. Everything goes through the Sunsynk cloud, so data is only as fresh as the dongle's uploads (typically every few minutes).

---

## Requirements

- Claude Desktop (or another MCP client that supports stdio servers)
- Node.js 18+ (only needed if you run from source; the `.mcpb` bundle includes its runtime needs)
- A Sunsynk Connect account (the same login as the Sunsynk app) with the inverter registered to it

---

## Installation

### Option A: Claude Desktop extension (easiest)

1. Download `sunsynk.mcpb` from the [Releases](https://github.com/hpguru123/sunsynk-mcp/releases) page.
2. Double-click it, or in Claude Desktop go to **Settings → Extensions** and install from file.
3. Enter your Sunsynk Connect email and password when prompted. They're stored in Claude Desktop's secure credential store, not in a file.
4. Restart Claude Desktop if the tools don't appear straight away.

### Option B: Run from source

```bash
git clone https://github.com/hpguru123/sunsynk-mcp.git
cd sunsynk-mcp
npm install
```

Add it to your MCP client config, for example `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "sunsynk": {
      "command": "node",
      "args": ["/path/to/sunsynk-mcp/server/index.js"],
      "env": {
        "SUNSYNK_USERNAME": "you@example.com",
        "SUNSYNK_PASSWORD": "your-password"
      }
    }
  }
}
```

### Building the extension yourself

```bash
npm install
npm run pack        # produces sunsynk.mcpb using @anthropic-ai/mcpb
```

---

## Configuration

| Setting / env var | Required | Description |
|---|---|---|
| `SUNSYNK_USERNAME` | Yes | Your Sunsynk Connect login email |
| `SUNSYNK_PASSWORD` | Yes | Your Sunsynk Connect password |
| `TZ` | No | Time zone used for "today" defaults (the extension sets `Europe/London`) |
| `SUNSYNK_BASE_URL` | No | Override the API host (default `https://api.sunsynk.net`); handy for testing against a mock server |

When installed as an extension, Claude Desktop prompts for the username and password and passes them in as these variables.

A read-only **viewer** account is a good idea if your installer can set one up. That limits the damage if the credentials ever leak.

---

## Command reference

Most tools default to the **first** plant or inverter on the account, so on a single-inverter system you can usually omit IDs. If you have several, run `sunsynk_list_inverters` / `sunsynk_list_plants` first and pass the `sn` or `plant_id`.

> Tip: some setups need the serial passed explicitly. If a call returns nothing, get the `sn` from `sunsynk_list_inverters` and pass it.

### `sunsynk_list_plants`
Lists the sites on your account.

| Parameter | Type | Required | Notes |
|---|---|---|---|
| none | | | |

**Returns:** plant `id`, name, current PV power (`pac`, W), today's and lifetime generation (kWh), status.

---

### `sunsynk_list_inverters`
Lists inverters on the account. **Start here** to get the serial number (`sn`) the other tools use.

| Parameter | Type | Required | Notes |
|---|---|---|---|
| none | | | |

**Returns:** `sn`, model, firmware, status, current power, today's generation.

---

### `sunsynk_live_status`
Real-time snapshot of one inverter.

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `sn` | string | No | Inverter serial; defaults to the first inverter |
| `include_raw` | boolean | No | Also return the full raw API payloads, useful for debugging or odd fields |

**Returns:** PV input, battery (SOC %, power, temperature), grid (import/export power and today's totals), household load and inverter output.

---

### `sunsynk_power_flow`
The data behind the animated flow diagram in the app.

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `plant_id` | integer | No | Defaults to the first plant |

**Returns:** PV, battery, grid and load power, battery SOC and flow directions.

---

### `sunsynk_energy_history`
Historical energy data.

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `period` | `day` \| `month` \| `year` \| `total` | **Yes** | Granularity |
| `date` | string | No | `YYYY-MM-DD` for day, `YYYY-MM` for month, `YYYY` for year. Defaults to today or the current period. Not used for `total`. |
| `plant_id` | integer | No | Defaults to the first plant |

| `period` | What you get |
|---|---|
| `day` | Intraday power curves (PV, battery, grid, load, SOC) for that date, ideal for checking overnight charging |
| `month` | Daily kWh totals for the month |
| `year` | Monthly kWh totals for the year |
| `total` | Yearly totals since install |

---

### `sunsynk_inverter_settings`
Reads (never writes) the inverter configuration.

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `sn` | string | No | Defaults to the first inverter |

**Returns:** system work mode, the six time-of-use slots (start time, power, SOC target, grid-charge flag), grid charge settings, battery charge/discharge limits, export limits and related fields.

---

### `sunsynk_api_get`
Escape hatch for endpoints the other tools don't cover. **GET only.** The path is validated, so it can't reach anything outside `api/v1/`.

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `path` | string | **Yes** | Relative path starting `api/v1/`, e.g. `api/v1/plant/123/realtime?id=123` |

**Returns:** the `data` field of the API response.

---

## Example prompts

You don't need to name the tools. Just ask in plain English:

| You ask | Tools Claude will typically use |
|---|---|
| "What's my solar and battery doing right now?" | `sunsynk_live_status` or `sunsynk_power_flow` |
| "Did the battery fill up in the cheap window last night?" | `sunsynk_energy_history` (`day`, yesterday/today) |
| "Show my time-of-use slots" | `sunsynk_inverter_settings` |
| "Review my settings against my tariff: cheap rate 23:00–06:00 at 5.5p, peak 22p, export 5.6p" | `sunsynk_inverter_settings` + `sunsynk_energy_history` |
| "How much did I generate, import and export this month?" | `sunsynk_energy_history` (`month`) |
| "Compare this summer with last summer" | `sunsynk_energy_history` (`year`) for both years |
| "What firmware is the inverter on?" | `sunsynk_list_inverters` |

**Tip:** give Claude your tariff (rates and cheap-window times) in the prompt, or it can't judge whether the settings are cost-optimal.

---

## Reading the data

- **Sign conventions** follow Sunsynk's API and can vary by field. Typically:
  - Battery power **+** = discharging, **−** = charging
  - Grid power **+** = importing, **−** = exporting

  If something looks backwards, re-run `sunsynk_live_status` with `include_raw: true` and check the raw field.
- **Units:** power in W, energy in kWh, SOC in %.
- **Time-of-use slots:** each slot runs from its start time until the next slot's start time. Slots should be in chronological order; out-of-order times are a common misconfiguration.
- **AC-coupled generation** (e.g. a separate micro-inverter) may show up in load or grid figures rather than PV, depending on how it's wired and whether it's metered by the Sunsynk.
- **Freshness:** cloud data lags the inverter by a few minutes.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `Verification code is Need` on every call | MFA / verification code is enabled on the Sunsynk Connect account. This isn't a wrong password. | Turn off MFA in the Sunsynk app/portal, or use a separate viewer account without MFA. MFA login isn't supported yet (PRs welcome). |
| Login fails with a credentials error | Wrong email or password | Re-enter them in **Settings → Extensions → Sunsynk → Configure** (or fix the env vars) and restart |
| Tools don't appear in Claude | Extension not loaded | Check it's enabled in Settings → Extensions and restart Claude Desktop |
| Empty result from settings or live status | Default inverter not picked up | Pass `sn` from `sunsynk_list_inverters` |
| Data looks stale | Dongle offline or uploads delayed | Check the dongle's Wi-Fi; compare with the Sunsynk app |
| Sudden errors after working fine | Sunsynk changed its API | Check [Issues](https://github.com/hpguru123/sunsynk-mcp/issues); the unofficial API can change without notice |

---

## Security

- **Read-only by design.** No tool can change inverter settings, and `sunsynk_api_get` is restricted to GET under `api/v1/`. Battery, grid and export limits are safety- and G99-compliance settings, and an AI shouldn't be able to write them unsupervised.
- **Credentials** are only sent to `api.sunsynk.net`. The password is RSA-encrypted before sending, matching Sunsynk's own login flow. Auth tokens are cached in memory only.
- **Never commit credentials.** Keep them in the extension's credential prompt or environment variables, not in config files in the repo.
- Your inverter serial and plant IDs identify your site. Leave them out of issues and logs you post publicly.

---

## How it works

- Node.js MCP server over stdio
- Authenticates against Sunsynk Connect with RSA PKCS#1-encrypted login, caches the bearer token and refreshes automatically when it expires
- Endpoint structure informed by James Ridgway's open-source Python library [sunsynk-api-client](https://github.com/jamesridgway/sunsynk-api-client) (MIT). This project is an independent Node.js implementation and contains no code from it.
- Packaged as a Claude Desktop extension (`.mcpb`) with a manifest, icon and secure credential prompts

---

## Contributing

Issues and pull requests are welcome. The most useful addition would be support for Sunsynk's login verification code (MFA). Please keep the server read-only: PRs that add write access to inverter settings won't be merged.

---

## Licence

MIT. See [LICENSE](LICENSE).

"Sunsynk" is a trademark of its owner and is used here only to describe compatibility. This project is not affiliated with Sunsynk.
