import { config } from "./config.js";

const API_BASE = `${config.immich.baseUrl}/api`;

function authHeaders(extra?: Record<string, string>): Record<string, string> {
  return {
    "x-api-key": config.immich.apiKey,
    Accept: "application/json",
    ...extra,
  };
}

async function immichFetch(path: string, init: RequestInit): Promise<Response> {
  const res = await fetch(`${API_BASE}${path}`, init);
  if (!res.ok) {
    const body = await res.text().catch(() => "<no body>");
    throw new Error(`Immich ${init.method ?? "GET"} ${path} failed: ${res.status} ${body}`);
  }
  return res;
}

interface ImmichAlbum {
  id: string;
  albumName: string;
}

interface UploadResult {
  id: string;
  status: "created" | "duplicate";
}

/**
 * Uploads a single image buffer to Immich.
 * deviceAssetId should be stable/unique per source file so re-processing the
 * same Discord attachment (e.g. after a bot restart) doesn't create dupes.
 */
export async function uploadAsset(params: {
  buffer: Buffer;
  filename: string;
  mimeType: string;
  deviceAssetId: string;
  createdAt: Date;
}): Promise<UploadResult> {
  const form = new FormData();
  const bytes = new Uint8Array(params.buffer);
  const blob = new Blob([bytes], { type: params.mimeType });
  form.set("assetData", blob, params.filename);
  form.set("deviceAssetId", params.deviceAssetId);
  form.set("deviceId", "discord-image-sync");
  form.set("fileCreatedAt", params.createdAt.toISOString());
  form.set("fileModifiedAt", params.createdAt.toISOString());

  const res = await immichFetch("/assets", {
    method: "POST",
    headers: authHeaders(),
    body: form,
  });

  const data = (await res.json()) as { id: string; status: UploadResult["status"] };
  return { id: data.id, status: data.status };
}

async function listAlbums(): Promise<ImmichAlbum[]> {
  const res = await immichFetch("/albums", {
    method: "GET",
    headers: authHeaders(),
  });
  return (await res.json()) as ImmichAlbum[];
}

async function createAlbum(albumName: string): Promise<ImmichAlbum> {
  const res = await immichFetch("/albums", {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ albumName }),
  });
  return (await res.json()) as ImmichAlbum;
}

export async function addAssetsToAlbum(albumId: string, assetIds: string[]): Promise<void> {
  await immichFetch(`/albums/${albumId}/assets`, {
    method: "PUT",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ ids: assetIds }),
  });
}

// In-memory cache so we don't hit /albums on every single image.
const albumIdByName = new Map<string, string>();

export async function getOrCreateAlbumId(albumName: string): Promise<string> {
  const cached = albumIdByName.get(albumName);
  if (cached) return cached;

  const albums = await listAlbums();
  const existing = albums.find((a) => a.albumName === albumName);
  if (existing) {
    albumIdByName.set(albumName, existing.id);
    return existing.id;
  }

  const created = await createAlbum(albumName);
  albumIdByName.set(albumName, created.id);
  return created.id;
}
