import { Client, GatewayIntentBits, Events, Attachment, TextChannel } from "discord.js";
import { config } from "./config.js";
import { addAssetsToAlbum, getOrCreateAlbumId, uploadAsset } from "./immich.js";

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
  const albumId = await getOrCreateAlbumId(albumName);
  await addAssetsToAlbum(albumId, [upload.id]);

  console.log(
    `[sync] #${channelName} -> "${albumName}": ${attachment.name} (${upload.status})`
  );
}

client.on(Events.MessageCreate, async (message) => {
  if (!config.watchedChannelIds.has(message.channelId)) return;
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

client.once(Events.ClientReady, (readyClient) => {
  console.log(`Logged in as ${readyClient.user.tag}`);
  console.log(`Watching ${config.watchedChannelIds.size} channel(s): ${[...config.watchedChannelIds].join(", ")}`);
});

client.login(config.discordToken);
