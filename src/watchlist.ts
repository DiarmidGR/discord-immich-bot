import { promises as fs } from "node:fs";
import path from "node:path";
import { config } from "./config.js";

interface WatchlistEntry {
  channelId: string;
  channelName: string;
  addedBy: string;
  addedAt: string;
}

let entries = new Map<string, WatchlistEntry>();
let loaded = false;

async function ensureLoaded(): Promise<void> {
  if (loaded) return;
  loaded = true;
  try {
    const raw = await fs.readFile(config.watchlistPath, "utf-8");
    const parsed = JSON.parse(raw) as WatchlistEntry[];
    entries = new Map(parsed.map((e) => [e.channelId, e]));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      console.error(`[watchlist] Failed to read ${config.watchlistPath}:`, err);
    }
    entries = new Map();
  }
}

async function persist(): Promise<void> {
  await fs.mkdir(path.dirname(config.watchlistPath), { recursive: true });
  await fs.writeFile(
    config.watchlistPath,
    JSON.stringify([...entries.values()], null, 2),
    "utf-8"
  );
}

export async function isDynamicallyWatched(channelId: string): Promise<boolean> {
  await ensureLoaded();
  return entries.has(channelId);
}

/** Returns false if the channel was already being watched. */
export async function addChannel(
  channelId: string,
  channelName: string,
  addedBy: string
): Promise<boolean> {
  await ensureLoaded();
  if (entries.has(channelId)) return false;
  entries.set(channelId, { channelId, channelName, addedBy, addedAt: new Date().toISOString() });
  await persist();
  return true;
}

/** Returns false if the channel wasn't in the dynamic watchlist to begin with. */
export async function removeChannel(channelId: string): Promise<boolean> {
  await ensureLoaded();
  if (!entries.has(channelId)) return false;
  entries.delete(channelId);
  await persist();
  return true;
}

export async function listDynamicChannels(): Promise<WatchlistEntry[]> {
  await ensureLoaded();
  return [...entries.values()];
}
