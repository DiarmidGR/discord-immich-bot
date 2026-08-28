import "dotenv/config";

function required(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === "") {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function parseChannelOverrides(raw: string | undefined): Record<string, string> {
  if (!raw || raw.trim() === "") return {};
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("CHANNEL_ALBUM_OVERRIDES must be a JSON object");
    }
    return parsed as Record<string, string>;
  } catch (err) {
    throw new Error(
      `Failed to parse CHANNEL_ALBUM_OVERRIDES as JSON: ${(err as Error).message}`
    );
  }
}

export const config = {
  discordToken: required("DISCORD_TOKEN"),
  watchedChannelIds: new Set(
    required("WATCHED_CHANNEL_IDS")
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean)
  ),
  immich: {
    baseUrl: required("IMMICH_URL").replace(/\/+$/, ""),
    apiKey: required("IMMICH_API_KEY"),
  },
  channelAlbumOverrides: parseChannelOverrides(process.env.CHANNEL_ALBUM_OVERRIDES),
  minImageBytes: Number(process.env.MIN_IMAGE_BYTES ?? "0"),
  maxMediaBytes: Number(process.env.MAX_MEDIA_BYTES ?? "0"),
};

if (config.watchedChannelIds.size === 0) {
  throw new Error("WATCHED_CHANNEL_IDS must contain at least one channel ID");
}
