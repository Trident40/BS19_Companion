require('dotenv').config();

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const mysql = require('mysql2/promise');
const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  MessageFlags,
  ModalBuilder,
  PermissionFlagsBits,
  TextInputBuilder,
  TextInputStyle,
} = require('discord.js');

// =============================================================================
// 1. ENVIRONMENT VALIDATION & ROLE SYNC SETTINGS
// =============================================================================
const {
  DISCORD_TOKEN,
  GUILD_ID,
  DISPATCH_CHANNEL_ID,
  MARKET_CHANNEL_ID,
  VERIFY_CHANNEL_ID = '',
  AUTO_POST_VERIFY_PANEL = 'true',
  WEBHOOK_PORT = '3045',
  API_SECRET,
  VERIFIED_ROLE_ID = '',
  AUTO_CREATE_ROLES = 'true',
  FACTION_ROLE_PREFIX = 'Faction: ',
  RANK_ROLE_PREFIX = 'Rank: ',
  SYNC_NICKNAME = 'true',
  NICKNAME_FORMAT = '{name} | {faction} | {rank}',
  FACTION_ROLES_JSON = '{}',
  RANK_ROLES_JSON = '{}',
  ALLOW_DB_WRITE = 'false',
  DB_HOST = '127.0.0.1',
  DB_PORT = '3306',
  DB_USER,
  DB_PASS,
  DB_NAME = 'bs19',
} = process.env;

if (!DISCORD_TOKEN || !DISPATCH_CHANNEL_ID || !API_SECRET) {
  console.error('[BS19 - Companion] Missing required env vars: DISCORD_TOKEN, DISPATCH_CHANNEL_ID, or API_SECRET.');
  process.exit(1);
}

const ROLE_CONFIG = {
  verifyChannelId: VERIFY_CHANNEL_ID.trim(),
  autoPostVerifyPanel: AUTO_POST_VERIFY_PANEL.toLowerCase() !== 'false',
  verifiedRoleId: VERIFIED_ROLE_ID.trim(),
  autoCreate: AUTO_CREATE_ROLES.toLowerCase() !== 'false',
  factionPrefix: FACTION_ROLE_PREFIX,
  rankPrefix: RANK_ROLE_PREFIX,
  syncNickname: SYNC_NICKNAME.toLowerCase() !== 'false',
  nicknameFormat: NICKNAME_FORMAT || '{name} | {faction} | {rank}',
  allowDbWrite: ALLOW_DB_WRITE.toLowerCase() === 'true',
  factionMap: (() => { try { return JSON.parse(FACTION_ROLES_JSON || '{}'); } catch { return {}; } })(),
  rankMap: (() => { try { return JSON.parse(RANK_ROLES_JSON || '{}'); } catch { return {}; } })(),
};

// =============================================================================
// 2. ARCAINEX/BS19 NATIVE MYSQL SCHEMA MAPPING
// =============================================================================
const SCHEMA = {
  characters: 'bs_characters',
  zombieKills: 'bs_zombie_kills',
  dzProgress: 'bs_dz_progress',
  dzState: 'bs_dz_state',
  dzZones: 'bs_dz_zones',
  passProgress: 'bs_pass_progress',
  opsState: 'bs_ops_state',
  factions: 'bs_faction_registry',
  factionBanks: 'bs_faction_banks',
  factionMembers: 'bs_faction_members',
  factionRanks: 'bs_faction_ranks',
  factionFlags: 'bs_faction_flags',
  buildPieces: 'bs_build_pieces',
  inventories: 'bs_inventories',
  inventoryItems: 'bs_inventory_items',
  itemDefs: 'bs_item_definitions',
  users: 'bs_users',
};

const dbPool = mysql.createPool({
  host: DB_HOST,
  port: Number(DB_PORT) || 3306,
  user: DB_USER,
  password: DB_PASS,
  database: DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  connectTimeout: 8000,
});

// =============================================================================
// 3. LOCAL LINK STORE & PENDING VERIFICATION CODES
// Works seamlessly even when MySQL credentials are strictly read-only.
// =============================================================================
const LINKS_FILE = path.join(__dirname, 'linked-accounts.json');
const VERIFY_PANEL_FILE = path.join(__dirname, 'verify-panel.json');
const pendingVerifyCodes = new Map(); // code -> { code, expiresAt, license, charId, charName, ... }

function loadJsonFile(filePath) {
  try {
    if (!fs.existsSync(filePath)) return {};
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) || {};
  } catch {
    return {};
  }
}

function saveJsonFile(filePath, data) {
  try {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
  } catch (err) {
    console.error(`[BS19 - Companion] Failed writing ${path.basename(filePath)}:`, err.message);
  }
}

const linkedAccounts = loadJsonFile(LINKS_FILE); // { [discordUserId]: { charId, charName, license, linkedAt } }
const saveLinkedAccounts = (store) => saveJsonFile(LINKS_FILE, store);

function findDiscordIdByCharOrLicense(charId, license, discordTag) {
  if (discordTag && typeof discordTag === 'string') {
    const clean = discordTag.replace(/^discord:/i, '').trim();
    if (/^\d{17,20}$/.test(clean)) return clean;
  }
  for (const [discordId, entry] of Object.entries(linkedAccounts)) {
    if (charId && Number(entry.charId) === Number(charId)) return discordId;
    if (license && entry.license && entry.license === license) return discordId;
  }
  return null;
}

// =============================================================================
// 4. DISCORD ROLE SYNC ENGINE (Verified + Faction + Rank Roles)
// =============================================================================
const RANK_COLORS = {
  owner: 0xd97706,   // Amber Gold
  officer: 0x2563eb, // Tactical Blue
  member: 0x64748b,  // Iron Slate
};

function formatRankTitle(rankKey, rankLabel) {
  const raw = String(rankLabel || rankKey || 'Member').trim();
  if (raw.toLowerCase() === 'owner') return 'Leader';
  return raw.charAt(0).toUpperCase() + raw.slice(1);
}

function formatSurvivorNickname(profile, member) {
  const baseName = String(profile.charName || member.user.globalName || member.user.username || 'Survivor').trim();
  if (!profile.factionId || !profile.factionLabel) {
    return baseName.slice(0, 32).trim();
  }

  const rankTitle = formatRankTitle(profile.factionRank, profile.rankLabel);
  const fullFac = String(profile.factionLabel).trim();
  const shortFac = String(profile.factionShort || fullFac).trim();

  const render = (facVal) =>
    ROLE_CONFIG.nicknameFormat
      .replace(/\{name\}/gi, baseName)
      .replace(/\{faction\}/gi, facVal)
      .replace(/\{short\}/gi, shortFac)
      .replace(/\{rank\}/gi, rankTitle)
      .replace(/\s+/g, ' ')
      .trim();

  const fullAttempt = render(fullFac);
  if (fullAttempt.length <= 32) return fullAttempt;

  const shortAttempt = render(shortFac);
  if (shortAttempt.length <= 32) return shortAttempt;

  return shortAttempt.slice(0, 32).trim();
}

async function resolveOrCreateRole(guild, explicitRoleId, roleName, colorHex) {
  if (explicitRoleId) {
    const byId = guild.roles.cache.get(explicitRoleId) || (await guild.roles.fetch(explicitRoleId).catch(() => null));
    if (byId) return byId;
  }

  const normalized = roleName.toLowerCase();
  const existing = guild.roles.cache.find((r) => r.name.toLowerCase() === normalized);
  if (existing) return existing;

  if (!ROLE_CONFIG.autoCreate) return null;

  return guild.roles.create({
    name: roleName,
    color: colorHex,
    reason: 'BS19 - Companion (by Trident40) automatic Faction/Rank role sync',
  });
}

async function syncMemberFactionRoles(guild, discordUserId, profile) {
  const member = await guild.members.fetch(discordUserId).catch(() => null);
  if (!member) {
    return { ok: false, error: 'Member not found in Discord server.' };
  }

  const botMember = guild.members.me;
  if (!botMember || !botMember.permissions.has('ManageRoles')) {
    return {
      ok: false,
      error: 'Bot is missing the "Manage Roles" permission in Discord Server Settings.',
    };
  }

  const assigned = [];
  const removed = [];

  // 1. Verified Survivor role
  const verifiedRole = await resolveOrCreateRole(
    guild,
    ROLE_CONFIG.verifiedRoleId || null,
    'Verified Survivor',
    0x16a34a
  );
  if (verifiedRole && verifiedRole.editable && !member.roles.cache.has(verifiedRole.id)) {
    await member.roles.add(verifiedRole, 'BS19 Account Verified');
    assigned.push(verifiedRole.name);
  } else if (verifiedRole && member.roles.cache.has(verifiedRole.id)) {
    assigned.push(verifiedRole.name);
  }

  // 2. Determine target Faction role & Rank role
  let targetFactionRole = null;
  let targetRankRole = null;

  if (profile.factionId && profile.factionLabel) {
    const mappedFacId = ROLE_CONFIG.factionMap[profile.factionId] || null;
    const facRoleName = `${ROLE_CONFIG.factionPrefix}${profile.factionLabel}`.slice(0, 100);
    targetFactionRole = await resolveOrCreateRole(guild, mappedFacId, facRoleName, 0xd97706);

    const rankKey = String(profile.factionRank || 'member').toLowerCase();
    const mappedRankId = ROLE_CONFIG.rankMap[rankKey] || null;
    const niceRank = formatRankTitle(rankKey, profile.rankLabel);
    const rankRoleName = `${ROLE_CONFIG.rankPrefix}${niceRank}`.slice(0, 100);
    targetRankRole = await resolveOrCreateRole(
      guild,
      mappedRankId,
      rankRoleName,
      RANK_COLORS[rankKey] || 0x64748b
    );
  }

  // 3. Remove stale BS19 Faction & Rank roles no longer matching the survivor
  const keepIds = new Set([
    verifiedRole?.id,
    targetFactionRole?.id,
    targetRankRole?.id,
  ].filter(Boolean));

  for (const role of member.roles.cache.values()) {
    const isManagedFaction = ROLE_CONFIG.factionPrefix && role.name.startsWith(ROLE_CONFIG.factionPrefix);
    const isManagedRank = ROLE_CONFIG.rankPrefix && role.name.startsWith(ROLE_CONFIG.rankPrefix);
    if ((isManagedFaction || isManagedRank) && !keepIds.has(role.id) && role.editable) {
      await member.roles.remove(role, 'BS19 Faction/Rank updated');
      removed.push(role.name);
    }
  }

  // 4. Add current Faction & Rank roles
  for (const role of [targetFactionRole, targetRankRole]) {
    if (!role) continue;
    if (!role.editable) {
      return {
        ok: false,
        error: `Cannot assign role "${role.name}" — drag the bot's role ABOVE "${role.name}" in Server Settings -> Roles.`,
      };
    }
    if (!member.roles.cache.has(role.id)) {
      await member.roles.add(role, 'BS19 Faction/Rank role sync');
    }
    assigned.push(role.name);
  }

  // 5. Sync Discord Server Nickname (e.g. "USERNAME | Faction | Rank", max 32 chars)
  let nickname = null;
  let nicknameNote = 'Disabled';

  if (ROLE_CONFIG.syncNickname) {
    const desiredNick = formatSurvivorNickname(profile, member);
    if (member.id === guild.ownerId) {
      nicknameNote = 'Skipped (Discord blocks bots from renaming the Server Owner)';
    } else if (!botMember.permissions.has('ManageNicknames')) {
      nicknameNote = 'Skipped (Bot missing "Manage Nicknames" permission)';
    } else if (!member.manageable) {
      nicknameNote = 'Skipped (Drag bot role above this member in Server Settings -> Roles)';
    } else {
      try {
        if (member.nickname !== desiredNick) {
          await member.setNickname(desiredNick, 'BS19 Survivor/Faction/Rank nickname sync');
        }
        nickname = desiredNick;
        nicknameNote = desiredNick;
      } catch (err) {
        console.warn('[BS19 NickSync] Failed setting nickname:', err.message);
        nicknameNote = `Failed (${err.message})`;
      }
    }
  }

  return { ok: true, assigned, removed, nickname, nicknameNote };
}

async function fetchSurvivorFactionProfile(discordUserId) {
  const localLink = linkedAccounts[discordUserId];
  const discordTag = `discord:${discordUserId}`;

  // Lookup by local verified charId first, otherwise by native bs_users.discord
  let rows = [];
  if (localLink && localLink.charId) {
    [rows] = await dbPool.execute(
      `
      SELECT c.id AS char_id, CONCAT(c.first_name, ' ', c.last_name) AS char_name,
             c.level, u.identifier,
             m.faction_id, m.rank AS faction_rank,
             r.label AS faction_label, r.short AS faction_short,
             COALESCE(rk.label, m.rank) AS rank_label
      FROM ${SCHEMA.characters} c
      JOIN ${SCHEMA.users} u ON u.id = c.user_id
      LEFT JOIN ${SCHEMA.factionMembers} m ON m.character_id = c.id
      LEFT JOIN ${SCHEMA.factions} r ON r.faction_id = m.faction_id
      LEFT JOIN ${SCHEMA.factionRanks} rk ON rk.faction_id = m.faction_id AND rk.rank_id = m.rank
      WHERE c.id = ? AND c.deleted_at IS NULL
      LIMIT 1
      `,
      [localLink.charId]
    );
  }

  if (!rows.length) {
    [rows] = await dbPool.execute(
      `
      SELECT c.id AS char_id, CONCAT(c.first_name, ' ', c.last_name) AS char_name,
             c.level, u.identifier,
             m.faction_id, m.rank AS faction_rank,
             r.label AS faction_label, r.short AS faction_short,
             COALESCE(rk.label, m.rank) AS rank_label
      FROM ${SCHEMA.users} u
      JOIN ${SCHEMA.characters} c ON c.user_id = u.id AND c.deleted_at IS NULL
      LEFT JOIN ${SCHEMA.factionMembers} m ON m.character_id = c.id
      LEFT JOIN ${SCHEMA.factions} r ON r.faction_id = m.faction_id
      LEFT JOIN ${SCHEMA.factionRanks} rk ON rk.faction_id = m.faction_id AND rk.rank_id = m.rank
      WHERE u.discord = ? OR u.discord = ?
      ORDER BY c.last_played DESC
      LIMIT 1
      `,
      [discordTag, discordUserId]
    );
  }

  if (!rows.length) return null;
  const r = rows[0];
  return {
    charId: r.char_id,
    charName: r.char_name,
    level: r.level,
    license: r.identifier,
    factionId: r.faction_id || null,
    factionLabel: r.faction_label || r.faction_id || null,
    factionShort: r.faction_short || '',
    factionRank: r.faction_rank || null,
    rankLabel: r.rank_label || r.faction_rank || null,
  };
}

// =============================================================================
// 5. CACHED WORLD STATE
// =============================================================================
const worldState = {
  darkZone: {
    activeSector: 'Awaiting rotation telemetry',
    radiationLevel: 'Contaminated PvP Zone',
    coords: 'N/A',
    nextShiftMinutes: null,
    updatedAt: null,
  },
  powerStation: {
    status: 'OFFLINE',
    gridLoadPercent: 0,
    controllingFaction: 'Unclaimed',
    affectedZones: 'Standard Grid',
    updatedAt: null,
  },
  lastConvoy: null,
  lastAirdrop: null,
};

function safeJsonParse(raw) {
  if (!raw || typeof raw !== 'string') return null;
  try { return JSON.parse(raw); } catch { return null; }
}

async function hydrateWorldStateFromDb() {
  try {
    const [dzRows] = await dbPool.execute(`SELECT v FROM ${SCHEMA.dzState} WHERE k = 'rot' LIMIT 1`);
    if (dzRows.length) {
      const rot = safeJsonParse(dzRows[0].v);
      if (rot && rot.zone) {
        let label = rot.zone;
        let coords = 'Check In-Game Map';
        const [zRows] = await dbPool.execute(`SELECT data FROM ${SCHEMA.dzZones} WHERE id = ? LIMIT 1`, [rot.zone]);
        if (zRows.length) {
          const zData = safeJsonParse(zRows[0].data);
          if (zData) {
            label = zData.label || label;
            if (Number.isFinite(Number(zData.x)) && Number.isFinite(Number(zData.y))) {
              coords = `X: ${Number(zData.x).toFixed(1)}, Y: ${Number(zData.y).toFixed(1)}`;
            }
          }
        }
        const nowSec = Math.floor(Date.now() / 1000);
        worldState.darkZone = {
          activeSector: label,
          radiationLevel: 'Contaminated PvP Zone',
          coords,
          nextShiftMinutes: rot.nextAt ? Math.max(0, Math.floor((Number(rot.nextAt) - nowSec) / 60)) : null,
          updatedAt: new Date().toISOString(),
        };
      }
    }

    const [opsRows] = await dbPool.execute(`SELECT v FROM ${SCHEMA.opsState} WHERE k = 'power' LIMIT 1`);
    if (opsRows.length) {
      const pw = safeJsonParse(opsRows[0].v);
      const nowSec = Math.floor(Date.now() / 1000);
      const live = Boolean(pw && pw.buff && Number(pw.buff.endsAt) > nowSec);
      let facName = 'Unclaimed';
      if (live && pw.buff.faction) {
        const [fRows] = await dbPool.execute(`SELECT label FROM ${SCHEMA.factions} WHERE faction_id = ? LIMIT 1`, [pw.buff.faction]);
        facName = (fRows[0] && fRows[0].label) || pw.buff.faction;
      }
      worldState.powerStation = {
        status: live ? 'ONLINE' : 'OFFLINE',
        gridLoadPercent: live ? 100 : 0,
        controllingFaction: facName,
        affectedZones: live ? 'Downtown Power Grid & Illuminated Safe Zones' : 'Standby / Cooldown',
        updatedAt: new Date().toISOString(),
      };
    }
  } catch (err) {
    console.warn('[BS19 - Companion] Optional initial DB worldState hydration skipped:', err.message);
  }
}

// =============================================================================
// 6. DISCORD CLIENT INITIALIZATION (discord.js v14)
// =============================================================================
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
});

client.once(Events.ClientReady, async (readyClient) => {
  console.log(`[BS19 - Companion] Developed by Trident40 — Logged in as ${readyClient.user.tag}`);
  await hydrateWorldStateFromDb();
  if (ROLE_CONFIG.autoPostVerifyPanel && ROLE_CONFIG.verifyChannelId) {
    await ensureVerifyPanelPosted(ROLE_CONFIG.verifyChannelId).catch((err) =>
      console.warn('[BS19 - Companion] Verify panel auto-post skipped:', err.message)
    );
  }
});

// =============================================================================
// 7. EMBED BUILDERS FOR FIVEM WEBHOOK EVENTS
// =============================================================================
const EVENT_COLORS = {
  dark_zone_shift: 0xd97706,
  military_convoy: 0xb91c1c,
  airdrop: 0x2563eb,
  power_station: 0x16a34a,
  base_raid: 0xdc2626,
  vending_sale: 0x0d9488,
  test_dispatch: 0x64748b,
};

function safeStr(val, fallback = 'Unknown') {
  if (val === undefined || val === null || val === '') return fallback;
  return String(val).slice(0, 256);
}

function formatNumber(val) {
  const num = Number(val);
  return Number.isFinite(num) ? num.toLocaleString('en-US') : '0';
}

function buildEventEmbed(eventType, serverName, payload = {}) {
  const footerText = `${safeStr(serverName, 'BeyondSurvival (BS19)')} • BS19 - Companion • Developed by Trident40`;
  const embed = new EmbedBuilder().setTimestamp();

  switch (eventType) {
    case 'dark_zone_shift': {
      worldState.darkZone = {
        activeSector: safeStr(payload.activeSector, 'Unknown Sector'),
        radiationLevel: safeStr(payload.radiationLevel, 'Contaminated PvP Zone'),
        coords: safeStr(payload.coords, 'Uncharted'),
        nextShiftMinutes: Number(payload.nextShiftMinutes) || 240,
        updatedAt: new Date().toISOString(),
      };

      return embed
        .setColor(EVENT_COLORS.dark_zone_shift)
        .setTitle('Dark Zone Rotation Alert')
        .setDescription(
          `Radiation storm telemetry has shifted to **${worldState.darkZone.activeSector}**. Contaminated loot and extraction zones are now active.`
        )
        .addFields(
          { name: 'Active Sector', value: worldState.darkZone.activeSector, inline: true },
          { name: 'Radiation Index', value: worldState.darkZone.radiationLevel, inline: true },
          { name: 'Grid Coordinates', value: `\`${worldState.darkZone.coords}\``, inline: true },
          { name: 'Previous Sector', value: safeStr(payload.previousSector, 'N/A'), inline: true },
          { name: 'Loot Modifier', value: safeStr(payload.lootMultiplier, 'Tier III Crates'), inline: true },
          { name: 'Next Rotation', value: `${worldState.darkZone.nextShiftMinutes} min`, inline: true }
        )
        .setFooter({ text: footerText });
    }

    case 'military_convoy': {
      const route = safeStr(payload.route, 'Active Highway Corridor');
      worldState.lastConvoy = `${safeStr(payload.callsign, 'CONVOY')} (${route})`;

      return embed
        .setColor(EVENT_COLORS.military_convoy)
        .setTitle('Military Convoy Sighted')
        .setDescription(
          `Reconnaissance detected armored transport **${safeStr(payload.callsign, 'BS19-CONVOY')}** moving across the wasteland.`
        )
        .addFields(
          { name: 'Route', value: route, inline: false },
          { name: 'Cargo Manifest', value: safeStr(payload.cargoType, 'Locked Military Crates'), inline: true },
          { name: 'Escort Strength', value: `${formatNumber(payload.escortCount || 4)} Units`, inline: true },
          { name: 'Last Known Grid', value: `\`${safeStr(payload.coords, 'Moving Target')}\``, inline: true }
        )
        .setFooter({ text: footerText });
    }

    case 'airdrop': {
      const zone = safeStr(payload.dropZone, 'Wasteland Sector');
      worldState.lastAirdrop = `${zone} (${safeStr(payload.crateTier, 'Supply Crate')})`;

      return embed
        .setColor(EVENT_COLORS.airdrop)
        .setTitle('Supply Airdrop Inbound')
        .setDescription(
          `Cargo aircraft released a supply crate over **${zone}**. Watch for red signal smoke and hostile scavengers.`
        )
        .addFields(
          { name: 'Drop Zone', value: zone, inline: true },
          { name: 'Crate Classification', value: safeStr(payload.crateTier, 'BS19 Supply Crate'), inline: true },
          { name: 'Coordinates', value: `\`${safeStr(payload.coords, 'Follow Signal Flare')}\``, inline: true },
          { name: 'Unlock Timer', value: `${formatNumber(payload.unlockSeconds || 180)}s`, inline: true },
          { name: 'Signal Marker', value: safeStr(payload.flareColor, 'Red Signal Flare'), inline: true }
        )
        .setFooter({ text: footerText });
    }

    case 'power_station': {
      const status = safeStr(payload.status, 'OFFLINE').toUpperCase();
      const statusColor =
        status === 'ONLINE' ? 0x16a34a : status === 'OVERLOADED' || status === 'CONTESTED' ? 0xd97706 : 0xdc2626;

      worldState.powerStation = {
        status,
        gridLoadPercent: Number.isFinite(Number(payload.gridLoadPercent)) ? Number(payload.gridLoadPercent) : 0,
        controllingFaction: safeStr(payload.controllingFaction, 'Unclaimed'),
        affectedZones: safeStr(payload.affectedZones, 'Regional Grid'),
        updatedAt: new Date().toISOString(),
      };

      return embed
        .setColor(statusColor)
        .setTitle(`Power Station Status: ${status}`)
        .setDescription(
          `Downtown Power Station telemetry changed to **${status}**. Grid-dependent safe zones and XP buffs updated.`
        )
        .addFields(
          { name: 'Grid State', value: status, inline: true },
          { name: 'Output Load', value: `${worldState.powerStation.gridLoadPercent}%`, inline: true },
          { name: 'Controlling Faction', value: worldState.powerStation.controllingFaction, inline: true },
          { name: 'Affected Sectors', value: worldState.powerStation.affectedZones, inline: false }
        )
        .setFooter({ text: footerText });
    }

    case 'base_raid': {
      return embed
        .setColor(EVENT_COLORS.base_raid)
        .setTitle('Base Raid Alert')
        .setDescription(`Hostile raid activity detected targeting **${safeStr(payload.targetFaction, 'Faction Base')}**.`)
        .addFields(
          { name: 'Defending Faction', value: safeStr(payload.targetFaction, 'Unknown'), inline: true },
          { name: 'Aggressor', value: safeStr(payload.attackerFaction, 'Unknown Hostiles'), inline: true },
          { name: 'Breach Type', value: safeStr(payload.breachMethod, 'Raid Declared'), inline: true },
          { name: 'Compound / Window', value: safeStr(payload.sector, 'Outpost'), inline: true },
          { name: 'Coordinates', value: `\`${safeStr(payload.coords, 'Uncharted')}\``, inline: true }
        )
        .setFooter({ text: footerText });
    }

    case 'vending_sale': {
      const qty = formatNumber(payload.quantity || 1);
      const price = formatNumber(payload.price || 0);
      const currency = safeStr(payload.currency, 'Cash');

      return embed
        .setColor(EVENT_COLORS.vending_sale)
        .setTitle('Offline Vending Crate Sale')
        .setDescription(
          `**${safeStr(payload.buyerName, 'Survivor')}** completed an offline vending purchase (**${qty}x ${safeStr(payload.itemName, 'Crate Item')}**).`
        )
        .addFields(
          { name: 'Item / Order', value: safeStr(payload.itemName, 'Crate Purchase'), inline: true },
          { name: 'Sale Value', value: `${price} ${currency}`, inline: true },
          { name: 'Seller', value: safeStr(payload.sellerName, 'Outpost Vendor'), inline: true },
          { name: 'Crate Outpost', value: safeStr(payload.crateLocation, 'Wasteland Market'), inline: true },
          { name: 'Coordinates', value: `\`${safeStr(payload.coords, 'N/A')}\``, inline: true }
        )
        .setFooter({ text: footerText });
    }

    default: {
      return embed
        .setColor(EVENT_COLORS.test_dispatch)
        .setTitle('BS19 - Companion Connectivity Verified')
        .setDescription(safeStr(payload.message, 'Webhook bridge test succeeded.'))
        .addFields(
          { name: 'Event Key', value: `\`${safeStr(eventType)}\``, inline: true },
          { name: 'Online Survivors', value: formatNumber(payload.onlinePlayers || 0), inline: true },
          { name: 'Bridge Version', value: safeStr(payload.bridgeVersion, '1.2.0'), inline: true }
        )
        .setFooter({ text: footerText });
    }
  }
}

// =============================================================================
// 8. SLASH COMMAND HANDLERS (/verify, /sync-roles, /link, /survivor, etc.)
// =============================================================================
function formatPlaytime(totalSeconds) {
  const mins = Math.floor(Math.max(0, Number(totalSeconds) || 0) / 60);
  const days = Math.floor(mins / 1440);
  const hours = Math.floor((mins % 1440) / 60);
  const rem = mins % 60;
  return days > 0 ? `${days}d ${hours}h ${rem}m` : `${hours}h ${rem}m`;
}

// =============================================================================
// 8B. PERMANENT INTERACTIVE VERIFY PANEL (#verify EMBED + BUTTONS + MODAL)
// =============================================================================
function buildVerifyPanelPayload() {
  const embed = new EmbedBuilder()
    .setColor(0xd97706)
    .setTitle('BS19 - Companion — Survivor Verification & Faction Sync')
    .setDescription(
      'Link your **BeyondSurvival (BS19)** FiveM survivor account to Discord to unlock survivor channels and keep your **Faction** and **Rank** roles synced automatically in real time.'
    )
    .addFields(
      {
        name: 'Option 1 — One-Click Auto-Verify (Fastest)',
        value:
          'If Discord was running when you joined FiveM, click **One-Click Auto-Verify** below. The bot automatically matches your BS19 account via `bs_users` and assigns your roles immediately.',
        inline: false,
      },
      {
        name: 'Option 2 — Verify with In-Game Code',
        value:
          '1. Join the FiveM server and load into your survivor.\n' +
          '2. Type `/verify` in FiveM chat to receive a 6-character code (valid for 10 minutes).\n' +
          '3. Click **Verify with Code** below and enter your code in the popup.',
        inline: false,
      },
      {
        name: 'Roles & Nickname Automatically Synced',
        value:
          '• **Verified Survivor** access role\n' +
          `• **${ROLE_CONFIG.factionPrefix}<Your Faction>** & **${ROLE_CONFIG.rankPrefix}<Leader / Officer / Member>**\n` +
          `• **Discord Nickname:** \`${ROLE_CONFIG.nicknameFormat}\` (auto-fits Discord's 32-char limit)\n` +
          'Promotions, demotions, faction transfers, and leaves sync automatically — or click **Refresh Faction & Rank Roles** anytime.',
        inline: false,
      },
      {
        name: 'Useful BS19 Survivor Commands',
        value:
          '`/survivor [name]` — Check playtime, infected/PvP kills & Wasteland Pass tier\n' +
          '`/faction-status [faction]` — Inspect treasury balance, territory flags & members\n' +
          '`/market [item]` — Search active offline vending crates with prices & GPS coords\n' +
          '`/world-status` — View live Power Station state & active Dark Zone sector\n' +
          '`/sync-roles` — Manually refresh your Faction & Rank Discord roles\n' +
          '`/link` — View your currently linked BS19 survivor character',
        inline: false,
      },
      {
        name: 'Troubleshooting & Account Safety',
        value:
          '• **Code expired?** Codes last 10 minutes — run `/verify` in-game again for a fresh code.\n' +
          '• **Auto-Verify did not find you?** Use Option 2 with an in-game `/verify` code.\n' +
          '• **Security:** Staff and this bot will **never** ask for your password or token.',
        inline: false,
      }
    )
    .setFooter({ text: 'BS19 - Companion • Permanent Verification Panel • Developed by Trident40' });

  const actionRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('bs19_verify_code_btn')
      .setLabel('Verify with Code')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId('bs19_verify_auto_btn')
      .setLabel('One-Click Auto-Verify')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId('bs19_sync_roles_btn')
      .setLabel('Refresh Faction & Rank Roles')
      .setStyle(ButtonStyle.Secondary)
  );

  return { embeds: [embed], components: [actionRow] };
}

async function ensureVerifyPanelPosted(channelId) {
  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel || !channel.isTextBased()) {
    throw new Error(`Channel ${channelId} is unavailable or missing View/Send permissions.`);
  }

  const panelPayload = buildVerifyPanelPayload();
  const state = loadJsonFile(VERIFY_PANEL_FILE);

  // If we already posted a panel in this channel, edit it in-place (zero duplicates!)
  if (state.channelId === channelId && state.messageId) {
    const existing = await channel.messages.fetch(state.messageId).catch(() => null);
    if (existing) {
      await existing.edit(panelPayload);
      console.log(`[BS19 VerifyPanel] Refreshed existing permanent panel in #${channel.name || channelId}`);
      return { action: 'updated', channelId, messageId: existing.id };
    }
  }

  const sent = await channel.send(panelPayload);
  saveJsonFile(VERIFY_PANEL_FILE, { channelId, messageId: sent.id, updatedAt: new Date().toISOString() });
  console.log(`[BS19 VerifyPanel] Posted permanent verify panel in #${channel.name || channelId}`);
  return { action: 'created', channelId, messageId: sent.id };
}

async function executeVerifyFlow(interaction, inputCodeRaw) {
  const inputCode = inputCodeRaw ? String(inputCodeRaw).trim().toUpperCase() : '';
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  let profile = null;

  if (inputCode) {
    const pending = pendingVerifyCodes.get(inputCode);
    const nowSec = Math.floor(Date.now() / 1000);
    if (!pending || pending.expiresAt < nowSec) {
      pendingVerifyCodes.delete(inputCode);
      return interaction.editReply(
        `Code \`${inputCode}\` is invalid or expired. Run \`/verify\` in-game on the FiveM server to generate a fresh code.`
      );
    }

    pendingVerifyCodes.delete(inputCode);
    profile = pending;

    linkedAccounts[interaction.user.id] = {
      charId: pending.charId,
      charName: pending.charName,
      license: pending.license,
      linkedAt: new Date().toISOString(),
    };
    saveLinkedAccounts(linkedAccounts);

    if (ROLE_CONFIG.allowDbWrite && pending.license) {
      await dbPool
        .execute(`UPDATE ${SCHEMA.users} SET discord = ? WHERE identifier = ?`, [
          `discord:${interaction.user.id}`,
          pending.license,
        ])
        .catch((err) => console.warn('[BS19 Verify] Optional bs_users write skipped:', err.message));
    }
  } else {
    profile = await fetchSurvivorFactionProfile(interaction.user.id);
    if (!profile) {
      return interaction.editReply(
        'We could not auto-detect your Discord ID in BS19 yet. Join the FiveM server, type `/verify` in-game chat, and click **Verify with Code** (or run `/verify code:XXXXXX`)!'
      );
    }

    linkedAccounts[interaction.user.id] = {
      charId: profile.charId,
      charName: profile.charName,
      license: profile.license,
      linkedAt: new Date().toISOString(),
    };
    saveLinkedAccounts(linkedAccounts);
  }

  const syncResult = await syncMemberFactionRoles(interaction.guild, interaction.user.id, profile);
  if (!syncResult.ok) {
    return interaction.editReply(`Account verified for **${profile.charName}**, but role sync failed: ${syncResult.error}`);
  }

  const embed = new EmbedBuilder()
    .setColor(0x16a34a)
    .setTitle('Survivor Verified & Roles Synced')
    .setDescription(`Linked <@${interaction.user.id}> to **${safeStr(profile.charName)}** (\`#${profile.charId}\`).`)
    .addFields(
      { name: 'Faction', value: profile.factionLabel ? safeStr(profile.factionLabel) : 'Unaffiliated', inline: true },
      { name: 'Rank', value: profile.factionRank ? formatRankTitle(profile.factionRank, profile.rankLabel) : 'None', inline: true },
      { name: 'Discord Nickname', value: syncResult.nickname ? `\`${syncResult.nickname}\`` : syncResult.nicknameNote, inline: true },
      { name: 'Active Discord Roles', value: syncResult.assigned.length ? syncResult.assigned.join(', ') : 'None', inline: false }
    )
    .setFooter({ text: 'BS19 - Companion • Developed by Trident40' })
    .setTimestamp();

  return interaction.editReply({ embeds: [embed] });
}

async function handleVerifyCommand(interaction) {
  const inputCode = interaction.options.getString('code');
  return executeVerifyFlow(interaction, inputCode);
}

async function handleSyncRolesCommand(interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const profile = await fetchSurvivorFactionProfile(interaction.user.id);
  if (!profile) {
    return interaction.editReply(
      'Your Discord account is not verified yet. Run `/verify` in-game and click **Verify with Code** in #verify (or run `/verify code:XXXXXX`).'
    );
  }

  const syncResult = await syncMemberFactionRoles(interaction.guild, interaction.user.id, profile);
  if (!syncResult.ok) {
    return interaction.editReply(`Role sync failed: ${syncResult.error}`);
  }

  const embed = new EmbedBuilder()
    .setColor(0x2563eb)
    .setTitle('Faction & Rank Roles Refreshed')
    .setDescription(`Synced live BS19 roster data for **${safeStr(profile.charName)}**.`)
    .addFields(
      { name: 'Faction', value: profile.factionLabel ? safeStr(profile.factionLabel) : 'Unaffiliated', inline: true },
      { name: 'Rank', value: profile.factionRank ? formatRankTitle(profile.factionRank, profile.rankLabel) : 'None', inline: true },
      { name: 'Discord Nickname', value: syncResult.nickname ? `\`${syncResult.nickname}\`` : syncResult.nicknameNote, inline: true },
      { name: 'Assigned Roles', value: syncResult.assigned.length ? syncResult.assigned.join(', ') : 'None', inline: false },
      { name: 'Removed Stale Roles', value: syncResult.removed.length ? syncResult.removed.join(', ') : 'None', inline: false }
    )
    .setFooter({ text: 'BS19 - Companion • Developed by Trident40' })
    .setTimestamp();

  return interaction.editReply({ embeds: [embed] });
}

async function handlePostVerifyPanelCommand(interaction) {
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
    return interaction.reply({
      content: 'Only Discord Administrators can run `/post-verify-panel`.',
      flags: MessageFlags.Ephemeral,
    });
  }

  const chosenChannel = interaction.options.getChannel('channel');
  const targetChannelId = chosenChannel ? chosenChannel.id : ROLE_CONFIG.verifyChannelId;
  if (!targetChannelId) {
    return interaction.reply({
      content: 'Provide a `channel` option or set `VERIFY_CHANNEL_ID` in your `.env` file.',
      flags: MessageFlags.Ephemeral,
    });
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const res = await ensureVerifyPanelPosted(targetChannelId);
  return interaction.editReply(
    `Permanent Verify Panel **${res.action}** in <#${res.channelId}> (Message ID: \`${res.messageId}\`).`
  );
}

async function handleSurvivorCommand(interaction) {
  const queryName = interaction.options.getString('name', true).trim();
  await interaction.deferReply();

  const sql = `
    SELECT
      c.id,
      CONCAT(c.first_name, ' ', c.last_name) AS full_name,
      c.class,
      c.level,
      c.playtime,
      (SELECT COUNT(*) FROM ${SCHEMA.zombieKills} zk WHERE zk.character_id = c.id) AS infected_kills,
      COALESCE(dz.kills, 0) AS pvp_kills,
      COALESCE(dz.extracts, 0) AS dz_extracts,
      COALESCE(pp.xp, 0) AS pass_xp,
      COALESCE(pp.season, 1) AS pass_season
    FROM ${SCHEMA.characters} c
    LEFT JOIN ${SCHEMA.dzProgress} dz ON dz.character_id = c.id
    LEFT JOIN ${SCHEMA.passProgress} pp ON pp.char_id = c.id
    WHERE c.deleted_at IS NULL
      AND (CONCAT(c.first_name, ' ', c.last_name) LIKE ? OR c.first_name LIKE ? OR c.last_name LIKE ?)
    ORDER BY c.playtime DESC
    LIMIT 1
  `;

  const like = `%${queryName}%`;
  const [rows] = await dbPool.execute(sql, [like, like, like]);
  if (!rows.length) {
    return interaction.editReply(`No BS19 survivor found matching **${queryName}**.`);
  }

  const s = rows[0];
  const passTier = Math.min(100, Math.floor((Number(s.pass_xp) || 0) / 1000) + 1);

  const embed = new EmbedBuilder()
    .setColor(0xd97706)
    .setTitle(`Survivor Dossier: ${safeStr(s.full_name)}`)
    .setDescription(`Character ID: \`#${s.id}\` · Class: **${safeStr(s.class, 'survivor')}** · Level **${formatNumber(s.level)}**`)
    .addFields(
      { name: 'Survival Time', value: formatPlaytime(s.playtime), inline: true },
      { name: 'Infected Kills', value: formatNumber(s.infected_kills), inline: true },
      { name: 'Dark Zone PvP Kills', value: formatNumber(s.pvp_kills), inline: true },
      { name: 'Wasteland Pass', value: `Tier ${passTier} (S${s.pass_season})`, inline: true },
      { name: 'DZ Extractions', value: formatNumber(s.dz_extracts), inline: true }
    )
    .setFooter({ text: 'BS19 - Companion • Developed by Trident40' })
    .setTimestamp();

  return interaction.editReply({ embeds: [embed] });
}

async function handleFactionStatusCommand(interaction) {
  const factionQuery = interaction.options.getString('faction', true).trim();
  await interaction.deferReply();

  const sql = `
    SELECT
      r.faction_id,
      r.label,
      r.short,
      COALESCE(b.balance, 0) AS treasury_balance,
      (SELECT COUNT(*) FROM ${SCHEMA.factionMembers} m WHERE m.faction_id = r.faction_id) AS member_count,
      (SELECT COUNT(*) FROM ${SCHEMA.factionFlags} f WHERE f.faction_id = r.faction_id AND f.status = 'active') AS active_flags,
      (SELECT COUNT(*) FROM ${SCHEMA.factionFlags} f WHERE f.faction_id = r.faction_id AND f.status = 'reclaiming') AS contested_flags
    FROM ${SCHEMA.factions} r
    LEFT JOIN ${SCHEMA.factionBanks} b ON b.faction_id = r.faction_id
    WHERE r.label LIKE ? OR r.short LIKE ? OR r.faction_id LIKE ?
    ORDER BY member_count DESC
    LIMIT 1
  `;

  const like = `%${factionQuery}%`;
  const [rows] = await dbPool.execute(sql, [like, like, like]);
  if (!rows.length) {
    return interaction.editReply(`No BS19 faction found matching **${factionQuery}**.`);
  }

  const f = rows[0];
  const contested = Number(f.contested_flags) > 0;
  const activeFlags = Number(f.active_flags) || 0;
  const flagState = contested ? 'CONTESTED' : activeFlags > 0 ? 'SECURED' : 'NO FLAGS';
  const embedColor = contested ? 0xdc2626 : activeFlags > 0 ? 0x16a34a : 0xd97706;

  const embed = new EmbedBuilder()
    .setColor(embedColor)
    .setTitle(`Faction Report: ${safeStr(f.label)} [${safeStr(f.short || f.faction_id)}]`)
    .addFields(
      { name: 'Treasury Balance', value: `$${formatNumber(f.treasury_balance)}`, inline: true },
      { name: 'Members', value: formatNumber(f.member_count), inline: true },
      { name: 'Territory Status', value: `${flagState} (${activeFlags} active)`, inline: true }
    )
    .setFooter({ text: 'BS19 - Companion • Developed by Trident40' })
    .setTimestamp();

  return interaction.editReply({ embeds: [embed] });
}

async function handleMarketCommand(interaction) {
  const itemQuery = interaction.options.getString('item', true).trim();
  await interaction.deferReply();

  const sql = `
    SELECT
      bp.id AS crate_id,
      bp.x AS coords_x,
      bp.y AS coords_y,
      bp.data AS crate_data,
      ii.item AS item_id,
      COALESCE(id.label, ii.item) AS item_label,
      SUM(ii.amount) AS stock,
      CONCAT(c.first_name, ' ', c.last_name) AS seller_name,
      fr.label AS faction_name
    FROM ${SCHEMA.buildPieces} bp
    INNER JOIN ${SCHEMA.inventories} inv
      ON inv.owner_type = 'container' AND inv.owner_id = CONCAT('build:', bp.id)
    INNER JOIN ${SCHEMA.inventoryItems} ii
      ON ii.inventory_id = inv.id
    LEFT JOIN ${SCHEMA.itemDefs} id
      ON id.name = ii.item
    LEFT JOIN ${SCHEMA.characters} c
      ON c.id = bp.owner_char
    LEFT JOIN ${SCHEMA.factions} fr
      ON fr.faction_id = bp.faction_id
    WHERE bp.piece = 'vending_crate'
      AND bp.built = 1
      AND ii.amount > 0
      AND (ii.item LIKE ? OR id.label LIKE ?)
    GROUP BY bp.id, ii.item
    LIMIT 25
  `;

  const like = `%${itemQuery}%`;
  const [rows] = await dbPool.execute(sql, [like, like]);

  const pricedListings = [];
  for (const row of rows) {
    const parsed = safeJsonParse(row.crate_data);
    const unitPrice = Number(parsed && parsed.prices && parsed.prices[row.item_id]) || 0;
    if (unitPrice > 0) {
      pricedListings.push({
        crateId: row.crate_id,
        itemLabel: row.item_label,
        stock: Number(row.stock) || 0,
        price: unitPrice,
        seller: (row.seller_name && row.seller_name.trim()) || row.faction_name || 'Survivor Crate',
        coords: `X: ${Number(row.coords_x).toFixed(1)}, Y: ${Number(row.coords_y).toFixed(1)}`,
      });
    }
  }

  pricedListings.sort((a, b) => a.price - b.price);
  const top = pricedListings.slice(0, 5);

  if (!top.length) {
    return interaction.editReply(`No active BS19 vending crates currently have **${itemQuery}** priced for sale.`);
  }

  const embed = new EmbedBuilder()
    .setColor(0x0d9488)
    .setTitle(`Offline Vending Search: "${itemQuery}"`)
    .setDescription(`Found **${pricedListings.length}** priced listing(s), showing top ${top.length} by lowest price.`)
    .setFooter({ text: 'BS19 - Companion • Developed by Trident40' })
    .setTimestamp();

  for (const listing of top) {
    embed.addFields({
      name: `${safeStr(listing.itemLabel)} — $${formatNumber(listing.price)} (Qty: ${formatNumber(listing.stock)})`,
      value: `Seller: **${safeStr(listing.seller)}** · Crate #${listing.crateId} · Grid: \`${listing.coords}\``,
      inline: false,
    });
  }

  return interaction.editReply({ embeds: [embed] });
}

async function handleWorldStatusCommand(interaction) {
  await interaction.deferReply();
  if (!worldState.darkZone.updatedAt || !worldState.powerStation.updatedAt) {
    await hydrateWorldStateFromDb();
  }

  const ps = worldState.powerStation;
  const dz = worldState.darkZone;
  const embedColor = ps.status === 'ONLINE' ? 0x16a34a : ps.status === 'OFFLINE' ? 0xdc2626 : 0xd97706;

  const embed = new EmbedBuilder()
    .setColor(embedColor)
    .setTitle('BS19 Live World Operations Status')
    .setDescription('Live state synced from the BS19 bridge and database state tables.')
    .addFields(
      { name: 'Power Station', value: ps.status, inline: true },
      { name: 'Grid Output', value: `${ps.gridLoadPercent}%`, inline: true },
      { name: 'Grid Controller', value: ps.controllingFaction, inline: true },
      { name: 'Active Dark Zone', value: dz.activeSector, inline: true },
      { name: 'Radiation Level', value: dz.radiationLevel, inline: true },
      { name: 'Dark Zone Grid', value: `\`${dz.coords}\``, inline: true },
      { name: 'Last Military Convoy', value: worldState.lastConvoy || 'No recent sighting', inline: false },
      { name: 'Last Supply Airdrop', value: worldState.lastAirdrop || 'No recent drop', inline: false }
    )
    .setFooter({ text: 'BS19 - Companion • Developed by Trident40' })
    .setTimestamp();

  return interaction.editReply({ embeds: [embed] });
}

async function handleLinkCommand(interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const profile = await fetchSurvivorFactionProfile(interaction.user.id);
  if (profile) {
    const embed = new EmbedBuilder()
      .setColor(0x16a34a)
      .setTitle('BS19 Account Linked')
      .setDescription(`Discord user <@${interaction.user.id}> is linked to **${safeStr(profile.charName)}** (\`#${profile.charId}\`).`)
      .addFields(
        { name: 'Faction', value: profile.factionLabel ? safeStr(profile.factionLabel) : 'Unaffiliated', inline: true },
        { name: 'Rank', value: profile.factionRank ? formatRankTitle(profile.factionRank, profile.rankLabel) : 'None', inline: true },
        { name: 'Sync Roles', value: 'Run `/sync-roles` anytime to refresh your Discord roles.', inline: false }
      )
      .setFooter({ text: 'BS19 - Companion • Developed by Trident40' })
      .setTimestamp();
    return interaction.editReply({ embeds: [embed] });
  }

  return interaction.editReply(
    'Your account is not linked yet. Join the FiveM server, type `/verify` in chat, and run `/verify code:XXXXXX` here to link and claim your Faction & Rank roles!'
  );
}

const ADMIN_TEST_PAYLOADS = {
  dark_zone_shift: {
    previousSector: 'Cypress Flats',
    activeSector: 'Palmer-Taylor Industrial Zone',
    radiationLevel: 'Contaminated PvP Zone',
    coords: 'X: 2742.0, Y: 1518.4',
    nextShiftMinutes: 240,
    lootMultiplier: 'Contaminated Tier III Crates',
  },
  military_convoy: {
    callsign: 'BS19-CONVOY-#7',
    route: 'Fort Zancudo -> Route 68 -> Grand Senora Desert',
    escortCount: 4,
    cargoType: 'Locked Military Crates (Lockpick / Crowbar)',
    coords: 'X: -412.8, Y: 2941.2',
  },
  airdrop: {
    dropZone: 'Sandy Shores Airfield',
    crateTier: 'BS19 Supply Drop Crate (Open PvP)',
    coords: 'X: 1742.5, Y: 3265.1',
    unlockSeconds: 180,
    flareColor: 'Red Signal Flare',
  },
  power_station: {
    status: 'ONLINE',
    gridLoadPercent: 100,
    controllingFaction: 'Iron Vanguard',
    affectedZones: 'Downtown Power Grid & Illuminated Safe Zones (XP Buff Active)',
  },
  base_raid: {
    targetFaction: 'Rustline Syndicate',
    attackerFaction: 'Ashfall Marauders',
    sector: 'Declared Faction Raid (60 min window)',
    breachMethod: 'Official Raid Declaration (bs_building)',
    coords: 'X: 1968.4, Y: 4632.9',
  },
  vending_sale: {
    itemName: 'M4A1 Tactical Receiver',
    quantity: 1,
    price: 18500,
    currency: 'Cash',
    sellerName: 'Vektor_99',
    buyerName: 'Kestrel',
    crateLocation: 'Paleto Outpost Crate #104',
    coords: 'X: -244.1, Y: 6228.5',
  },
  test_dispatch: {
    message: 'Admin test ping triggered directly from Discord via /test-event.',
    onlinePlayers: 0,
    bridgeVersion: '1.2.0',
  },
};

async function handleTestEventCommand(interaction) {
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
    return interaction.reply({
      content: 'Only Discord Administrators can run `/test-event`.',
      flags: MessageFlags.Ephemeral,
    });
  }

  const chosen = interaction.options.getString('event', true);
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const queue =
    chosen === 'all'
      ? ['dark_zone_shift', 'military_convoy', 'airdrop', 'power_station', 'base_raid', 'vending_sale']
      : [chosen];

  const results = [];
  for (const eventType of queue) {
    const targetChannelId =
      eventType === 'vending_sale' && MARKET_CHANNEL_ID
        ? MARKET_CHANNEL_ID
        : DISPATCH_CHANNEL_ID;

    const channel = await client.channels.fetch(targetChannelId).catch(() => null);
    if (!channel || !channel.isTextBased()) {
      results.push(`- \`${eventType}\`: Failed (channel \`${targetChannelId}\` unavailable or missing View/Send permissions)`);
      continue;
    }

    const embed = buildEventEmbed(
      eventType,
      'BeyondSurvival (BS19)',
      ADMIN_TEST_PAYLOADS[eventType] || {}
    );
    await channel.send({ embeds: [embed] });
    results.push(`- \`${eventType}\` -> <#${targetChannelId}>`);
  }

  return interaction.editReply(`**Admin Test Dispatch Complete:**\n${results.join('\n')}`);
}

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    // Handle Permanent Verify Panel Buttons
    if (interaction.isButton()) {
      if (interaction.customId === 'bs19_verify_code_btn') {
        const modal = new ModalBuilder()
          .setCustomId('bs19_verify_code_modal')
          .setTitle('BS19 - Companion Verification');

        const codeInput = new TextInputBuilder()
          .setCustomId('bs19_verify_code_input')
          .setLabel('Enter 6-character code from /verify in-game')
          .setPlaceholder('e.g. K7M4Q2')
          .setStyle(TextInputStyle.Short)
          .setMinLength(4)
          .setMaxLength(16)
          .setRequired(true);

        modal.addComponents(new ActionRowBuilder().addComponents(codeInput));
        return interaction.showModal(modal);
      }
      if (interaction.customId === 'bs19_verify_auto_btn') {
        return executeVerifyFlow(interaction, '');
      }
      if (interaction.customId === 'bs19_sync_roles_btn') {
        return handleSyncRolesCommand(interaction);
      }
      return;
    }

    // Handle Permanent Verify Panel Modal Submit
    if (interaction.isModalSubmit()) {
      if (interaction.customId === 'bs19_verify_code_modal') {
        const submittedCode = interaction.fields.getTextInputValue('bs19_verify_code_input');
        return executeVerifyFlow(interaction, submittedCode);
      }
      return;
    }

    if (!interaction.isChatInputCommand()) return;

    switch (interaction.commandName) {
      case 'verify':
        await handleVerifyCommand(interaction);
        break;
      case 'sync-roles':
        await handleSyncRolesCommand(interaction);
        break;
      case 'post-verify-panel':
        await handlePostVerifyPanelCommand(interaction);
        break;
      case 'link':
        await handleLinkCommand(interaction);
        break;
      case 'survivor':
        await handleSurvivorCommand(interaction);
        break;
      case 'faction-status':
        await handleFactionStatusCommand(interaction);
        break;
      case 'market':
        await handleMarketCommand(interaction);
        break;
      case 'world-status':
        await handleWorldStatusCommand(interaction);
        break;
      case 'test-event':
        await handleTestEventCommand(interaction);
        break;
      default:
        break;
    }
  } catch (error) {
    console.error('[BS19 - Companion] Interaction failed:', error);
    const errorMsg = 'Unable to complete action right now. Check bot console logs for details.';
    if (interaction.isRepliable()) {
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply(errorMsg).catch(() => {});
      } else {
        await interaction.reply({ content: errorMsg, flags: MessageFlags.Ephemeral }).catch(() => {});
      }
    }
  }
});

// =============================================================================
// 9. EXPRESS WEBHOOK RECEIVER (POST /api/bs19-event)
// =============================================================================
function verifyApiSecret(headerValue) {
  if (typeof headerValue !== 'string' || !API_SECRET) return false;
  const expected = Buffer.from(API_SECRET, 'utf8');
  const provided = Buffer.from(headerValue, 'utf8');
  if (expected.length !== provided.length) return false;
  return crypto.timingSafeEqual(expected, provided);
}

const app = express();
app.use(express.json({ limit: '64kb' }));

app.get('/health', (_req, res) => {
  res.status(200).json({
    ok: true,
    discordReady: client.isReady(),
    pendingVerifyCodes: pendingVerifyCodes.size,
    linkedSurvivors: Object.keys(linkedAccounts).length,
    worldState,
  });
});

app.post('/api/bs19-event', async (req, res) => {
  const providedSecret = req.get('x-api-secret');
  if (!verifyApiSecret(providedSecret)) {
    return res.status(401).json({ error: 'Unauthorized: invalid x-api-secret header.' });
  }

  const { eventType, serverName, payload } = req.body || {};
  if (typeof eventType !== 'string' || !eventType.trim()) {
    return res.status(400).json({ error: 'Bad Request: missing eventType.' });
  }

  // Handle in-game /verify one-time code registration
  if (eventType === 'verify_code') {
    const code = String(payload?.code || '').trim().toUpperCase();
    if (!code) return res.status(400).json({ error: 'Missing verify code.' });
    pendingVerifyCodes.set(code, {
      ...payload,
      code,
      expiresAt: Number(payload.expiresAt) || Math.floor(Date.now() / 1000) + 600,
    });
    return res.status(200).json({ ok: true, eventType, codeStored: true });
  }

  // Handle live Faction & Rank role sync triggered by BS19 AutoWatch
  if (eventType === 'role_sync') {
    if (!client.isReady() || !GUILD_ID) {
      return res.status(503).json({ error: 'Discord client or GUILD_ID not ready.' });
    }
    const discordId = findDiscordIdByCharOrLicense(payload?.charId, payload?.license, payload?.discord);
    if (!discordId) {
      return res.status(200).json({ ok: true, skipped: 'unlinked_survivor' });
    }
    try {
      const guild = await client.guilds.fetch(GUILD_ID);
      const result = await syncMemberFactionRoles(guild, discordId, payload || {});
      return res.status(200).json({ ok: result.ok, discordId, ...result });
    } catch (err) {
      console.error('[BS19 RoleSync] Failed:', err);
      return res.status(500).json({ error: 'Failed to sync Discord roles.' });
    }
  }

  if (!client.isReady()) {
    return res.status(503).json({ error: 'Discord client is not ready yet.' });
  }

  try {
    const targetChannelId =
      eventType === 'vending_sale' && MARKET_CHANNEL_ID
        ? MARKET_CHANNEL_ID
        : DISPATCH_CHANNEL_ID;

    const channel = await client.channels.fetch(targetChannelId);
    if (!channel || !channel.isTextBased()) {
      return res.status(500).json({ error: `Target Discord channel ${targetChannelId} is unavailable.` });
    }

    const embed = buildEventEmbed(eventType, serverName, payload || {});
    await channel.send({ embeds: [embed] });

    return res.status(200).json({ ok: true, eventType, channelId: targetChannelId });
  } catch (error) {
    console.error('[BS19 Webhook] Failed to post Discord embed:', error);
    return res.status(500).json({ error: 'Failed to dispatch embed to Discord.' });
  }
});

// =============================================================================
// 10. STARTUP & GRACEFUL SHUTDOWN
// =============================================================================
const port = Number(WEBHOOK_PORT) || 3045;
const httpServer = app.listen(port, () => {
  console.log(`[BS19 Webhook] Express listener active on port ${port} (POST /api/bs19-event)`);
});

client.login(DISCORD_TOKEN).catch((error) => {
  console.error('[BS19 - Companion] Discord login failed:', error);
  process.exit(1);
});

async function shutdown(signal) {
  console.log(`[BS19 - Companion] Received ${signal}, shutting down cleanly...`);
  httpServer.close();
  await dbPool.end().catch(() => {});
  client.destroy();
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
