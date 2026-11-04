# LAABS Companion

A small, self-hosted service for [LAABS Audio](../laabs_audio), the iOS client for Audiobookshelf. It stores each user's bookmarks and clips as a hidden **Bookmark Sidecar** file in the Audiobookshelf item folder:

```
<item folder>/.laabs.bookmarks.<absUserId>.json
```

The bookmarks live with the book. They survive an Audiobookshelf database rebuild, folder renames, and moves. LAABS Audio works fine without the Companion; with it, bookmarks and clips sync between your devices.

- **No database and no accounts of its own.** Every request carries the user's Audiobookshelf token. The Companion forwards it to Audiobookshelf (`/api/me` and `/api/items/:id`), so a user can only reach their own sidecar for items they can already open. Admins get no extra access.
- **Invisible to Audiobookshelf.** Dotfiles are skipped by the Audiobookshelf scanner and watcher, so sidecars never show up as library files and never trigger rescans.
- **Safe writes.** Item folders are resolved with `realpath` and must be inside `LIBRARY_ROOTS`. Writes go to a temp dotfile that is then renamed over the target, with one lock per file. A replace keeps the previous file as `.laabs.bookmarks.<absUserId>.<timestamp>.bak.json`.

The design is recorded in LAABS Audio's ADR-0046 and `BookmarkSidecarImplementationPlan.md`. `src/shared/` is copied verbatim from LAABS Audio (`src/bookmark-sidecar/sidecar-format.ts`, `sidecar-merge.ts`), so the device and the Companion merge in the same way. Keep the two copies identical.

## How LAABS Audio finds it

The app first probes `<your Audiobookshelf URL>/laabs/health`, so the easiest setup puts the Companion behind the reverse proxy you already use for Audiobookshelf, at `/laabs`. If your Audiobookshelf URL has a path (for example `https://example.com/audiobookshelf`), the Companion belongs at `https://example.com/audiobookshelf/laabs`.

If that doesn't suit you, enter any URL in LAABS Audio under **Settings → LAABS Companion**.

## Configuration

| Variable | Required | Default | Meaning |
|---|---|---|---|
| `ABS_INTERNAL_URL` | yes | | How the Companion reaches Audiobookshelf, for example `http://audiobookshelf:80` or `http://127.0.0.1:13378`. |
| `LIBRARY_ROOTS` | yes | | Library folders the Companion may write into, as the Companion sees them. Separate them with `:` on Linux/macOS, `;` on Windows, or `\|` on any platform. |
| `PATH_MAPPINGS` | no | | Needed only when the Companion sees the media at different paths than Audiobookshelf reports. The format is `absPath=localPath`, with entries separated by `\|`, for example `/audiobooks=D:\Media\Audiobooks\|/podcasts=D:\Media\Podcasts`. |
| `PORT` | no | `8787` | Listening port. |
| `HOST` | no | `0.0.0.0` | Listening address. |
| `BASE_PATH` | no | | Set to `/laabs` only if your proxy forwards `/laabs/...` without stripping the prefix. |
| `ME_CACHE_TTL_SECONDS` | no | `300` | How long the user returned by `/api/me` is cached per token. |
| `ABS_TIMEOUT_MS` | no | `10000` | Timeout for each Audiobookshelf request. |
| `MAX_BODY_BYTES` | no | `5242880` | Maximum request body size. |

The paths matter. Audiobookshelf reports each item's absolute folder (for example `/audiobooks/Frank Herbert/Dune`), and the Companion writes the sidecar there. The Companion therefore has to see the same folder at the same path, or at a path you map with `PATH_MAPPINGS`. It must also have **write** access to it.

## Docker (recommended)

For a full walkthrough, see [docs/docker.md](docs/docker.md). It covers Compose layouts, `docker run`, permissions, network shares, testing on a Mac, and troubleshooting.

Copy `docker-compose.example.yml` and give the Companion **exactly the media volume lines Audiobookshelf has**, read-write (no `:ro`):

```yaml
  laabs-companion:
    build: .
    user: "1000:1000"            # the owner of your media files
    volumes:
      - ./audiobooks:/audiobooks
      - ./podcasts:/podcasts
    environment:
      - ABS_INTERNAL_URL=http://audiobookshelf:80
      - LIBRARY_ROOTS=/audiobooks:/podcasts
```

```bash
docker compose up -d --build
```

Don't publish the port. Put the Companion behind your reverse proxy as described next. The image runs as the `node` user (uid 1000) by default. Set `user:` to whoever owns your media, or the Companion won't be able to create sidecars.

## Reverse proxy at `<ABS host>/laabs`

Add a `/laabs` route next to Audiobookshelf's route that strips the prefix. It must be matched **before** the catch-all route to Audiobookshelf. The Companion only serves JSON over plain HTTP requests, so it doesn't need websockets.

**nginx.** The trailing slashes on both lines strip `/laabs`:

```nginx
location /laabs/ {
    proxy_pass http://laabs-companion:8787/;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    client_max_body_size 5m;
}

location / {
    proxy_pass http://audiobookshelf:80;
    # ... your existing Audiobookshelf settings (websocket upgrade headers, etc.)
}
```

**Caddy:**

```caddy
abs.example.com {
    handle_path /laabs/* {
        reverse_proxy laabs-companion:8787
    }
    handle {
        reverse_proxy audiobookshelf:80
    }
}
```

**Traefik** (labels on the Companion service):

```yaml
    labels:
      - traefik.enable=true
      - traefik.http.routers.laabs.rule=Host(`abs.example.com`) && PathPrefix(`/laabs`)
      - traefik.http.routers.laabs.priority=100
      - traefik.http.routers.laabs.middlewares=laabs-strip
      - traefik.http.middlewares.laabs-strip.stripprefix.prefixes=/laabs
      - traefik.http.services.laabs.loadbalancer.server.port=8787
```

**Nginx Proxy Manager.** On the Audiobookshelf proxy host, add a *Custom location* `/laabs/` that forwards to `laabs-companion` port `8787`. In the location's advanced field, add `proxy_pass http://laabs-companion:8787/;` so the prefix is stripped.

If your proxy can't strip a prefix, set `BASE_PATH=/laabs` on the Companion instead.

To check the route, open `https://abs.example.com/laabs/health`. It should return:

```json
{ "service": "laabs-companion", "apiVersion": 1, "schemaVersions": [1] }
```

## Bare metal

You need Node.js 20 or newer.

```bash
git clone <this repo> laabs-companion
cd laabs-companion
npm ci
npm run build
```

### Linux (systemd)

Run the Companion as the user that owns the media, often the same user Audiobookshelf runs as. Create `/etc/systemd/system/laabs-companion.service`:

```ini
[Unit]
Description=LAABS Companion
After=network-online.target audiobookshelf.service

[Service]
User=audiobookshelf
WorkingDirectory=/opt/laabs-companion
Environment=ABS_INTERNAL_URL=http://127.0.0.1:13378
Environment=LIBRARY_ROOTS=/srv/media/audiobooks:/srv/media/podcasts
Environment=HOST=127.0.0.1
Environment=PORT=8787
ExecStart=/usr/bin/node dist/index.js
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
```

```bash
sudo systemctl enable --now laabs-companion
```

If Audiobookshelf runs in Docker but the Companion runs on the host, Audiobookshelf reports container paths such as `/audiobooks/...`. Map them to host paths:

```ini
Environment=PATH_MAPPINGS=/audiobooks=/srv/media/audiobooks|/podcasts=/srv/media/podcasts
```

Then point your reverse proxy's `/laabs/` route at `http://127.0.0.1:8787/`.

### Windows

1. Install Node.js 20+ LTS from nodejs.org, then run `npm ci` and `npm run build` in the Companion folder.
2. Try it in PowerShell:

   ```powershell
   $env:ABS_INTERNAL_URL = "http://127.0.0.1:13378"
   $env:LIBRARY_ROOTS = "D:\Media\Audiobooks;D:\Media\Podcasts"
   $env:HOST = "127.0.0.1"
   node dist\index.js
   ```

   If Audiobookshelf runs in Docker Desktop, it reports container paths. Add a mapping:
   `$env:PATH_MAPPINGS = "/audiobooks=D:\Media\Audiobooks|/podcasts=D:\Media\Podcasts"`.
3. To run it as a service, use [NSSM](https://nssm.cc/): `nssm install LAABSCompanion "C:\Program Files\nodejs\node.exe" "C:\laabs-companion\dist\index.js"`. Set the working directory, add the variables above under *Environment*, and choose an account that can write to the media folders.
4. Add the `/laabs/` route to whatever proxies Audiobookshelf (IIS with URL Rewrite/ARR, Caddy, or nginx for Windows), pointing at `http://127.0.0.1:8787/`.

On Windows, renaming over a file that another program (an indexer or antivirus) has open can fail briefly, so the Companion retries those renames.

Run **one** Companion per library. Locks are held in memory, so two instances writing the same folders could overwrite each other.

## API (v1)

Every `/v1` request needs `Authorization: Bearer <Audiobookshelf access token>`.

| Method | Path | Result |
|---|---|---|
| `GET` | `/health` | `{ service, apiVersion: 1, schemaVersions: [1] }`. No auth. |
| `GET` | `/v1/items/:libraryItemId/bookmarks` | `200` with the sidecar, or `404 no_sidecar`. |
| `PUT` | `/v1/items/:libraryItemId/bookmarks` | Body `{ mediaKind, item, audioFingerprint, episodeFingerprints?, records }`. Merges records per record by `updatedAt` (on a tie the deletion wins, otherwise the stored copy). Returns the stored document. |
| `PUT` | `/v1/items/:libraryItemId/bookmarks?mode=replace` | Replaces `records` after backing up the current file as a `.bak.json` dotfile. |

On every write, the Companion sets `schemaVersion`, `absUserId`, `username`, `libraryItemId`, `mediaKind`, `item`, `audioFingerprint`, `episodeFingerprints`, `updatedAt` and `records`. Every other field, whether on the file, in the body, or on individual records, is preserved.

**Sidecar Adoption.** After an Audiobookshelf rebuild, user ids change. When a user has no sidecar in a folder but exactly one other `.laabs.bookmarks.*.json` there has the same username (compared without case), the Companion renames that file to the new id and keeps using it.

**Errors** come back as `{ "error": "<code>", "message": "..." }`:

| Status | Codes |
|---|---|
| `401` | `missing_token`, `invalid_token` |
| `403` | `no_access` (Audiobookshelf denies the item), `path_not_allowed` (the folder is outside `LIBRARY_ROOTS`) |
| `404` | `no_sidecar`, `item_not_found`, `not_found` |
| `409` | `unsupported_item` (single-file item, which has no folder), `unsupported_schema` (the file was written by a newer schema) |
| `413` | `body_too_large` |
| `422` | `invalid_body`, `invalid_mode` |
| `500` | `item_folder_missing` (check your mounts or `PATH_MAPPINGS`), `sidecar_unreadable` (corrupt JSON; a `mode=replace` backs it up and overwrites it) |
| `502` | `abs_unreachable`, `abs_error` |

## Development

```bash
npm install
npm test          # unit + integration tests against a mocked Audiobookshelf
npm run build     # compiles to dist/
npm run typecheck
```
