# discord-immich-bot

Watches a set of Discord text channels; any image someone posts there gets
downloaded and uploaded to an Immich server, into an album named after the
channel (auto-created if it doesn't exist yet). After each successful sync,
the bot replies with a public link to that channel's album.

## Setup

1. **Create the Discord bot**
   - Go to https://discord.com/developers/applications -> New Application.
   - Bot tab -> Reset Token, copy it for `DISCORD_TOKEN`.
   - Bot tab -> enable **Message Content Intent** (required to read attachments).
   - OAuth2 -> URL Generator -> scope: `bot`. Bot permissions: `View Channels`,
     `Send Messages`, `Read Message History`, and `Add Reactions` (used to flag
     failed uploads). Use the generated URL to invite the bot to your server.
   - Users who run `watch`, `backfill`, or `unwatch` need the **Manage Channels**
     permission; the bot itself does not need it.
   - The `gallery` command is intentionally available to any user in a watched
     channel, regardless of Discord permissions.

2. **Get an Immich API key**
   - In the Immich web UI: Account Settings -> API Keys -> New API Key.
   - Grant the key these permissions:
     - `asset.upload` to upload attachments.
     - `album.read` to find existing channel albums.
     - `album.create` to create channel albums that do not exist yet.
     - `album.update` to add uploaded assets to channel albums.
     - `sharedLink.create` to create public album links for the `gallery` command.
    - Grant `sharedLink.read` too if you want the bot to reuse existing links after
     a restart; without it, the bot creates a new link once per album per run.

3. **Get your channel IDs**
   - Discord app -> User Settings -> Advanced -> enable Developer Mode.
   - Right-click each channel you want watched -> Copy Channel ID.

4. **Configure**
    ```bash
    cp .env.example .env
    # then fill in DISCORD_TOKEN, WATCHED_CHANNEL_IDS, IMMICH_URL, and IMMICH_API_KEY
    ```

5. **Run locally**
   ```bash
   npm install
   npm run dev      # ts-node style, for testing
   # or, for a persistent deployment:
   npm run build
   npm start
   ```

### Docker deployment

For a production deployment, create a `.env` file in the same directory as
`docker-compose.yml` with the required values. The Compose example below
builds the image locally:

```dotenv
DISCORD_TOKEN=your-discord-token
WATCHED_CHANNEL_IDS=channel-id-1,channel-id-2
IMMICH_URL=https://immich.example.com
IMMICH_API_KEY=your-immich-api-key
```

The optional settings below can also be added to `.env`:

```dotenv
CHANNEL_ALBUM_OVERRIDES={}
MIN_IMAGE_BYTES=0
MAX_MEDIA_BYTES=0
COMMAND_PREFIX=!immich-bot
```

Save this as `docker-compose.yml`:

```yaml
services:
  discord-immich-bot:
    build: .
    container_name: discord-immich-bot
    restart: unless-stopped
    environment:
      - DISCORD_TOKEN=${DISCORD_TOKEN}
      - WATCHED_CHANNEL_IDS=${WATCHED_CHANNEL_IDS:-}
      - IMMICH_URL=${IMMICH_URL}
      - IMMICH_API_KEY=${IMMICH_API_KEY}
      - CHANNEL_ALBUM_OVERRIDES=${CHANNEL_ALBUM_OVERRIDES:-{}}
      - MIN_IMAGE_BYTES=${MIN_IMAGE_BYTES:-0}
      - MAX_MEDIA_BYTES=${MAX_MEDIA_BYTES:-0}
      - COMMAND_PREFIX=${COMMAND_PREFIX:-!immich-bot}
    volumes:
      - immich_bot_data:/data

volumes:
  immich_bot_data:
```

If you publish the image to your own registry, replace `build: .` with an
`image` entry, for example:

```yaml
    image: your-registry.example/discord-immich-bot:latest
```

Build or pull the image and start the bot in the background:

```bash
# With build: .
docker compose up -d --build

# With image: your-registry.example/discord-immich-bot:latest
docker compose pull
docker compose up -d
```

View logs with `docker compose logs -f`, and stop the deployment with
`docker compose down`. The named `immich_bot_data` volume keeps the runtime
watchlist when the container is recreated or updated.

## How album naming works

By default the album name is the Discord channel name with hyphens/underscores
turned into spaces and title-cased (`community-pics` -> `Community Pics`).

To override this per-channel, set `CHANNEL_ALBUM_OVERRIDES` in `.env` to a
JSON object mapping channel ID -> desired album name, e.g.:
```
CHANNEL_ALBUM_OVERRIDES={"123456789012345678":"Family Photos"}
```

## Commands

Users can use the configured command prefix in a server text channel. The
`gallery` command is available to any user, while management commands remain
restricted to users with the **Manage Channels** permission:

- `watch` starts syncing new images and videos from the channel where the
  command is sent and offers the `backfill` command for existing media.
- `watch <channel-id>` or `watch #general` or `watch general` starts syncing the
  specified text channel instead. The target channel must be in the same server
  as the command.
- `watch <category-id>` or `watch #category-name` starts syncing all text channels
  directly inside the specified category. The category must be in the same
  server as the command. New text channels created directly inside a watched
  category are added automatically.
- `backfill` scans the command channel's history and uploads its existing images
  and videos into the channel's Immich album.
- `backfill <channel-id>` or `backfill #general` or `backfill general` scans the
  specified watched text channel instead. The target channel must be in the same
  server as the command.
- `backfill <category-id>` scans all watched text channels directly inside the
  specified category. The category must be in the same server as the command.
- `list` shows watched channels in the current server.
- `gallery` replies with a public link to the current channel's album.
- `gallery <channel-id>` or `gallery #general` or `gallery general` replies with
  a public link to that watched channel's album instead.
- `unwatch` stops runtime watching for the command channel.
- `unwatch <channel-id>` or `unwatch #general` or `unwatch general` stops runtime
  watching for the specified text channel. The target channel must be in the
  same server as the command.
- `unwatch <category-id>` stops runtime watching for all text channels directly
  inside the specified category. Static `WATCHED_CHANNEL_IDS` entries are not
  removed.

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
- The bot creates or reuses a public share link when someone uses `gallery`.
  Anyone with the link can view the album.
- Running this continuously means keeping a Node process alive — pm2, a
  systemd service, or Docker all work well.
- Immich's API has changed across versions before; if uploads start failing
  with 4xx errors after an Immich upgrade, check your server's own API docs
  at `<your-immich-url>/api/docs` — endpoint field names occasionally shift.

## Future goals / ideas

- A way to stream-line user configuration within the discord app itself would
  be nice, like inputting API keys and perhaps the Immich server URL.
- Greater indicator of what work is being done in the background while the bot
  is backfilling.