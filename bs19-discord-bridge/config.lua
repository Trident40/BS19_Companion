Config = {}

-- Display name included in every outbound webhook footer and metadata envelope
Config.ServerName = 'BeyondSurvival (BS19)'

-- Target URL of the bs19-discord-bot Express listener (/api/bs19-event)
-- Use 127.0.0.1 if the bot runs on the same host, or an HTTPS reverse-proxy URL if remote
Config.WebhookUrl = 'http://127.0.0.1:3045/api/bs19-event'

-- Shared secret sent via the 'x-api-secret' HTTP header.
-- MUST exactly match API_SECRET in bs19-discord-bot/.env
Config.ApiSecret = 'bs19_sec_9f4e2a8c7d1b6e04a3f92c81e5d70b4a'

-- Enable verbose server console logging for HTTP dispatch responses & auto-watcher catches
Config.Debug = true

-- Automatic BS19 Event Catcher (requires oxmysql + standard Arcainex/bs19 resources).
-- Automatically monitors bs_darkzone, bs_events, bs_operations, bs_building, bs_faction_bases,
-- and bs_faction_members (live faction & rank Discord role sync) with ZERO edits to core BS19 files.
Config.AutoWatch = true

-- Polling interval (ms) for state/table watchers. Minimum 2000ms.
Config.PollIntervalMs = 5000

-- Enable the in-game /verify command (generates a 6-character code players paste into Discord /verify)
-- and automatic live Discord faction & rank role syncing when players change factions or ranks.
Config.VerifySystem = {
    Enabled = true,
    CommandName = 'verify',
    CodeExpirySeconds = 600, -- 10 minutes
    AutoSyncRoles = true
}

-- HTTP request timeout in milliseconds
Config.RequestTimeoutMs = 5000

-- Toggle switches for BS19 event hooks.
-- Set any hook to false to silence its outbound Discord notification without editing BS19 scripts.
Config.Hooks = {
    dark_zone_shift = true, -- bs_darkzone rotations (bs_dz_state / bs_dz_zones)
    military_convoy = true, -- bs_events convoy spawns (EventKinds + bs_events:convoyReady)
    airdrop         = true, -- bs_events airdrop spawns (EventKinds)
    power_station   = true, -- bs_operations Power Station & bs_world power states (bs_ops_state)
    base_raid       = true, -- bs_building raid declarations (bs_build_raids) & bs:factionBases:changed reclaims
    vending_sale    = true, -- bs_building offline vending purchases (bs_transactions build_vend_buy_*)
    verify_code     = true, -- In-game /verify one-time code handoff to Discord bot
    role_sync       = true, -- Live faction & rank role sync pushes to Discord bot
    test_dispatch   = true -- Always allow /testdispatch connectivity checks
}
