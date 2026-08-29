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

type BackfillStatus = {
  media: number;      // Number of media attachments found in text channel
  created: number;    // Number of items uploaded to Immich
  duplicate: number;  // Number of items skipped due to being duplicates in Immich
  skipped: number;    // Number of items skipped due to not being media or being too small/large
  failed: number;     // Number of items that failed to upload to Immich
};

type BackfillProgress = {
  processed: number;    // Number of media attachments processed so far
  total: number;        // Total number of media attachments found in text channel
  created: number;      // Number of items uploaded to Immich so far
  duplicate: number;    // Number of items skipped due to being duplicates in Immich so far
  skipped: number;      // Number of items skipped due to not being media or being too small/large so far
failed: number;         // Number of items that failed to upload to Immich so far 
  channelName: string;  // Name of the channel being backfilled
};

function renderProgressBar(progress: number, width = 20): string {
  const clampedProgress = Math.min(1, Math.max(0, progress));
  const filled = Math.round(clampedProgress * width);
  return `${"█".repeat(filled)}${"░".repeat(width - filled)}`;
}

function formatBackfillProgress({
  label,
  processed,
  total,
  created,
  duplicate,
  skipped,
  failed,
  channelName,
}: {
  label: string;
  processed: number;
  total: number;
  created: number;
  duplicate: number;
  skipped: number;
  failed: number;
  channelName: string;
}): string {
  if (total === 0) {
    return `${label} **#${channelName}** — no media found.`;
  }

  const percent = (processed / total) * 100;
  const bar = renderProgressBar(processed / total);
  return `${label} ${bar} ${processed}/${total} (${Math.round(percent)}%) • ${created} new • ${duplicate} duplicate • ${skipped} skipped • ${failed} failed`;
}

async function countMediaInChannel(channel: TextChannel): Promise<number> {
  let before: string | undefined;
  let total = 0;

  while (true) {
    const messages = await channel.messages.fetch({ limit: 100, before });
    if (messages.size === 0) break;

    for (const message of [...messages.values()]) {
      total += [...message.attachments.values()].filter(isMediaAttachment).length;
    }

    if (messages.size < 100) break;
    before = messages.last()?.id;
    if (!before) break;
  }

  return total;
}

async function isWatched(channelId: string): Promise<boolean> {
  if (config.watchedChannelIds.has(channelId)) return true;
  return isDynamicallyWatched(channelId);
}

async function isCategoryWatched(categoryId: string, guildId: string): Promise<boolean> {
  // A category is considered watched when at least one of its existing channels is watched.
  for (const channelId of config.watchedChannelIds) {
    const channel = await client.channels.fetch(channelId).catch(() => null);
    if (channel instanceof TextChannel && channel.guildId === guildId && channel.parentId === categoryId) {
      return true;
    }
  }

  const dynamicChannels = await listDynamicChannels();
  for (const entry of dynamicChannels) {
    if (entry.guildId !== guildId) continue;
    const channel = await client.channels.fetch(entry.channelId).catch(() => null);
    if (channel instanceof TextChannel && channel.parentId === categoryId) return true;
  }
  return false;
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

async function backfillChannel(
  channel: TextChannel,
  options: {
    totalMedia?: number;
    onProgress?: (progress: BackfillProgress) => Promise<void> | void;
  } = {}
): Promise<BackfillStatus> {
  let before: string | undefined;
  let media = 0;
  let created = 0;
  let duplicate = 0;
  let skipped = 0;
  let failed = 0;
  let processed = 0;
  const totalMedia = options.totalMedia ?? (await countMediaInChannel(channel));
  let lastProgressUpdate = 0;
  let lastProgressWorked = 0;

  while (true) {
    const messages = await channel.messages.fetch({ limit: 100, before });
    if (messages.size === 0) break;

    for (const message of [...messages.values()].reverse()) {
      const attachments = [...message.attachments.values()].filter(isMediaAttachment);
      media += attachments.length;
      for (const attachment of attachments) {
        processed++;
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

        if (options.onProgress) {
          const now = Date.now();
          if (
            processed - lastProgressWorked >= 5 ||
            now - lastProgressUpdate >= 250
          ) {
            await options.onProgress({
              processed,
              total: totalMedia,
              created,
              duplicate,
              skipped,
              failed,
              channelName: channel.name,
            });
            lastProgressUpdate = now;
            lastProgressWorked = processed;
          }
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

async function resolveChannelTarget(
  message: Message,
  rawValue: string
): Promise<TextChannel | CategoryChannel | null> {
  if (!message.guildId) return null;

  const normalized = rawValue.trim().replace(/[\u200B-\u200D\uFEFF]/g, "");
  if (!normalized) return null;

  const idCandidate = normalized.replace(/^<#|>$/g, "").replace(/^#/, "");
  if (/^\d+$/.test(idCandidate)) {
    const channel = await client.channels.fetch(idCandidate).catch(() => null);
    if (!(channel instanceof TextChannel || channel instanceof CategoryChannel)) return null;
    if (channel.guildId !== message.guildId) return null;
    return channel;
  }

  const targetName = idCandidate.toLowerCase();
  const guild = message.guild;
  if (!guild) return null;

  const match = guild.channels.cache.find((channel) => {
    if (!(channel instanceof TextChannel || channel instanceof CategoryChannel)) return false;
    return channel.name.toLowerCase() === targetName;
  });

  return match instanceof TextChannel || match instanceof CategoryChannel ? match : null;
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
        `\`${config.commandPrefix} gallery [channel]\` - Get a public link to this channel's album (defaults to the current channel, or accepts an ID, #channel, or channel name).`,
        `\`${config.commandPrefix} watch [channel-or-category]\` - Start watching this channel, or the specified channel/category (ID, #channel, or channel name), for images and videos.`,
        `\`${config.commandPrefix} backfill [channel-or-category]\` - Upload existing images and videos from this watched channel, or the specified channel/category (ID, #channel, or channel name).`,
        `\`${config.commandPrefix} unwatch [channel-or-category]\` - Stop watching this channel, or the specified channel/category (ID, #channel, or channel name).`,
        `\`${config.commandPrefix} list\` - List all channels currently being watched.`,
        `\`${config.commandPrefix} github\` - Show the GitHub repository for this bot.`,
      ].join("\n")
    );
    return;
  }

  if (subcommand === "gallery") {
    // Gallery links are intentionally available to any user in a watched channel,
    // regardless of Discord role/permission state.
    const targetChannel = args[1]
      ? await resolveChannelTarget(message, args[1])
      : (channel as TextChannel);

    if (!(targetChannel instanceof TextChannel) || targetChannel.guildId !== message.guildId) {
      await message.reply("Please specify a text channel in this server.");
      return;
    }

    if (!(await isWatched(targetChannel.id))) {
      await message.reply(
        `#${targetChannel.name} isn't being watched. Use \`${config.commandPrefix} watch\` first.`
      );
      return;
    }

    const albumName = albumNameForChannel(targetChannel.id, targetChannel.name);
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
    // With no selector, keep the original behavior and target the channel containing the command.
    const targetChannelId = args[1] ?? message.channelId;
    const targetChannel =
      targetChannelId === message.channelId
        ? channel
        : await resolveChannelTarget(message, targetChannelId);
    // This check also narrows targetChannel to a TextChannel or CategoryChannel below.
    if (!(targetChannel instanceof TextChannel || targetChannel instanceof CategoryChannel) || targetChannel.guildId !== message.guildId) {
      await message.reply("Please specify a text channel or category in this server.");
      return;
    }

    const resolvedTargetChannelId = targetChannel.id;

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
    if (config.watchedChannelIds.has(resolvedTargetChannelId)) {
      await message.reply(`#${targetChannelName} is already watched (configured at startup).`);
      return;
    }
    const added = await addChannel(
      resolvedTargetChannelId,
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
    // A missing selector means backfill the channel where the command was sent.
    const targetChannelId = args[1] ?? message.channelId;
    const targetChannel =
      targetChannelId === message.channelId
        ? channel
        : await resolveChannelTarget(message, targetChannelId);
    if (!(targetChannel instanceof TextChannel || targetChannel instanceof CategoryChannel) || targetChannel.guildId !== message.guildId) {
      await message.reply("Please specify a text channel or category in this server.");
      return;
    }

    const resolvedTargetChannelId = targetChannel.id;

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

      const channelTotals = await Promise.all(channels.map((child) => countMediaInChannel(child)));
      const totalMedia = channelTotals.reduce((sum, count) => sum + count, 0);
      const progressMessage = await message.reply(
        `Backfill started; scanning ${channels.length} channel(s) in **${targetChannel.name}**...`
      );
      const result = { media: 0, created: 0, duplicate: 0, skipped: 0, failed: 0 };
      let processedMedia = 0;

      for (let index = 0; index < channels.length; index++) {
        const child = channels[index];
        const previousProcessedMedia = processedMedia;
        const childResult = await backfillChannel(child, {
          totalMedia: channelTotals[index],
          onProgress: async (progress) => {
            const currentProcessed = previousProcessedMedia + progress.processed;
            await progressMessage.edit(
              formatBackfillProgress({
                label: `Backfill in progress in **${targetChannel.name}**`,
                processed: currentProcessed,
                total: totalMedia,
                created: result.created + progress.created,
                duplicate: result.duplicate + progress.duplicate,
                skipped: result.skipped + progress.skipped,
                failed: result.failed + progress.failed,
                channelName: child.name,
              })
            );
          },
        });

        result.media += childResult.media;
        result.created += childResult.created;
        result.duplicate += childResult.duplicate;
        result.skipped += childResult.skipped;
        result.failed += childResult.failed;
        processedMedia += channelTotals[index];

        await progressMessage.edit(
          formatBackfillProgress({
            label: `Backfill in progress in **${targetChannel.name}**`,
            processed: processedMedia,
            total: totalMedia,
            created: result.created,
            duplicate: result.duplicate,
            skipped: result.skipped,
            failed: result.failed,
            channelName: child.name,
          })
        );
      }
      await progressMessage.edit(
        `Backfill complete: ${result.created} new, ${result.duplicate} duplicate(s), ${result.skipped} skipped, ${result.failed} failed out of ${result.media} media attachment(s).`
      );
      return;
    }

    // Backfill is only allowed for channels that are already on the watchlist.
    if (!(await isWatched(resolvedTargetChannelId))) {
      await message.reply(
        `#${targetChannel.name} isn't being watched. Use \`${config.commandPrefix} watch ${resolvedTargetChannelId}\` first.`
      );
      return;
    }

    const totalMedia = await countMediaInChannel(targetChannel);
    const progressMessage = await message.reply(
      `Backfill started; scanning channel history...`
    );
    const result = await backfillChannel(targetChannel, {
      totalMedia,
      onProgress: async (progress) => {
        await progressMessage.edit(
          formatBackfillProgress({
            label: "Backfill in progress",
            processed: progress.processed,
            total: progress.total,
            created: progress.created,
            duplicate: progress.duplicate,
            skipped: progress.skipped,
            failed: progress.failed,
            channelName: targetChannel.name,
          })
        );
      },
    });
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
    const targetChannel =
      targetChannelId === message.channelId
        ? channel
        : await resolveChannelTarget(message, targetChannelId);
    if (!(targetChannel instanceof TextChannel || targetChannel instanceof CategoryChannel) || targetChannel.guildId !== message.guildId) {
      await message.reply("Please specify a text channel or category in this server.");
      return;
    }

    const resolvedTargetChannelId = targetChannel.id;

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
    if (config.watchedChannelIds.has(resolvedTargetChannelId)) {
      await message.reply(
        "This channel is watched via static config (`WATCHED_CHANNEL_IDS`), not a runtime command — remove it there instead."
      );
      return;
    }
    const removed = await removeChannel(resolvedTargetChannelId);
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

  if (subcommand === "github") {
    await message.reply("Check out my GitHub repository: https://github.com/DiarmidGR/discord-immich-bot");
    return;
  }

  await message.reply(
    `Unknown command. Use \`${config.commandPrefix} help\` to see all commands.`
  );
}

// Handle messages in watched channels, and commands starting with the configured prefix.
client.on(Events.MessageCreate, async (message) => {
  // Cancel operation if the sender of the message was a bot (self including)
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

// Automatically watch new channels created inside a watched category.
client.on(Events.ChannelCreate, async (createdChannel) => {
  // New channels without a parent are not inside a category, so there is nothing to inherit.
  if (!(createdChannel instanceof TextChannel) || !createdChannel.parentId) return;
  if (!(await isCategoryWatched(createdChannel.parentId, createdChannel.guildId))) return;

  // Persist the new channel so future messages are handled like the other watched channels.
  const added = await addChannel(
    createdChannel.id,
    createdChannel.guildId,
    createdChannel.name,
    "category auto-watch"
  );
  if (added) {
    console.log(`[watchlist] Automatically watching new channel #${createdChannel.name}.`);
  }
});

// Set the bot's activity status and log when it's ready.
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
