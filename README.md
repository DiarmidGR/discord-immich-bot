# discord-immich-bot

Watches a set of Discord text channels; any image someone posts there gets
downloaded and uploaded to an Immich server, into an album named after the
channel (auto-created if it doesn't exist yet).

## Setup

1. **Create the Discord bot**
   - Go to https://discord.com/developers/applications -> New Application.
   - Bot tab -> Reset Token, copy it for `DISCORD_TOKEN`.
   - Bot tab -> enable **Message Content Intent** (required to read attachments).
   - OAuth2 -> URL Generator -> scopes: `bot`. Permissions: `View Channels`,
     `Read Message History`, `Add Reactions` (used to flag failed uploads).
     Use the generated URL to invite the bot to your server.

2. **Get an Immich API key**
   - In the Immich web UI: Account Settings -> API Keys -> New API Key.

3. **Get your channel IDs**
   - Discord app -> User Settings -> Advanced -> enable Developer Mode.
   - Right-click each channel you want watched -> Copy Channel ID.

4. **Configure**
   ```bash
   cp .env.example .env
   # then fill in DISCORD_TOKEN, WATCHED_CHANNEL_IDS, IMMICH_URL, IMMICH_API_KEY
   ```

5. **Run**
   ```bash
   npm install
   npm run dev      # ts-node style, for testing
   # or, for a persistent deployment:
   npm run build
   npm start
   ```

## How album naming works

By default the album name is the Discord channel name with hyphens/underscores
turned into spaces and title-cased (`community-pics` -> `Community Pics`).

To override this per-channel, set `CHANNEL_ALBUM_OVERRIDES` in `.env` to a
JSON object mapping channel ID -> desired album name, e.g.:
```
CHANNEL_ALBUM_OVERRIDES={"123456789012345678":"Family Photos"}
```

## Commands

Users with the **Manage Channels** permission can use the configured command
prefix in a watched text channel:

- `watch` starts syncing new images and videos from the channel and offers the
  `backfill` command for existing media.
- `backfill` scans the channel history and uploads its existing images and
  videos into the channel's Immich album.
- `unwatch` stops runtime watching, and `list` shows watched channels.

Backfill continues when an individual attachment fails and reports the failed
count when it finishes. Immich's stable asset IDs make rerunning it safe.

## Notes / things worth knowing

- Only channels listed in `WATCHED_CHANNEL_IDS` are touched — the bot ignores
  everything else, including DMs.
- Non-image attachments (videos, files) are skipped. If you also want videos,
  it's a one-line change to `isImageAttachment` in `src/index.ts` — Immich's
  upload endpoint handles video the same way.
- If an upload fails (network hiccup, bad Immich credentials, etc.) the bot
  reacts with ⚠️ on the original message so you can spot misses at a glance,
  and logs the error — it doesn't crash or retry automatically.
- Re-uploading the same file (e.g. after restarting the bot) won't create a
  duplicate: Immich dedupes by file checksum server-side.
- Running this continuously means keeping a Node process alive — pm2, a
  systemd service, or a small Docker container all work well. Ask if you'd
  like a Dockerfile or systemd unit for your setup.
- Immich's API has changed across versions before; if uploads start failing
  with 4xx errors after an Immich upgrade, check your server's own API docs
  at `<your-immich-url>/api/docs` — endpoint field names occasionally shift.
