require('dotenv').config();

const { REST, Routes, SlashCommandBuilder, PermissionFlagsBits, ChannelType } = require('discord.js');

const { DISCORD_TOKEN, CLIENT_ID, GUILD_ID } = process.env;

if (!DISCORD_TOKEN || !CLIENT_ID || !GUILD_ID) {
  console.error('[Deploy] Missing DISCORD_TOKEN, CLIENT_ID, or GUILD_ID in .env');
  process.exit(1);
}

const commands = [
  new SlashCommandBuilder()
    .setName('verify')
    .setDescription('Link your BS19 survivor account and claim your Verified, Faction, and Rank roles.')
    .addStringOption((option) =>
      option
        .setName('code')
        .setDescription('6-character code from /verify in-game (leave blank for auto-verify)')
        .setRequired(false)
        .setMinLength(4)
        .setMaxLength(16)
    ),

  new SlashCommandBuilder()
    .setName('sync-roles')
    .setDescription('Refresh your BS19 Faction and Rank Discord roles from the live server database.'),

  new SlashCommandBuilder()
    .setName('link')
    .setDescription('Check your linked BS19 survivor profile or get instructions to verify.')
    .addStringOption((option) =>
      option
        .setName('identifier')
        .setDescription('Optional FiveM license or BS19 character name')
        .setRequired(false)
        .setMaxLength(96)
    ),

  new SlashCommandBuilder()
    .setName('survivor')
    .setDescription('Look up a BS19 survivor profile, playtime, kills, and Wasteland Pass tier.')
    .addStringOption((option) =>
      option
        .setName('name')
        .setDescription('Survivor first/last name or partial name')
        .setRequired(true)
        .setMinLength(2)
        .setMaxLength(48)
    ),

  new SlashCommandBuilder()
    .setName('faction-status')
    .setDescription('Inspect a BS19 faction treasury balance, territory flags, and member count.')
    .addStringOption((option) =>
      option
        .setName('faction')
        .setDescription('Faction name, ID, or short tag')
        .setRequired(true)
        .setMinLength(2)
        .setMaxLength(48)
    ),

  new SlashCommandBuilder()
    .setName('market')
    .setDescription('Search active BS19 offline vending crates for an item, price, and coordinates.')
    .addStringOption((option) =>
      option
        .setName('item')
        .setDescription('Item name or label keyword')
        .setRequired(true)
        .setMinLength(2)
        .setMaxLength(64)
    ),

  new SlashCommandBuilder()
    .setName('world-status')
    .setDescription('Display the latest Power Station state and active Dark Zone sector.'),

  new SlashCommandBuilder()
    .setName('test-event')
    .setDescription('Admin only: Post a simulated BS19 event embed into its target Discord channel.')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption((option) =>
      option
        .setName('event')
        .setDescription('Which BS19 event to test-post into its designated channel')
        .setRequired(true)
        .addChoices(
          { name: 'All Events (Post Full Suite)', value: 'all' },
          { name: 'Dark Zone Shift (#dispatch)', value: 'dark_zone_shift' },
          { name: 'Military Convoy (#dispatch)', value: 'military_convoy' },
          { name: 'Supply Airdrop (#dispatch)', value: 'airdrop' },
          { name: 'Power Station Status (#dispatch)', value: 'power_station' },
          { name: 'Base Raid Alert (#dispatch)', value: 'base_raid' },
          { name: 'Offline Vending Sale (#market)', value: 'vending_sale' },
          { name: 'Bridge Connectivity Ping (#dispatch)', value: 'test_dispatch' }
        )
    ),
  new SlashCommandBuilder()
    .setName('post-verify-panel')
    .setDescription('Admin only: Post or refresh the permanent interactive Verify Panel embed.')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addChannelOption((option) =>
      option
        .setName('channel')
        .setDescription('Target #verify channel (defaults to VERIFY_CHANNEL_ID in .env)')
        .addChannelTypes(ChannelType.GuildText)
        .setRequired(false)
    ),
].map((cmd) => cmd.toJSON());

const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);

(async () => {
  try {
    console.log(`[Deploy] Registering ${commands.length} guild slash commands for guild ${GUILD_ID}...`);
    const registered = await rest.put(
      Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID),
      { body: commands }
    );
    console.log(`[Deploy] Successfully registered ${registered.length} slash commands.`);
  } catch (error) {
    console.error('[Deploy] Failed to register slash commands:', error);
    process.exit(1);
  }
})();
