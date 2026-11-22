# BS19 - Companion

> **Zero-Edit FiveM-to-Discord Bridge, Live World Dispatch, Interactive Verification Panel & Automatic Faction/Rank Sync for BeyondSurvival (BS19)**
> **Developed by Trident40**

![FiveM](https://img.shields.io/badge/FiveM-Cerulean%20%7C%20Lua%205.4-f59e0b?style=for-the-badge)
![Discord.js](https://img.shields.io/badge/Discord.js-v14.28%2B-5865F2?style=for-the-badge)
![Node.js](https://img.shields.io/badge/Node.js-20%2B-16a34a?style=for-the-badge)
![BS19](https://img.shields.io/badge/BeyondSurvival-Arcainex%2Fbs19-dc2626?style=for-the-badge)

---

## Overview

**BS19 - Companion** connects your **BeyondSurvival (`Arcainex/bs19`)** FiveM server directly to Discord with **zero modifications required to core BS19 files**.

It ships as two coordinated components:

1. **`bs19-discord-bridge/`** — A lightweight, server-only FiveM Lua 5.4 resource that automatically watches BS19 world events, offline vending sales, and faction roster changes, handles in-game `/verify` code generation, and dispatches authenticated JSON webhooks.
2. **`bs19-discord-bot/`** — A standalone Node.js (`discord.js` v14 + Express + `mysql2`) bot that posts rich real-time Discord embeds, maintains a permanent interactive `#verify` panel with buttons & modals, automatically manages **Verified / Faction / Rank roles** and **Discord nicknames**, and serves live read-only MySQL slash commands.

---

## Architecture

```text
┌─────────────────────────────────────────────┐
│        FiveM Server (Arcainex/bs19)         │
│  bs_darkzone · bs_events · bs_operations    │
│  bs_building · bs_faction_bases · oxmysql   │
└──────────────────────┬──────────────────────┘
                       │ Zero-Edit AutoWatch & /verify
                       ▼
┌─────────────────────────────────────────────┐
│       bs19-discord-bridge (Lua 5.4)         │
│  POST /api/bs19-event (x-api-secret header) │
└──────────────────────┬──────────────────────┘
                       │ Authenticated HTTP Webhook
                       ▼
┌─────────────────────────────────────────────┐        ┌──────────────────────────┐
│        bs19-discord-bot (Node.js 20+)       │◄──────►│  MySQL / MariaDB (bs19)  │
│  Express Listener · Discord.js v14 Client   │  Read  │  Native BS19 Tables      │
│  Role & Nickname Sync · Verify Panel Engine │  Only  └──────────────────────────┘
└──────────────────────┬──────────────────────┘
                       │ Discord REST & Gateway
                       ▼
┌─────────────────────────────────────────────┐
│               Discord Server                │
│  #wasteland-dispatch · #vending-market      │
│  #verify (Permanent Panel) · Roles & Nicks  │
└─────────────────────────────────────────────┘
```

---

## Key Features

### 1. Automatic Zero-Edit World Event Dispatch
`bs19-discord-bridge` automatically detects live BS19 events without editing any core BS19 scripts:

| BS19 Event | Detection Source in `Arcainex/bs19` | Target Discord Channel |
| :--- | :--- | :--- |
| **Dark Zone Shift** | Polls `bs_dz_state` (`k = 'rot'`) & `bs_dz_zones` | `DISPATCH_CHANNEL_ID` |
| **Military Convoy** | Listens to `bs_events:convoyReady` + `exports.bs_events:EventKinds()` | `DISPATCH_CHANNEL_ID` |
| **Supply Airdrop** | Polls `exports.bs_events:EventKinds()` for `airdrop` spawns | `DISPATCH_CHANNEL_ID` |
| **Power Station** | Polls `bs_ops_state` (`k = 'power'`) + `exports.bs_world:Blackout()` | `DISPATCH_CHANNEL_ID` |
| **Base Raid Alert** | Listens to `bs:factionBases:changed` + polls `bs_build_raids` | `DISPATCH_CHANNEL_ID` |
| **Offline Vending Sale** | Polls `bs_transactions` (`reason LIKE 'build_vend_buy_%'`) + `bs_build_pieces` | `MARKET_CHANNEL_ID` |
| **Faction / Rank Role Sync** | Polls `bs_faction_members` + in-game `/verify` | Discord Roles & Nicknames |

### 2. Permanent Interactive `#verify` Panel
- Automatically posts a permanent, information-packed verification embed into `VERIFY_CHANNEL_ID` on startup (or via Admin `/post-verify-panel`).
- Tracks its message ID in `verify-panel.json` and edits it in-place on restarts — **zero duplicate spam**.
- Includes **3 interactive buttons** (no slash commands required for players):
  - **Verify with Code** (Green) — Opens a Discord popup modal to enter their 6-character in-game `/verify` code.
  - **One-Click Auto-Verify** (Blurple) — Instantly links via `bs_users.discord` if Discord was running when they joined FiveM.
  - **Refresh Faction & Rank Roles** (Slate) — Manually refreshes their live roles and nickname anytime.

### 3. Automatic Faction/Rank Roles & Discord Nickname Sync
- Assigns **Verified Survivor**, **`Faction: <Faction Name>`**, and **`Rank: <Leader / Officer / Member>`**.
- Automatically creates missing Faction/Rank roles when `AUTO_CREATE_ROLES=true`, or maps to existing Role IDs via `FACTION_ROLES_JSON` / `RANK_ROLES_JSON`.
- Strips stale managed Faction/Rank roles automatically whenever a player changes factions, gets promoted/demoted, or leaves.
- Syncs Discord server nicknames to `{name} | {faction} | {rank}` (with smart fallback to `bs_faction_registry.short` to fit Discord's 32-character limit, and graceful handling of Discord's Server Owner rename restriction).
- **Read-Only MySQL Safe:** Verified Discord links persist locally in `linked-accounts.json` unless you explicitly opt into `ALLOW_DB_WRITE=true`.

---

## Commands Reference

### Discord Slash Commands

| Command | Access | Description |
| :--- | :--- | :--- |
| `/verify [code]` | Everyone | Link your BS19 survivor account (with 6-char code or blank for auto-verify) and claim roles & nickname. |
| `/sync-roles` | Everyone | Refresh your Faction & Rank Discord roles and nickname from live BS19 database records. |
| `/link` | Everyone | View your currently linked BS19 survivor, faction, and rank. |
| `/survivor [name]` | Everyone | Look up playtime, infected kills, Dark Zone PvP kills, extractions, and Wasteland Pass tier. |
| `/faction-status [faction]` | Everyone | Inspect faction treasury balance, member count, and active/contested territory flags. |
| `/market [item]` | Everyone | Search active offline vending crates sorted by lowest price with seller and GPS coordinates. |
| `/world-status` | Everyone | Display the live Power Station status, active Dark Zone sector, and latest Convoy/Airdrop. |
| `/test-event [event]` | **Admin Only** | Test-post `All Events` or any single BS19 event embed straight into its designated channel. |
| `/post-verify-panel [channel]` | **Admin Only** | Post or refresh the permanent interactive Verify Panel embed in `#verify` (or any channel). |

### FiveM Commands

| Command | Where | Description |
| :--- | :--- | :--- |
| `/verify` | In-Game Chat | Generates a 6-character code (valid 10 min) and relays character/faction data to the Discord bot. |
| `testdispatch [eventType]` | FiveM Server Console / ACE | Fires a live test HTTP webhook from FiveM to the bot (`test_dispatch`, `dark_zone_shift`, `military_convoy`, `airdrop`, `power_station`, `base_raid`, `vending_sale`). |

---

## Prerequisites

- **FiveM Server** running **BeyondSurvival (`Arcainex/bs19`)** with `oxmysql` started.
- **Node.js v20.0.0+** installed on the machine hosting the Discord bot (`node -v` to verify).
- **MySQL / MariaDB** access to your BS19 database (a dedicated read-only user is strongly recommended).
- **Discord Server** where you have **Administrator** permissions.

> **Important Folder Rule:** Keep `bs19-discord-bot/` **OUTSIDE** your FiveM `resources/` directory (for example, `C:\bs19-companion\bs19-discord-bot` on Windows or `/opt/bs19-companion/bs19-discord-bot` on Linux). Never place `node_modules` inside FiveM `resources/`.

---

## Step-by-Step Installation Guide

### Step 1 — Create & Configure Your Discord Bot
1. Go to the [Discord Developer Portal](https://discord.com/developers/applications) and click **New Application**.
2. Name it **`BS19 - Companion`** and click **Create**.
3. Copy your **Application ID** from **General Information** — this is your **`CLIENT_ID`**.
4. Open the **Bot** tab on the left:
   - Click **Reset Token** and copy the Bot Token — this is your **`DISCORD_TOKEN`** (never share this!).
   - Scroll down to **Privileged Gateway Intents** and turn **ON**:
     - **Server Members Intent** *(Required for role & nickname syncing!)*
   - Click **Save Changes**.
5. Open **OAuth2 → URL Generator**:
   - Under **Scopes**, check: `bot` and `applications.commands`.
   - Under **Bot Permissions**, check:
     - `View Channels`
     - `Send Messages`
     - `Embed Links`
     - `Manage Roles`
     - `Manage Nicknames`
   - Copy the generated URL at the bottom, open it in your browser, select your Discord server, and click **Authorize**.

### Step 2 — Grab Discord IDs & Set Role Hierarchy
1. In Discord, go to **User Settings → Advanced** and turn **ON** **Developer Mode**.
2. Right-click your Discord server icon → **Copy Server ID** → this is your **`GUILD_ID`**.
3. Create (or pick) your channels and right-click each → **Copy Channel ID**:
   - `#wasteland-dispatch` → **`DISPATCH_CHANNEL_ID`**
   - `#vending-market` → **`MARKET_CHANNEL_ID`**
   - `#verify` → **`VERIFY_CHANNEL_ID`**
4. **Set Role Hierarchy (Critical!):**
   - Go to **Server Settings → Roles**.
   - Drag the **BS19 - Companion** bot role **ABOVE** your `Verified Survivor`, `Faction: *`, `Rank: *`, and regular player roles.
   - *(Note: Discord does not allow any bot to rename the Server Owner, though roles will still sync normally.)*

### Step 3 — Create a Read-Only MySQL User (Recommended)
Run the following SQL in HeidiSQL, phpMyAdmin, or MySQL CLI (replace `bs19` and the password if different):

```sql
CREATE USER 'bs19_readonly'@'127.0.0.1' IDENTIFIED BY 'ChooseAStrongPasswordHere!';
GRANT SELECT ON bs19.* TO 'bs19_readonly'@'127.0.0.1';
FLUSH PRIVILEGES;
```

### Step 4 — Install the FiveM Resource (`bs19-discord-bridge`)
1. Copy the `bs19-discord-bridge/` folder into your FiveM server's `resources/[local]/` directory.
2. Open `bs19-discord-bridge/config.lua` and verify:
   - `Config.ServerName` — Your server name.
   - `Config.WebhookUrl` — `http://127.0.0.1:3045/api/bs19-event` (if the bot runs on the same machine).
   - `Config.ApiSecret` — Must match `API_SECRET` in the bot's `.env` **character-for-character**.
   - `Config.AutoWatch = true` and `Config.VerifySystem.Enabled = true`.
3. Open your FiveM `server.cfg` and add **after** `oxmysql` and `[beyond]`:

```cfg
ensure bs19-discord-bridge
```

4. Restart your FiveM server (or run `refresh` then `ensure bs19-discord-bridge` in the FiveM console). You should see:
   `[bs19-discord-bridge] BS19 - Companion (Developed by Trident40) initialized...`

### Step 5 — Install & Launch the Discord Bot (`bs19-discord-bot`)
1. Place `bs19-discord-bot/` outside FiveM's `resources` folder (e.g. `C:\bs19-companion\bs19-discord-bot`).
2. Copy `.env.example` to `.env` and fill in your real credentials.
3. Open a terminal inside `bs19-discord-bot/` and run:

```bash
npm install
node deploy-commands.js
node index.js
```

Expected startup output:
```text
[BS19 Webhook] Express listener active on port 3045 (POST /api/bs19-event)
[BS19 - Companion] Developed by Trident40 — Logged in as BS19 - Companion#1234
[BS19 VerifyPanel] Posted permanent verify panel in #verify
```

### Step 6 — Run 24/7 in Production (PM2)
Keep the bot running automatically across reboots using [PM2](https://pm2.keymetrics.io/):

```bash
npm install -g pm2
pm2 start index.js --name bs19-companion
pm2 save
pm2 startup
```

---

## Testing Checklist

1. **Test FiveM → Bot Webhook:** In the FiveM server console, run `testdispatch`. A connectivity embed should appear in `#wasteland-dispatch`.
2. **Test All Discord Channels at Once:** In Discord (as an Admin), run `/test-event event:All Events`. Confirm world events post to `#wasteland-dispatch` and the vending sale posts to `#vending-market`.
3. **Test Permanent Verify Panel:** Check `#verify` (or run `/post-verify-panel`). Click **Verify with Code** or **One-Click Auto-Verify** after running `/verify` in FiveM chat.
4. **Test Live DB Queries:** Run `/world-status`, `/survivor`, `/faction-status`, and `/market`.

---

## `.env` Configuration Reference

| Variable | Required | Default | Description |
| :--- | :---: | :--- | :--- |
| `DISCORD_TOKEN` | Yes | — | Bot token from Discord Developer Portal |
| `CLIENT_ID` | Yes | — | Application ID (used by `deploy-commands.js`) |
| `GUILD_ID` | Yes | — | Your Discord Server ID (instant guild slash command sync) |
| `DISPATCH_CHANNEL_ID` | Yes | — | Channel ID for world alerts & raid dispatches |
| `MARKET_CHANNEL_ID` | No | Dispatch | Channel ID for offline vending crate sales |
| `VERIFY_CHANNEL_ID` | No | — | Channel ID for the permanent interactive Verify Panel |
| `AUTO_POST_VERIFY_PANEL` | No | `true` | Automatically posts/updates the Verify Panel on startup |
| `WEBHOOK_PORT` | No | `3045` | Local port for the Express webhook listener |
| `API_SECRET` | Yes | — | Shared secret matching `Config.ApiSecret` in `config.lua` |
| `VERIFIED_ROLE_ID` | No | Auto | Existing Role ID for Verified Survivors (auto-created if blank) |
| `AUTO_CREATE_ROLES` | No | `true` | Auto-create missing Faction & Rank roles if not found |
| `FACTION_ROLE_PREFIX` | No | `Faction: ` | Prefix for managed Faction roles |
| `RANK_ROLE_PREFIX` | No | `Rank: ` | Prefix for managed Rank roles |
| `FACTION_ROLES_JSON` | No | `{}` | Optional JSON map of `{"faction_id":"role_id"}` overrides |
| `RANK_ROLES_JSON` | No | `{}` | Optional JSON map of `{"owner":"role_id","officer":"role_id"}` |
| `SYNC_NICKNAME` | No | `true` | Sync Discord nicknames on verify & faction/rank updates |
| `NICKNAME_FORMAT` | No | `{name} | {faction} | {rank}` | Format tokens: `{name}`, `{faction}`, `{short}`, `{rank}` |
| `ALLOW_DB_WRITE` | No | `false` | Keep `false` for read-only MySQL (links saved in `linked-accounts.json`) |
| `DB_HOST` / `DB_PORT` | Yes | `127.0.0.1:3306` | MySQL host & port |
| `DB_USER` / `DB_PASS` | Yes | — | Read-only MySQL username & password |
| `DB_NAME` | Yes | `bs19` | BS19 database name |

---

## Troubleshooting

- **`DiscordAPIError[50001]: Missing Access` during `node deploy-commands.js`:**
  - Verify `GUILD_ID` in `.env` is your **real** Discord Server ID (not the placeholder `987654321098765432`).
  - Re-invite the bot ensuring **both** `bot` and `applications.commands` scopes are checked.
- **`npm error Missing script: "deploy-commands"`:**
  - Run `node deploy-commands.js` (or `npm run deploy`).
- **Bot is invited but not showing online in Discord:**
  - The bot only appears online while `node index.js` (or PM2) is actively running, and make sure **Server Members Intent** is enabled in Developer Portal → Bot.
- **`Cannot assign role ... drag the bot's role ABOVE ...`:**
  - Open Discord **Server Settings → Roles** and drag **BS19 - Companion** above all Verified, Faction, and Rank roles.
- **Nickname didn't change when testing on your own account:**
  - Discord forbids bots from changing the **Server Owner's** nickname. Test with a secondary account or member whose role sits below the bot's role.
- **FiveM console shows `HTTP 401`:**
  - `Config.ApiSecret` in `config.lua` does not match `API_SECRET` in `.env`.
- **FiveM console shows `HTTP 0` / connection failed:**
  - Confirm `node index.js` is running, `WEBHOOK_PORT` matches `Config.WebhookUrl`, and firewall allows local traffic on port `3045`.

---

## Security Notes

- **Never commit `.env`** or share your `DISCORD_TOKEN`, `API_SECRET`, or MySQL password publicly.
- Webhook requests are authenticated with constant-time comparison (`crypto.timingSafeEqual`) against `x-api-secret`.
- All MySQL queries use parameterized placeholders (`?`) via `mysql2/promise` to prevent SQL injection.

---

## Credits

- **BS19 - Companion** — **Developed by Trident40**
- Built natively for **BeyondSurvival (`Arcainex/bs19`)**
