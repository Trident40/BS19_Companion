local RESOURCE_NAME = GetCurrentResourceName()

local function debugPrint(fmt, ...)
    if not Config.Debug then return end
    print(('[%s] ' .. fmt):format(RESOURCE_NAME, ...))
end

local function errorPrint(fmt, ...)
    print(('^1[%s] ERROR: ' .. fmt .. '^7'):format(RESOURCE_NAME, ...))
end

local function resourceStarted(name)
    return GetResourceState(name) == 'started'
end

local function isHookEnabled(eventType)
    if type(Config.Hooks) ~= 'table' then
        return true
    end
    local flag = Config.Hooks[eventType]
    if flag == nil then
        return true
    end
    return flag == true
end

local function normalizePayload(payload)
    if type(payload) ~= 'table' then
        return {}
    end
    return payload
end

local function formatCoords(x, y)
    local nx, ny = tonumber(x), tonumber(y)
    if not nx or not ny then return 'Uncharted' end
    return ('X: %.1f, Y: %.1f'):format(nx, ny)
end

local function safeQuery(sql, params)
    if not resourceStarted('oxmysql') then return {} end
    local ok, rows = pcall(function()
        return exports.oxmysql:query_async(sql, params or {})
    end)
    if not ok or type(rows) ~= 'table' then return {} end
    return rows
end

local function safeScalar(sql, params)
    if not resourceStarted('oxmysql') then return nil end
    local ok, val = pcall(function()
        return exports.oxmysql:scalar_async(sql, params or {})
    end)
    if not ok then return nil end
    return val
end

local function safeJsonDecode(raw)
    if type(raw) ~= 'string' or raw == '' then return nil end
    local ok, decoded = pcall(json.decode, raw)
    if ok and type(decoded) == 'table' then return decoded end
    return nil
end

-- ============================================================================
-- CORE WEBHOOK DISPATCHER (PerformHttpRequest -> Express /api/bs19-event)
-- ============================================================================

local function SendEvent(eventType, payload)
    if type(eventType) ~= 'string' or eventType == '' then
        errorPrint('SendEvent called with invalid eventType.')
        return false
    end

    if not isHookEnabled(eventType) then
        debugPrint('Skipping "%s" because Config.Hooks.%s is disabled.', eventType, eventType)
        return false
    end

    if not Config.WebhookUrl or Config.WebhookUrl == '' then
        errorPrint('Config.WebhookUrl is empty. Configure config.lua before dispatching events.')
        return false
    end

    if not Config.ApiSecret or Config.ApiSecret == '' then
        errorPrint('Config.ApiSecret is empty. Refusing to send unauthenticated webhook request.')
        return false
    end

    local envelope = {
        eventType  = eventType,
        serverName = Config.ServerName or 'BeyondSurvival (BS19)',
        timestamp  = os.date('!%Y-%m-%dT%H:%M:%SZ'),
        payload    = normalizePayload(payload)
    }

    local ok, encodedBody = pcall(json.encode, envelope)
    if not ok or not encodedBody then
        errorPrint('Failed to JSON-encode payload for event "%s": %s', eventType, tostring(encodedBody))
        return false
    end

    local headers = {
        ['Content-Type'] = 'application/json',
        ['x-api-secret'] = Config.ApiSecret,
        ['User-Agent']   = 'BS19-Discord-Bridge/1.2'
    }

    debugPrint('Dispatching "%s" -> %s', eventType, Config.WebhookUrl)

    PerformHttpRequest(Config.WebhookUrl, function(statusCode, responseText)
        if statusCode >= 200 and statusCode < 300 then
            debugPrint('Event "%s" delivered (HTTP %d). Response: %s', eventType, statusCode, responseText or 'OK')
        elseif statusCode == 0 then
            errorPrint('Connection refused for "%s" at %s. Verify bs19-discord-bot is running.', eventType, Config.WebhookUrl)
        elseif statusCode == 401 or statusCode == 403 then
            errorPrint('Authentication failed (HTTP %d) for "%s". Check Config.ApiSecret vs .env API_SECRET.', statusCode, eventType)
        else
            errorPrint('Bot listener returned HTTP %d for "%s": %s', statusCode, eventType, tostring(responseText))
        end
    end, 'POST', encodedBody, headers)

    return true
end

-- ============================================================================
-- SERVER EXPORTS (Manual integration still supported alongside AutoWatch)
-- ============================================================================

exports('SendEvent', SendEvent)
exports('SendDarkZoneShift', function(data) return SendEvent('dark_zone_shift', data) end)
exports('SendMilitaryConvoy', function(data) return SendEvent('military_convoy', data) end)
exports('SendAirdrop', function(data) return SendEvent('airdrop', data) end)
exports('SendPowerStationStatus', function(data) return SendEvent('power_station', data) end)
exports('SendBaseRaidAlert', function(data) return SendEvent('base_raid', data) end)
exports('SendVendingSale', function(data) return SendEvent('vending_sale', data) end)

AddEventHandler('bs19:dispatch:sendEvent', function(eventType, payload) SendEvent(eventType, payload) end)
AddEventHandler('bs19:world:darkZoneShift', function(payload) SendEvent('dark_zone_shift', payload) end)
AddEventHandler('bs19:world:militaryConvoy', function(payload) SendEvent('military_convoy', payload) end)
AddEventHandler('bs19:world:airdrop', function(payload) SendEvent('airdrop', payload) end)
AddEventHandler('bs19:world:powerStation', function(payload) SendEvent('power_station', payload) end)
AddEventHandler('bs19:base:raidAlert', function(payload) SendEvent('base_raid', payload) end)
AddEventHandler('bs19:vending:sale', function(payload) SendEvent('vending_sale', payload) end)

-- ============================================================================
-- IN-GAME /verify COMMAND (One-Time Code Generator for Discord Link & Roles)
-- ============================================================================

local CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789' -- Excludes ambiguous 0/O/1/I
local verifyCooldowns = {}

local function generateVerifyCode()
    math.randomseed(os.time() + GetGameTimer() + math.random(1, 99999))
    local chars = {}
    for i = 1, 6 do
        local idx = math.random(1, #CODE_ALPHABET)
        chars[i] = CODE_ALPHABET:sub(idx, idx)
    end
    return table.concat(chars)
end

local function notifyPlayer(src, title, msg, color)
    if src == 0 then
        print(('[%s] %s: %s'):format(RESOURCE_NAME, title, msg))
        return
    end
    if resourceStarted('bs_ui') then
        TriggerClientEvent('bs:ui:notify', src, { type = 'info', message = msg, duration = 12000 })
    end
    TriggerClientEvent('chat:addMessage', src, {
        color = color or { 217, 119, 6 },
        args = { title, msg }
    })
end

local function resolveSurvivorContext(src)
    local license = GetPlayerIdentifierByType(src, 'license') or GetPlayerIdentifierByType(src, 'license2')
    local discordRaw = GetPlayerIdentifierByType(src, 'discord')
    local charId = nil
    local charName = GetPlayerName(src) or ('Survivor #' .. tostring(src))

    if resourceStarted('bs_core') then
        local ok, p = pcall(function() return exports.bs_core:GetPlayer(src) end)
        if ok and type(p) == 'table' and p.charId then
            charId = tonumber(p.charId)
        end
    end

    -- Fallback DB lookup via bs_users -> bs_characters
    if not charId and license then
        local rows = safeQuery([[
            SELECT c.id, CONCAT(c.first_name, ' ', c.last_name) AS full_name, u.id AS user_id
            FROM bs_users u
            JOIN bs_characters c ON c.user_id = u.id AND c.deleted_at IS NULL
            WHERE u.identifier = ?
            ORDER BY c.last_played DESC
            LIMIT 1
        ]], { license })
        if rows[1] then
            charId = tonumber(rows[1].id)
            if rows[1].full_name and rows[1].full_name ~= ' ' then
                charName = rows[1].full_name
            end
        end
    elseif charId then
        local rows = safeQuery('SELECT CONCAT(first_name, " ", last_name) AS full_name FROM bs_characters WHERE id = ? LIMIT 1', { charId })
        if rows[1] and rows[1].full_name and rows[1].full_name ~= ' ' then
            charName = rows[1].full_name
        end
    end

    local factionId, factionLabel, factionShort, factionRank, rankLabel = nil, nil, nil, nil, nil
    if charId then
        local fRows = safeQuery([[
            SELECT m.faction_id, m.rank, r.label, r.short,
                   COALESCE(rk.label, m.rank) AS rank_label
            FROM bs_faction_members m
            LEFT JOIN bs_faction_registry r ON r.faction_id = m.faction_id
            LEFT JOIN bs_faction_ranks rk ON rk.faction_id = m.faction_id AND rk.rank_id = m.rank
            WHERE m.character_id = ?
            LIMIT 1
        ]], { charId })
        if fRows[1] then
            factionId = fRows[1].faction_id
            factionLabel = fRows[1].label or fRows[1].faction_id
            factionShort = fRows[1].short or ''
            factionRank = fRows[1].rank or 'member'
            rankLabel = fRows[1].rank_label or factionRank
        end
    end

    return {
        license = license or '',
        discord = discordRaw or '',
        charId = charId,
        charName = charName,
        factionId = factionId,
        factionLabel = factionLabel,
        factionShort = factionShort,
        factionRank = factionRank,
        rankLabel = rankLabel
    }
end

if Config.VerifySystem and Config.VerifySystem.Enabled then
    local cmdName = Config.VerifySystem.CommandName or 'verify'
    RegisterCommand(cmdName, function(source)
        if source == 0 then
            print(('^3[%s] /%s must be run in-game by a player.^7'):format(RESOURCE_NAME, cmdName))
            return
        end

        local now = os.time()
        if verifyCooldowns[source] and (now - verifyCooldowns[source]) < 15 then
            notifyPlayer(source, 'BS19 Verify', 'Please wait a few seconds before requesting another code.', { 220, 38, 38 })
            return
        end
        verifyCooldowns[source] = now

        local ctx = resolveSurvivorContext(source)
        if not ctx.charId then
            notifyPlayer(source, 'BS19 Verify', 'Load into your survivor character first before running /' .. cmdName .. '.', { 220, 38, 38 })
            return
        end

        local code = generateVerifyCode()
        local expirySec = tonumber(Config.VerifySystem.CodeExpirySeconds) or 600

        local sent = SendEvent('verify_code', {
            code         = code,
            expiresAt    = now + expirySec,
            license      = ctx.license,
            discord      = ctx.discord,
            charId       = ctx.charId,
            charName     = ctx.charName,
            factionId    = ctx.factionId,
            factionLabel = ctx.factionLabel,
            factionShort = ctx.factionShort,
            factionRank  = ctx.factionRank,
            rankLabel    = ctx.rankLabel
        })

        if sent then
            notifyPlayer(
                source,
                'BS19 Verify',
                ('Your Discord link code is: %s (valid %d min). Run /verify code:%s in Discord!'):format(
                    code, math.floor(expirySec / 60), code
                ),
                { 22, 163, 74 }
            )
        else
            notifyPlayer(source, 'BS19 Verify', 'Unable to reach Discord bridge right now. Ask an admin to check bs19-discord-bot.', { 220, 38, 38 })
        end
    end, false)
end

-- ============================================================================
-- AUTOMATIC BS19 EVENT CATCHER (Zero edits needed to Arcainex/bs19 resources)
-- ============================================================================

local factionLabelCache = {}
local function getFactionLabel(factionId)
    if not factionId or factionId == '' then return 'Unclaimed' end
    if factionLabelCache[factionId] then return factionLabelCache[factionId] end
    local rows = safeQuery('SELECT label FROM bs_faction_registry WHERE faction_id = ? LIMIT 1', { factionId })
    local label = (rows[1] and rows[1].label) or factionId
    factionLabelCache[factionId] = label
    return label
end

local function getDarkZoneMeta(zoneId)
    if not zoneId or zoneId == '' then
        return { label = 'Inactive', coords = 'N/A' }
    end
    local rows = safeQuery('SELECT data FROM bs_dz_zones WHERE id = ? LIMIT 1', { zoneId })
    local decoded = rows[1] and safeJsonDecode(rows[1].data)
    if decoded then
        return {
            label = decoded.label or zoneId,
            coords = formatCoords(decoded.x, decoded.y)
        }
    end
    local pretty = tostring(zoneId):gsub('_', ' '):gsub('(%a)([%w]*)', function(a, b) return a:upper() .. b end)
    return { label = pretty, coords = 'Check In-Game Map (/dz)' }
end

-- 1. Real-Time Listener: bs_faction_bases flag reclaim / capture alerts
local notifiedReclaims = {}
AddEventHandler('bs:factionBases:changed', function(flags)
    if not Config.AutoWatch or not isHookEnabled('base_raid') or type(flags) ~= 'table' then return end
    for _, flag in ipairs(flags) do
        if flag.status == 'reclaiming' and flag.id then
            local key = ('%s:%s:%s'):format(tostring(flag.id), tostring(flag.reclaimBy or ''), tostring(flag.reclaimEnds or 0))
            if not notifiedReclaims[key] then
                notifiedReclaims[key] = true
                SendEvent('base_raid', {
                    targetFaction   = flag.flabel or getFactionLabel(flag.factionId),
                    attackerFaction = getFactionLabel(flag.reclaimBy),
                    sector          = ('%s Territory Flag #%s'):format(tostring(flag.kind or 'outpost'):upper(), tostring(flag.id)),
                    breachMethod    = 'Flag Reclaim / Capture In Progress',
                    coords          = formatCoords(flag.x, flag.y)
                })
            end
        end
    end
end)

-- 2. Real-Time Listener: bs_events convoy activation
local seenConvoyIds = {}
AddEventHandler('bs_events:convoyReady', function(evId)
    if not Config.AutoWatch or not isHookEnabled('military_convoy') then return end
    local idKey = tonumber(evId) or tostring(evId)
    if seenConvoyIds[idKey] then return end
    seenConvoyIds[idKey] = true

    local src = source
    local coords = 'Moving Highway Route'
    if src and src > 0 then
        local ped = GetPlayerPed(src)
        if ped and ped ~= 0 then
            local c = GetEntityCoords(ped)
            coords = formatCoords(c.x, c.y)
        end
    end

    SendEvent('military_convoy', {
        callsign    = ('BS19-CONVOY-#%s'):format(tostring(idKey)),
        route       = 'Active BS19 Convoy Corridor (Check Radio / Map)',
        escortCount = 4,
        cargoType   = 'Locked Military Crates (Lockpick / Crowbar Required)',
        coords      = coords
    })
end)

-- 3. Automatic Poller Thread for world events + live faction/rank role sync
CreateThread(function()
    if not Config.AutoWatch then
        debugPrint('Config.AutoWatch is false. Manual exports and TriggerEvent hooks remain active.')
        return
    end

    local waitMs = 0
    while not resourceStarted('oxmysql') and waitMs < 30000 do
        Wait(500)
        waitMs = waitMs + 500
    end

    local pollMs = math.max(2000, tonumber(Config.PollIntervalMs) or 5000)

    local prevEventRunning = {}
    local lastDzKey = nil
    local lastDzLabel = 'Previous Sector'
    local lastPowerSignature = nil
    local lastRaidId = tonumber(safeScalar('SELECT COALESCE(MAX(id), 0) FROM bs_build_raids')) or 0
    local lastVendTxId = tonumber(safeScalar("SELECT COALESCE(MAX(id), 0) FROM bs_transactions WHERE reason LIKE 'build_vend_buy_%'")) or 0
    local memberSnapshot = {} -- [charId] = 'factionId:rank'

    if resourceStarted('bs_events') then
        local ok, kinds = pcall(function() return exports.bs_events:EventKinds() end)
        if ok and type(kinds) == 'table' then
            for _, k in ipairs(kinds) do
                prevEventRunning[k.kind] = tonumber(k.running) or 0
            end
        end
    end

    local initDzRow = safeQuery("SELECT v FROM bs_dz_state WHERE k = 'rot' LIMIT 1")
    if initDzRow[1] then
        local st = safeJsonDecode(initDzRow[1].v)
        if st then
            lastDzKey = ('%s:%s'):format(tostring(st.zone or ''), tostring(st.startedAt or 0))
            lastDzLabel = getDarkZoneMeta(st.zone).label
        end
    end

    local initPwRow = safeQuery("SELECT v FROM bs_ops_state WHERE k = 'power' LIMIT 1")
    if initPwRow[1] then
        local st = safeJsonDecode(initPwRow[1].v)
        if st then
            local buffFac = st.buff and st.buff.faction or ''
            local buffLive = st.buff and (tonumber(st.buff.endsAt) or 0) > os.time()
            lastPowerSignature = ('%s:%s'):format(buffLive and 'ONLINE' or 'OFFLINE', tostring(buffFac))
        end
    end

    -- Seed faction membership snapshot so startup does not trigger mass role syncs
    if Config.VerifySystem and Config.VerifySystem.AutoSyncRoles then
        local initMembers = safeQuery('SELECT character_id, faction_id, rank FROM bs_faction_members')
        for _, m in ipairs(initMembers) do
            memberSnapshot[tonumber(m.character_id)] = ('%s:%s'):format(tostring(m.faction_id or ''), tostring(m.rank or 'member'))
        end
    end

    print(('^2[%s] BS19 Auto-Watcher active (interval: %dms | baseline raid #%d, vending tx #%d)^7'):format(
        RESOURCE_NAME, pollMs, lastRaidId, lastVendTxId
    ))

    local roleSyncTick = 0

    while true do
        Wait(pollMs)
        roleSyncTick = roleSyncTick + 1

        -- [A] Poll bs_events:EventKinds() for Airdrop & Military Convoy starts
        if resourceStarted('bs_events') then
            local ok, kinds = pcall(function() return exports.bs_events:EventKinds() end)
            if ok and type(kinds) == 'table' then
                for _, entry in ipairs(kinds) do
                    local kind = entry.kind
                    local running = tonumber(entry.running) or 0
                    local prev = prevEventRunning[kind] or 0

                    if running > prev then
                        if kind == 'airdrop' and isHookEnabled('airdrop') then
                            SendEvent('airdrop', {
                                dropZone      = 'Active Drop Sector (Check In-Game Radio)',
                                crateTier     = 'BS19 Supply Drop Crate (Open PvP Zone)',
                                coords        = 'Follow Red Signal Flare',
                                unlockSeconds = 180,
                                flareColor    = 'Red Signal Flare'
                            })
                        elseif kind == 'convoy' and isHookEnabled('military_convoy') then
                            local syntheticKey = 'poll_' .. tostring(os.time())
                            if not seenConvoyIds[syntheticKey] then
                                SendEvent('military_convoy', {
                                    callsign    = 'BS19-MILITARY-CONVOY',
                                    route       = 'Active BS19 Highway Route (Check In-Game Radio)',
                                    escortCount = 4,
                                    cargoType   = 'Locked Military Vehicles & Crates',
                                    coords      = 'Check Map Blip'
                                })
                            end
                        end
                    end
                    prevEventRunning[kind] = running
                end
            end
        end

        -- [B] Poll bs_dz_state ('rot') for Dark Zone rotations
        if isHookEnabled('dark_zone_shift') and resourceStarted('bs_darkzone') then
            local rows = safeQuery("SELECT v FROM bs_dz_state WHERE k = 'rot' LIMIT 1")
            local st = rows[1] and safeJsonDecode(rows[1].v)
            if st and st.zone and st.zone ~= '' then
                local sig = ('%s:%s'):format(tostring(st.zone), tostring(st.startedAt or 0))
                if lastDzKey ~= nil and sig ~= lastDzKey then
                    local meta = getDarkZoneMeta(st.zone)
                    local minsLeft = st.nextAt and math.max(1, math.floor((tonumber(st.nextAt) - os.time()) / 60)) or 240
                    SendEvent('dark_zone_shift', {
                        previousSector   = lastDzLabel or 'Previous Sector',
                        activeSector     = meta.label,
                        radiationLevel   = 'Contaminated PvP Zone',
                        coords           = meta.coords,
                        nextShiftMinutes = minsLeft,
                        lootMultiplier   = 'Contaminated Tier III Crates'
                    })
                    lastDzLabel = meta.label
                elseif lastDzKey == nil then
                    lastDzLabel = getDarkZoneMeta(st.zone).label
                end
                lastDzKey = sig
            end
        end

        -- [C] Poll bs_ops_state ('power') for Power Station status transitions
        if isHookEnabled('power_station') and resourceStarted('bs_operations') then
            local rows = safeQuery("SELECT v FROM bs_ops_state WHERE k = 'power' LIMIT 1")
            local st = rows[1] and safeJsonDecode(rows[1].v)
            if st then
                local nowTs = os.time()
                local buff = type(st.buff) == 'table' and st.buff or nil
                local isOnline = buff ~= nil and (tonumber(buff.endsAt) or 0) > nowTs
                local facId = isOnline and buff.faction or nil
                local statusStr = isOnline and 'ONLINE' or 'OFFLINE'
                local sig = ('%s:%s'):format(statusStr, tostring(facId or ''))

                if lastPowerSignature ~= nil and sig ~= lastPowerSignature then
                    local blackoutOn = false
                    if resourceStarted('bs_world') then
                        local okB, bVal = pcall(function() return exports.bs_world:Blackout() end)
                        if okB then blackoutOn = bVal == true end
                    end

                    SendEvent('power_station', {
                        status             = statusStr,
                        gridLoadPercent    = isOnline and 100 or 0,
                        controllingFaction = facId and getFactionLabel(facId) or 'Unclaimed',
                        affectedZones      = isOnline
                            and 'Downtown Power Grid & Illuminated Safe Zones (XP Buff Active)'
                            or (blackoutOn and 'Server-Wide Blackout Active' or 'Power Grid Standby / Cooldown')
                    })
                end
                lastPowerSignature = sig
            end
        end

        -- [D] Poll bs_build_raids for newly declared faction base raids
        if isHookEnabled('base_raid') and resourceStarted('bs_building') then
            local raids = safeQuery([[
                SELECT r.id, r.attacker_id, r.target_id, r.declared_at, r.ends_at,
                       fa.label AS attacker_label, ft.label AS target_label,
                       fl.x AS flag_x, fl.y AS flag_y
                FROM bs_build_raids r
                LEFT JOIN bs_faction_registry fa ON fa.faction_id = r.attacker_id
                LEFT JOIN bs_faction_registry ft ON ft.faction_id = r.target_id
                LEFT JOIN bs_faction_flags fl ON fl.faction_id = r.target_id AND fl.status = 'active' AND fl.kind = 'outpost'
                WHERE r.id > ?
                GROUP BY r.id
                ORDER BY r.id ASC
                LIMIT 10
            ]], { lastRaidId })

            for _, r in ipairs(raids) do
                local rid = tonumber(r.id) or lastRaidId
                if rid > lastRaidId then lastRaidId = rid end
                local durationMin = math.max(1, math.floor(((tonumber(r.ends_at) or 0) - (tonumber(r.declared_at) or 0)) / 60))
                SendEvent('base_raid', {
                    targetFaction   = r.target_label or r.target_id,
                    attackerFaction = r.attacker_label or r.attacker_id,
                    sector          = ('Declared Faction Raid (%d min window)'):format(durationMin),
                    breachMethod    = 'Official Raid Declaration (bs_building)',
                    coords          = formatCoords(r.flag_x, r.flag_y)
                })
            end
        end

        -- [E] Poll bs_transactions for BS19 Offline Vending Crate purchases
        if isHookEnabled('vending_sale') and resourceStarted('bs_building') then
            local sales = safeQuery([[
                SELECT t.id, t.character_id, t.amount, t.reason,
                       CONCAT(cb.first_name, ' ', cb.last_name) AS buyer_name
                FROM bs_transactions t
                LEFT JOIN bs_characters cb ON cb.id = t.character_id
                WHERE t.id > ? AND t.reason LIKE 'build_vend_buy_%'
                ORDER BY t.id ASC
                LIMIT 15
            ]], { lastVendTxId })

            for _, tx in ipairs(sales) do
                local tid = tonumber(tx.id) or lastVendTxId
                if tid > lastVendTxId then lastVendTxId = tid end

                local crateId = tonumber(tostring(tx.reason or ''):match('build_vend_buy_(%d+)'))
                local sellerName = 'Outpost Vendor'
                local crateCoords = 'Wasteland Outpost'
                local crateLabel = crateId and ('Vending Crate #' .. crateId) or 'Offline Vending Crate'

                if crateId then
                    local crateRows = safeQuery([[
                        SELECT bp.x, bp.y, bp.faction_id,
                               CONCAT(cs.first_name, ' ', cs.last_name) AS owner_name,
                               fr.label AS faction_name
                        FROM bs_build_pieces bp
                        LEFT JOIN bs_characters cs ON cs.id = bp.owner_char
                        LEFT JOIN bs_faction_registry fr ON fr.faction_id = bp.faction_id
                        WHERE bp.id = ?
                        LIMIT 1
                    ]], { crateId })
                    local cr = crateRows[1]
                    if cr then
                        sellerName = (cr.owner_name and cr.owner_name ~= ' ' and cr.owner_name)
                            or cr.faction_name
                            or sellerName
                        crateCoords = formatCoords(cr.x, cr.y)
                        if cr.faction_name then
                            crateLabel = cr.faction_name .. ' Crate #' .. crateId
                        end
                    end
                end

                SendEvent('vending_sale', {
                    itemName      = 'Vending Crate Purchase',
                    quantity      = 1,
                    price         = math.abs(tonumber(tx.amount) or 0),
                    currency      = 'Cash',
                    sellerName    = sellerName,
                    buyerName     = (tx.buyer_name and tx.buyer_name ~= ' ' and tx.buyer_name) or ('Char #' .. tostring(tx.character_id)),
                    crateLocation = crateLabel,
                    coords        = crateCoords
                })
            end
        end

        -- [F] Live Faction & Rank Discord Role Sync Watcher (runs every 3rd poll cycle)
        if roleSyncTick % 3 == 0 and Config.VerifySystem and Config.VerifySystem.AutoSyncRoles and isHookEnabled('role_sync') then
            local currentRows = safeQuery([[
                SELECT m.character_id, m.faction_id, m.rank,
                       r.label AS faction_label, r.short AS faction_short,
                       COALESCE(rk.label, m.rank) AS rank_label,
                       CONCAT(c.first_name, ' ', c.last_name) AS char_name,
                       u.discord, u.identifier
                FROM bs_faction_members m
                JOIN bs_characters c ON c.id = m.character_id
                JOIN bs_users u ON u.id = c.user_id
                LEFT JOIN bs_faction_registry r ON r.faction_id = m.faction_id
                LEFT JOIN bs_faction_ranks rk ON rk.faction_id = m.faction_id AND rk.rank_id = m.rank
            ]])

            local seenNow = {}
            for _, row in ipairs(currentRows) do
                local cid = tonumber(row.character_id)
                local sig = ('%s:%s'):format(tostring(row.faction_id or ''), tostring(row.rank or 'member'))
                seenNow[cid] = sig
                if memberSnapshot[cid] ~= sig then
                    memberSnapshot[cid] = sig
                    SendEvent('role_sync', {
                        charId       = cid,
                        charName     = row.char_name,
                        discord      = row.discord or '',
                        license      = row.identifier or '',
                        factionId    = row.faction_id,
                        factionLabel = row.faction_label or row.faction_id,
                        factionShort = row.faction_short or '',
                        factionRank  = row.rank or 'member',
                        rankLabel    = row.rank_label or row.rank or 'member'
                    })
                end
            end

            -- Detect members who left or were kicked from a faction -> strip stale Discord faction/rank roles
            for cid, oldSig in pairs(memberSnapshot) do
                if not seenNow[cid] then
                    memberSnapshot[cid] = nil
                    local uRows = safeQuery([[
                        SELECT CONCAT(c.first_name, ' ', c.last_name) AS char_name, u.discord, u.identifier
                        FROM bs_characters c
                        JOIN bs_users u ON u.id = c.user_id
                        WHERE c.id = ?
                        LIMIT 1
                    ]], { cid })
                    local u = uRows[1]
                    if u then
                        SendEvent('role_sync', {
                            charId       = cid,
                            charName     = u.char_name,
                            discord      = u.discord or '',
                            license      = u.identifier or '',
                            factionId    = nil,
                            factionLabel = nil,
                            factionRank  = nil,
                            rankLabel    = nil
                        })
                    end
                end
            end
        end
    end
end)

-- ============================================================================
-- SERVER CONSOLE / ADMIN DIAGNOSTIC COMMAND: testdispatch [eventType]
-- ============================================================================

local SAMPLE_PAYLOADS = {
    test_dispatch = {
        message = 'Live connectivity verification triggered from FiveM server console.',
        onlinePlayers = 0,
        bridgeVersion = '1.2.0 (BS19 Auto-Watch + Verify/RoleSync)'
    },
    dark_zone_shift = {
        previousSector = 'Cypress Flats',
        activeSector = 'Palmer-Taylor Industrial Zone',
        radiationLevel = 'Contaminated PvP Zone',
        coords = 'X: 2742.0, Y: 1518.4',
        nextShiftMinutes = 240,
        lootMultiplier = 'Contaminated Tier III Crates'
    },
    military_convoy = {
        callsign = 'BS19-CONVOY-#7',
        route = 'Fort Zancudo -> Route 68 -> Grand Senora Desert',
        escortCount = 4,
        cargoType = 'Locked Military Crates (Lockpick / Crowbar)',
        coords = 'X: -412.8, Y: 2941.2'
    },
    airdrop = {
        dropZone = 'Sandy Shores Airfield',
        crateTier = 'BS19 Supply Drop Crate (Open PvP)',
        coords = 'X: 1742.5, Y: 3265.1',
        unlockSeconds = 180,
        flareColor = 'Red Signal Flare'
    },
    power_station = {
        status = 'ONLINE',
        gridLoadPercent = 100,
        controllingFaction = 'Iron Vanguard',
        affectedZones = 'Downtown Power Grid & Illuminated Safe Zones'
    },
    base_raid = {
        targetFaction = 'Rustline Syndicate',
        attackerFaction = 'Ashfall Marauders',
        sector = 'Declared Faction Raid (60 min window)',
        breachMethod = 'Official Raid Declaration (bs_building)',
        coords = 'X: 1968.4, Y: 4632.9'
    },
    vending_sale = {
        itemName = 'M4A1 Tactical Receiver',
        quantity = 1,
        price = 18500,
        currency = 'Cash',
        sellerName = 'Vektor_99',
        buyerName = 'Kestrel',
        crateLocation = 'Paleto Outpost Crate #104',
        coords = 'X: -244.1, Y: 6228.5'
    }
}

RegisterCommand('testdispatch', function(source, args)
    if source ~= 0 and not IsPlayerAceAllowed(source, 'command.testdispatch') then
        TriggerClientEvent('chat:addMessage', source, {
            color = { 220, 38, 38 },
            args = { 'BS19 - Companion', 'Insufficient permissions to execute /testdispatch.' }
        })
        return
    end

    local requestedType = (args[1] and args[1]:lower()) or 'test_dispatch'
    local sample = SAMPLE_PAYLOADS[requestedType]
    if not sample then
        print(('^3[%s] Unknown test event "%s". Available: test_dispatch, dark_zone_shift, military_convoy, airdrop, power_station, base_raid, vending_sale^7'):format(
            RESOURCE_NAME, requestedType
        ))
        return
    end

    local payloadCopy = {}
    for k, v in pairs(sample) do
        payloadCopy[k] = v
    end

    if requestedType == 'test_dispatch' then
        payloadCopy.onlinePlayers = #GetPlayers()
    end

    local queued = SendEvent(requestedType, payloadCopy)
    if queued then
        print(('^2[%s] Sent "%s" test webhook to %s^7'):format(RESOURCE_NAME, requestedType, Config.WebhookUrl))
    end
end, false)

AddEventHandler('onResourceStart', function(startedResource)
    if startedResource ~= RESOURCE_NAME then return end
    print(('^2[%s] BS19 - Companion (Developed by Trident40) initialized for "%s" -> %s (AutoWatch=%s | Verify=%s)^7'):format(
        RESOURCE_NAME,
        Config.ServerName or 'BeyondSurvival (BS19)',
        Config.WebhookUrl,
        tostring(Config.AutoWatch),
        tostring(Config.VerifySystem and Config.VerifySystem.Enabled)
    ))
end)
