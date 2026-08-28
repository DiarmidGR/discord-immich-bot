import {
  Client,
  GatewayIntentBits,
  Events,
  Attachment,
  CategoryChannel,
  TextChannel,
  Message,
  PermissionsBitField,
  ActivityType,
} from "discord.js";
import { config } from "./config.js";
import {
  addAssetsToAlbum,
  getOrCreateAlbumId,
  getOrCreateAlbumShareUrl,
  uploadAsset,
} from "./immich.js";
import { addChannel, isDynamicallyWatched, listDynamicChannels, removeChannel } from "./watchlist.js";

type AttachmentSyncStatus = "created" | "duplicate" | "skipped";

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
): Promise<AttachmentSyncStatus> {
  if (!isMediaAttachment(attachment)) return "skipped";
  if (config.minImageBytes > 0 && attachment.size < config.minImageBytes) return "skipped";
  if (config.maxMediaBytes > 0 && attachment.size > config.maxMediaBytes) return "skipped";

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
  return upload.status;
}

async function backfillChannel(channel: TextChannel): Promise<{
  media: number;
  created: number;
  duplicate: number;
  skipped: number;
  failed: number;
}> {
  let before: string | undefined;
  let media = 0;
  let created = 0;
  let duplicate = 0;
  let skipped = 0;
  let failed = 0;

  while (true) {
    const messages = await channel.messages.fetch({ limit: 100, before });
    if (messages.size === 0) break;

    for (const message of [...messages.values()].reverse()) {
      const attachments = [...message.attachments.values()].filter(isMediaAttachment);
      media += attachments.length;
      for (const attachment of attachments) {
        try {
          const status = await handleAttachment(
            attachment,
            channel.id,
            channel.name,
            message.createdAt
          );
          if (status === "created") created++;
          else if (status === "duplicate") duplicate++;
          else skipped++;
        } catch (err) {
          failed++;
          console.error(
            `[error] Failed to backfill attachment ${attachment.id}:`,
            err
          );
        }
      }
    }

    if (messages.size < 100) break;
    before = messages.last()?.id;
    if (!before) break;
  }

  return { media, created, duplicate, skipped, failed };
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
        `\`${config.commandPrefix} gallery\` - Get a public link to this channel's album.`,
        `\`${config.commandPrefix} watch [channel-or-category-id]\` - Start watching this channel, or the specified channel/category, for images and videos.`,
        `\`${config.commandPrefix} backfill [channel-or-category-id]\` - Upload existing images and videos from this watched channel, or the specified channel/category.`,
        `\`${config.commandPrefix} unwatch [channel-or-category-id]\` - Stop watching this channel, or the specified channel/category.`,
        `\`${config.commandPrefix} list\` - List all channels currently being watched.`,
      ].join("\n")
    );
    return;
  }

  if (subcommand === "gallery") {
    if (!(await isWatched(message.channelId))) {
      await message.reply(
        `This channel isn't being watched. Use \`${config.commandPrefix} watch\` first.`
      );
      return;
    }
    const albumName = albumNameForChannel(message.channelId, channelName);
    const albumId = await getOrCreateAlbumId(albumName);
    const albumUrl = await getOrCreateAlbumShareUrl(albumId);
    await message.reply(albumUrl);
    return;
  }

  if (subcommand === "watch") {
    if (!canManageWatchlist(message)) {
      await message.reply("You need the **Manage Channels** permission to do that.");
      return;
    }
    if (!message.guildId) {
      await message.reply("This command can only be used in a server.");
      return;
    }
    // With no ID, keep the original behavior and target the channel containing the command.
    const targetChannelId = args[1] ?? message.channelId;
    // The current channel is already available; otherwise fetch the ID supplied by the user.
    const targetChannel =
      targetChannelId === message.channelId
        ? channel
        : await client.channels.fetch(targetChannelId).catch(() => null);
    // This check also narrows targetChannel to a TextChannel or CategoryChannel below.
    if (!(targetChannel instanceof TextChannel || targetChannel instanceof CategoryChannel) || targetChannel.guildId !== message.guildId) {
      await message.reply("Please specify a text channel or category in this server.");
      return;
    }

    if (targetChannel instanceof CategoryChannel) {
      // A category can contain several channel types, but only text channels receive messages.
      const channels = [...targetChannel.children.cache.values()].filter(
        (child): child is TextChannel => child instanceof TextChannel
      );
      if (channels.length === 0) {
        await message.reply("That category has no text channels to watch.");
        return;
      }
      let addedCount = 0;
      for (const child of channels) {
        // Static channels are configured at startup and cannot be removed by runtime commands.
        if (config.watchedChannelIds.has(child.id)) continue;
        // addChannel persists each child independently in the dynamic watchlist.
        if (await addChannel(child.id, message.guildId, child.name, message.author.tag)) {
          addedCount++;
        }
      }
      await message.reply(
        addedCount > 0
          ? `Now watching ${addedCount} text channel(s) in **${targetChannel.name}**.`
          : `All text channels in **${targetChannel.name}** are already being watched.`
      );
      return;
    }

    const targetChannelName = targetChannel.name;
    if (config.watchedChannelIds.has(targetChannelId)) {
      await message.reply(`#${targetChannelName} is already watched (configured at startup).`);
      return;
    }
    const added = await addChannel(
      targetChannelId,
      message.guildId,
      targetChannelName,
      message.author.tag
    );
    await message.reply(
      added
        ? `Now watching #${targetChannelName} — images and videos posted here will sync to Immich. Use \`${config.commandPrefix} backfill\` to upload existing media too.`
        : `#${targetChannelName} is already being watched.`
    );
    return;
  }

  if (subcommand === "backfill") {
    if (!canManageWatchlist(message)) {
      await message.reply("You need the **Manage Channels** permission to do that.");
      return;
    }
    if (!message.guildId) {
      await message.reply("This command can only be used in a server.");
      return;
    }
    // A missing ID means backfill the channel where the command was sent.
    const targetChannelId = args[1] ?? message.channelId;
    // Fetch another channel only when the user supplied a different ID.
    const targetChannel =
      targetChannelId === message.channelId
        ? channel
        : await client.channels.fetch(targetChannelId).catch(() => null);
    if (!(targetChannel instanceof TextChannel || targetChannel instanceof CategoryChannel) || targetChannel.guildId !== message.guildId) {
      await message.reply("Please specify a text channel or category in this server.");
      return;
    }

    if (targetChannel instanceof CategoryChannel) {
      // Only backfill watched text channels directly inside the category.
      const textChannels = [...targetChannel.children.cache.values()].filter(
        (child): child is TextChannel => child instanceof TextChannel
      );
      // isWatched is asynchronous because the dynamic watchlist is persisted on disk.
      const channels = (await Promise.all(
        textChannels.map(async (child) => (await isWatched(child.id)) ? child : null)
      )).filter((child): child is TextChannel => child !== null);
      if (channels.length === 0) {
        await message.reply("That category has no watched text channels to backfill.");
        return;
      }

      const progressMessage = await message.reply(
        `Backfill started; scanning ${channels.length} channel(s) in **${targetChannel.name}**...`
      );
      const result = { media: 0, created: 0, duplicate: 0, skipped: 0, failed: 0 };
      for (const child of channels) {
        // Each channel is processed separately, then its counts are added to the total.
        const channelResult = await backfillChannel(child);
        result.media += channelResult.media;
        result.created += channelResult.created;
        result.duplicate += channelResult.duplicate;
        result.skipped += channelResult.skipped;
        result.failed += channelResult.failed;
      }
      await progressMessage.edit(
        `Backfill complete: ${result.created} new, ${result.duplicate} duplicate(s), ${result.skipped} skipped, ${result.failed} failed out of ${result.media} media attachment(s).`
      );
      return;
    }

    // Backfill is only allowed for channels that are already on the watchlist.
    if (!(await isWatched(targetChannelId))) {
      await message.reply(
        `#${targetChannel.name} isn't being watched. Use \`${config.commandPrefix} watch ${targetChannelId}\` first.`
      );
      return;
    }

    const progressMessage = await message.reply("Backfill started; scanning channel history...");
    const result = await backfillChannel(targetChannel);
    await progressMessage.edit(
      `Backfill complete: ${result.created} new, ${result.duplicate} duplicate(s), ${result.skipped} skipped, ${result.failed} failed out of ${result.media} media attachment(s).`
    );
    return;
  }

  if (subcommand === "unwatch") {
    if (!canManageWatchlist(message)) {
      await message.reply("You need the **Manage Channels** permission to do that.");
      return;
    }
    if (!message.guildId) {
      await message.reply("This command can only be used in a server.");
      return;
    }
    // Fall back to the command channel so bare `unwatch` remains unchanged.
    const targetChannelId = args[1] ?? message.channelId;
    // Resolve a supplied ID through Discord and reject channels from another server.
    const targetChannel =
      targetChannelId === message.channelId
        ? channel
        : await client.channels.fetch(targetChannelId).catch(() => null);
    if (!(targetChannel instanceof TextChannel || targetChannel instanceof CategoryChannel) || targetChannel.guildId !== message.guildId) {
      await message.reply("Please specify a text channel or category in this server.");
      return;
    }

    if (targetChannel instanceof CategoryChannel) {
      // Remove dynamic entries for every text channel in the category.
      const channels = [...targetChannel.children.cache.values()].filter(
        (child): child is TextChannel => child instanceof TextChannel
      );
      let removedCount = 0;
      for (const child of channels) {
        // Static entries come from configuration and must remain there until manually changed.
        if (config.watchedChannelIds.has(child.id)) continue;
        if (await removeChannel(child.id)) removedCount++;
      }
      await message.reply(
        removedCount > 0
          ? `Stopped watching ${removedCount} text channel(s) in **${targetChannel.name}**.`
          : `No dynamically watched text channels were found in **${targetChannel.name}**.`
      );
      return;
    }

    // Static configuration is separate from the runtime watchlist, so it cannot be removed here.
    if (config.watchedChannelIds.has(targetChannelId)) {
      await message.reply(
        "This channel is watched via static config (`WATCHED_CHANNEL_IDS`), not a runtime command — remove it there instead."
      );
      return;
    }
    const removed = await removeChannel(targetChannelId);
    await message.reply(
      removed ? `Stopped watching #${targetChannel.name}.` : `#${targetChannel.name} wasn't being watched.`
    );
    return;
  }

  if (subcommand === "list") {
    if (!message.guildId) {
      await message.reply("This command can only be used in a server.");
      return;
    }
    const dynamic = await listDynamicChannels();
    const staticList = (await Promise.all(
      [...config.watchedChannelIds].map(async (id) => {
        const watchedChannel = await client.channels.fetch(id).catch(() => null);
        return watchedChannel && "guildId" in watchedChannel && watchedChannel.guildId === message.guildId
          ? `<#${id}> (static)`
          : null;
      })
    )).filter((entry): entry is string => entry !== null);
    const dynamicList = (await Promise.all(
      dynamic.map(async (entry) => {
        if (entry.guildId === message.guildId) return `<#${entry.channelId}> (added by ${entry.addedBy})`;
        if (entry.guildId) return null;
        const watchedChannel = await client.channels.fetch(entry.channelId).catch(() => null);
        return watchedChannel && "guildId" in watchedChannel && watchedChannel.guildId === message.guildId
          ? `<#${entry.channelId}> (added by ${entry.addedBy})`
          : null;
      })
    )).filter((entry): entry is string => entry !== null);
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
      await handleAttachment(
        attachment,
        message.channelId,
        channelName,
        message.createdAt
      );
    } catch (err) {
      console.error(`[error] Failed to sync attachment ${attachment.id}:`, err);
      // Optionally let the poster know their image didn't make it.
      await message.react("⚠️").catch(() => {});
    }
  }
});

client.once(Events.ClientReady, async (readyClient) => {
  readyClient.user.setActivity(
    `${config.commandPrefix} help | ${new URL(config.immich.baseUrl).host}`,
    { type: ActivityType.Custom }
  );
  console.log(`Logged in as ${readyClient.user.tag}`);
  const dynamic = await listDynamicChannels();
  console.log(
    `Watching ${config.watchedChannelIds.size} static + ${dynamic.length} dynamic channel(s)`
  );
});

client.login(config.discordToken);
