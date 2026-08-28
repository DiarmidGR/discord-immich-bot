import {
  Client,
  GatewayIntentBits,
  Events,
  Attachment,
  TextChannel,
  Message,
  PermissionsBitField,
} from "discord.js";
import { config } from "./config.js";
import { addAssetsToAlbum, getOrCreateAlbumId, uploadAsset } from "./immich.js";
import { addChannel, isDynamicallyWatched, listDynamicChannels, removeChannel } from "./watchlist.js";

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

function isMediaAttachment(attachment: Attachment): boolean {
  if (attachment.contentType?.startsWith("image/")) return true;
  if (attachment.contentType?.startsWith("video/")) return true;
  // Fallback for cases where Discord didn't set contentType.
  return /\.(png|jpe?g|gif|webp|bmp|heic|heif|mp4|mov|webm|mkv|avi)$/i.test(
    attachment.name ?? ""
  );
}

/** Turns a Discord channel name like "family-photos" into "Family Photos". */
function prettifyChannelName(name: string): string {
  return name
    .split(/[-_]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function albumNameForChannel(channelId: string, channelName: string): string {
  return config.channelAlbumOverrides[channelId] ?? prettifyChannelName(channelName);
}

function isMissingAlbumError(error: unknown): boolean {
  return error instanceof Error && error.message.includes('"message":"Album not found"');
}

async function isWatched(channelId: string): Promise<boolean> {
  if (config.watchedChannelIds.has(channelId)) return true;
  return isDynamicallyWatched(channelId);
}

async function handleAttachment(
  attachment: Attachment,
  channelId: string,
  channelName: string,
  createdAt: Date
): Promise<void> {
  if (!isMediaAttachment(attachment)) return;
  if (config.minImageBytes > 0 && attachment.size < config.minImageBytes) return;
  if (config.maxMediaBytes > 0 && attachment.size > config.maxMediaBytes) return;

  const response = await fetch(attachment.url);
  if (!response.ok) {
    throw new Error(`Failed to download attachment ${attachment.id}: ${response.status}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());

  const upload = await uploadAsset({
    buffer,
    filename: attachment.name ?? `discord-${attachment.id}`,
    mimeType: attachment.contentType ?? "application/octet-stream",
    // Stable per-attachment ID: safe to re-run without duplicating albums,
    // and Immich's own checksum dedup also catches re-uploads of the same bytes.
    deviceAssetId: `discord-${attachment.id}`,
    createdAt,
  });

  const albumName = albumNameForChannel(channelId, channelName);
  let albumId = await getOrCreateAlbumId(albumName);
  try {
    await addAssetsToAlbum(albumId, [upload.id]);
  } catch (error) {
    if (!isMissingAlbumError(error)) throw error;
    console.warn(`[sync] Album "${albumName}" was not found; recreating it.`);
    albumId = await getOrCreateAlbumId(albumName, { refresh: true });
    await addAssetsToAlbum(albumId, [upload.id]);
  }

  console.log(
    `[sync] #${channelName} -> "${albumName}": ${attachment.name} (${upload.status})`
  );
}

/** Users need Manage Channels (or Administrator) to change what the bot watches. */
function canManageWatchlist(message: Message): boolean {
  if (!message.member) return false;
  return message.member.permissions.has(PermissionsBitField.Flags.ManageChannels);
}

async function handleCommand(message: Message, args: string[]): Promise<void> {
  const subcommand = args[0]?.toLowerCase();
  const channel = message.channel as TextChannel;
  const channelName = "name" in channel ? channel.name : message.channelId;

  if (subcommand === "help") {
    await message.reply(
      [
        "**Immich bot commands**",
        `\`${config.commandPrefix} help\` - Show this help message.`,
        `\`${config.commandPrefix} watch\` - Start watching this channel for images and videos.`,
        `\`${config.commandPrefix} unwatch\` - Stop watching this channel.`,
        `\`${config.commandPrefix} list\` - List all channels currently being watched.`,
      ].join("\n")
    );
    return;
  }

  if (subcommand === "watch") {
    if (!canManageWatchlist(message)) {
      await message.reply("You need the **Manage Channels** permission to do that.");
      return;
    }
    if (config.watchedChannelIds.has(message.channelId)) {
      await message.reply("This channel is already watched (configured at startup).");
      return;
    }
    const added = await addChannel(message.channelId, channelName, message.author.tag);
    await message.reply(
      added
        ? `Now watching #${channelName} — images and videos posted here will sync to Immich.`
        : "This channel is already being watched."
    );
    return;
  }

  if (subcommand === "unwatch") {
    if (!canManageWatchlist(message)) {
      await message.reply("You need the **Manage Channels** permission to do that.");
      return;
    }
    if (config.watchedChannelIds.has(message.channelId)) {
      await message.reply(
        "This channel is watched via static config (`WATCHED_CHANNEL_IDS`), not a runtime command — remove it there instead."
      );
      return;
    }
    const removed = await removeChannel(message.channelId);
    await message.reply(
      removed ? `Stopped watching #${channelName}.` : "This channel wasn't being watched."
    );
    return;
  }

  if (subcommand === "list") {
    const dynamic = await listDynamicChannels();
    const staticList = [...config.watchedChannelIds].map((id) => `<#${id}> (static)`);
    const dynamicList = dynamic.map((e) => `<#${e.channelId}> (added by ${e.addedBy})`);
    const all = [...staticList, ...dynamicList];
    await message.reply(all.length > 0 ? `Watching:\n${all.join("\n")}` : "No channels are currently watched.");
    return;
  }

  await message.reply(
    `Unknown command. Use \`${config.commandPrefix} help\` to see all commands.`
  );
}

client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return;

  const trimmed = message.content.trim();
  if (trimmed.toLowerCase().startsWith(config.commandPrefix.toLowerCase())) {
    const args = trimmed.slice(config.commandPrefix.length).trim().split(/\s+/).filter(Boolean);
    try {
      await handleCommand(message, args);
    } catch (err) {
      console.error("[error] Failed to handle command:", err);
      await message.reply("Something went wrong running that command — check the logs.").catch(() => {});
    }
    return;
  }

  if (!(await isWatched(message.channelId))) return;
  if (message.attachments.size === 0) return;

  const channel = message.channel as TextChannel;
  const channelName = "name" in channel ? channel.name : message.channelId;

  for (const attachment of message.attachments.values()) {
    try {
      await handleAttachment(attachment, message.channelId, channelName, message.createdAt);
    } catch (err) {
      console.error(`[error] Failed to sync attachment ${attachment.id}:`, err);
      // Optionally let the poster know their image didn't make it.
      await message.react("⚠️").catch(() => {});
    }
  }
});

client.once(Events.ClientReady, async (readyClient) => {
  console.log(`Logged in as ${readyClient.user.tag}`);
  const dynamic = await listDynamicChannels();
  console.log(
    `Watching ${config.watchedChannelIds.size} static + ${dynamic.length} dynamic channel(s)`
  );
});

client.login(config.discordToken);
