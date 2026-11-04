# Running the LAABS Companion with Docker

This guide covers running the Companion with `docker run` and with Docker Compose. Here's what it covers:

1. [Before you start](#before-you-start)
2. [The rule that matters: matching paths](#the-rule-that-matters-matching-paths)
3. [Build the image](#build-the-image)
4. [Docker Compose](#docker-compose)
5. [docker run](#docker-run)
6. [File ownership and permissions](#file-ownership-and-permissions)
7. [Reverse proxy](#reverse-proxy)
8. [Connect LAABS Audio](#connect-laabs-audio)
9. [Check that it works](#check-that-it-works)
10. [Testing on a Mac with OrbStack or Docker Desktop](#testing-on-a-mac-with-orbstack-or-docker-desktop)
11. [Updating](#updating)
12. [Troubleshooting](#troubleshooting)

For what the Companion does and its full list of settings, see the [README](../README.md).

## Before you start

You need:

- **Docker:** Docker Engine with the Compose plugin (`docker compose`), or Docker Desktop or OrbStack on a Mac.
- **Audiobookshelf:** a running server that the Companion can reach over the network.
- **Your media folders:** write access to the folders that hold your Audiobookshelf libraries, on the machine that runs the Companion. The Companion writes its files next to your audio files.
- **Optional, a reverse proxy** in front of Audiobookshelf (nginx, Caddy, Traefik, Nginx Proxy Manager…). LAABS Audio finds the Companion on its own when it's served at `<your Audiobookshelf URL>/laabs`. Without a proxy, you enter the Companion's URL in the app by hand.

The Companion stores nothing except one hidden file per user in each book's folder:

```
<book folder>/.laabs.bookmarks.<absUserId>.json
```

It has no database and no volume of its own to back up.

## The rule that matters: matching paths

Most setup problems come from this.

When LAABS Audio syncs a book, the Companion asks Audiobookshelf for that book's details. Audiobookshelf answers with the book's **absolute folder path, as Audiobookshelf sees it**. For example:

```json
"path": "/audiobooks/Nonfiction/Cal Newport/Deep Work"
```

The Companion writes the sidecar into that folder. So **inside the Companion's container, that exact path has to exist and be writable.** There are three ways to arrange that.

### Option A: mount the same folder at the same path (recommended)

Give the Companion the same media volume lines as your Audiobookshelf container, without `:ro`:

```yaml
# Audiobookshelf
volumes:
  - /srv/media/audiobooks:/audiobooks

# Companion: identical
volumes:
  - /srv/media/audiobooks:/audiobooks
```

No `PATH_MAPPINGS` needed.

### Option B: mount at the path Audiobookshelf reports, from a different host path

The Companion may run on a different machine from Audiobookshelf. For example, Audiobookshelf runs on a NAS and you test the Companion on a laptop that has the share mounted. The host path is then different, but you can still mount it at the path Audiobookshelf reports:

```yaml
volumes:
  # Host path on this machine  :  path Audiobookshelf reports
  - /Volumes/Audiobooks/audiobookshelf/audiobooks:/mnt/wd14/audiobooks/audiobookshelf/audiobooks
environment:
  - LIBRARY_ROOTS=/mnt/wd14/audiobooks/audiobookshelf/audiobooks
```

### Option C: mount anywhere and translate with `PATH_MAPPINGS`

```yaml
volumes:
  - /Volumes/Audiobooks/audiobookshelf/audiobooks:/audiobooks
environment:
  - LIBRARY_ROOTS=/audiobooks
  - PATH_MAPPINGS=/mnt/wd14/audiobooks/audiobookshelf/audiobooks=/audiobooks
```

`PATH_MAPPINGS` replaces the prefix Audiobookshelf reports (left of `=`) with the path inside the container (right of `=`). Separate several mappings with `|`. If more than one prefix matches, the longest one is used.

### Finding the path Audiobookshelf reports

You can find it in either of two ways.

- **In the Audiobookshelf web UI:** go to **Settings → Libraries**, edit a library, and look at its **Folders**. Those are the library roots as Audiobookshelf sees them.
- **From the API, for one book:** this is the most reliable, because it is exactly what the Companion receives. Take the item id from the book's URL in the web UI (`/item/<id>`) and your API token from **Settings → Users → your user**:

  ```bash
  curl -s -H "Authorization: Bearer <token>" "https://abs.example.com/api/items/<id>" | python3 -c "import sys,json; print(json.load(sys.stdin)['path'])"
  ```

Subfolders such as `Fiction/` and `Nonfiction/` need no special handling. Map or mount the folder above them, and everything inside follows.

### `LIBRARY_ROOTS`

`LIBRARY_ROOTS` lists the folders the Companion may write into, **as the container sees them** (after any mapping). The Companion refuses to write anywhere else, including through symlinks that point outside these folders.

- **Several roots:** separate them with `:` or `|`, for example `LIBRARY_ROOTS=/audiobooks:/podcasts`.
- **A parent folder is fine:** a book only has to be somewhere inside a root, not directly in it. One root above `Fiction/` and `Nonfiction/` covers both.
- **Every root must exist when the container starts,** or the Companion exits with `Library root "…" is not an accessible folder`.

## Build the image

No published image exists yet, so build it from this repository:

```bash
git clone <this repo> laabs-companion
```

```bash
cd laabs-companion
```

```bash
docker build -t laabs-companion .
```

The image:

- uses `node:22-alpine` and has no runtime dependencies.
- listens on port `8787` (`HOST=0.0.0.0`, `PORT=8787`).
- runs as the `node` user (uid/gid `1000`) by default. See [File ownership and permissions](#file-ownership-and-permissions).
- has a built-in `HEALTHCHECK` that calls `/health` every 60 seconds, so `docker ps` shows `healthy` or `unhealthy`.

## Docker Compose

### Same Compose file as Audiobookshelf (recommended)

This is the simplest setup. Both containers share a network, so the Companion reaches Audiobookshelf by its service name, and the volume lines can be copied directly.

```yaml
services:
  audiobookshelf:
    image: ghcr.io/advplyr/audiobookshelf:latest
    ports:
      - "13378:80"
    volumes:
      - /srv/media/audiobooks:/audiobooks
      - /srv/media/podcasts:/podcasts
      - ./config:/config
      - ./metadata:/metadata
    environment:
      - TZ=America/Toronto
    restart: unless-stopped

  laabs-companion:
    build: ./laabs-companion        # path to this repository
    image: laabs-companion:latest
    user: "1000:1000"               # owner of your media files
    volumes:
      # Same host folders, same container paths as Audiobookshelf, read-write.
      - /srv/media/audiobooks:/audiobooks
      - /srv/media/podcasts:/podcasts
    environment:
      - ABS_INTERNAL_URL=http://audiobookshelf:80
      - LIBRARY_ROOTS=/audiobooks:/podcasts
      # - PATH_MAPPINGS=/abs/path=/container/path   # only if paths differ
      # - BASE_PATH=/laabs                          # only if your proxy doesn't strip /laabs
    # No published port: put it behind the reverse proxy at /laabs.
    # For a quick test without a proxy, uncomment:
    # ports:
    #   - "8787:8787"
    depends_on:
      - audiobookshelf
    restart: unless-stopped
```

Start it:

```bash
docker compose up -d --build
```

Follow the logs:

```bash
docker compose logs -f laabs-companion
```

[`docker-compose.example.yml`](../docker-compose.example.yml) in this repository has the same layout.

### Separate Compose file, same host

If you'd rather not edit your Audiobookshelf Compose file, run the Companion in its own project and attach it to Audiobookshelf's network.

First find the network name. It's usually `<folder name>_default`:

```bash
docker network ls
```

Then create `docker-compose.yml` in the Companion folder:

```yaml
services:
  laabs-companion:
    build: .
    image: laabs-companion:latest
    user: "1000:1000"
    volumes:
      - /srv/media/audiobooks:/audiobooks
    environment:
      - ABS_INTERNAL_URL=http://audiobookshelf:80   # the ABS service or container name
      - LIBRARY_ROOTS=/audiobooks
    networks:
      - abs
    restart: unless-stopped

networks:
  abs:
    external: true
    name: audiobookshelf_default   # from `docker network ls`
```

Your reverse proxy also has to reach the Companion. Attach the proxy to the same network, or publish the port (`ports: ["127.0.0.1:8787:8787"]`) and proxy to `127.0.0.1:8787`.

### Companion on a different machine from Audiobookshelf

Point `ABS_INTERNAL_URL` at any URL that reaches Audiobookshelf from the Companion. A LAN address is best, for example `http://192.168.1.20:13378`, but the public URL works too. Then use [option B or C](#the-rule-that-matters-matching-paths) so the paths Audiobookshelf reports exist in the container.

```yaml
services:
  laabs-companion:
    build: .
    image: laabs-companion:latest
    ports:
      - "8787:8787"
    volumes:
      - /mnt/nas/audiobooks:/audiobooks
    environment:
      - ABS_INTERNAL_URL=http://192.168.1.20:13378
      - LIBRARY_ROOTS=/audiobooks
      - PATH_MAPPINGS=/audiobooks=/audiobooks   # adjust if ABS reports a different prefix
    restart: unless-stopped
```

Writing to network shares (SMB or NFS) works. See [Network shares](#network-shares-smb-nfs).

## docker run

These commands do the same as the Compose files above. The image name is `laabs-companion`, from the build step.

**Same host as Audiobookshelf, on its Docker network:**

```bash
docker run -d --name laabs-companion --restart unless-stopped --network audiobookshelf_default --user 1000:1000 -v /srv/media/audiobooks:/audiobooks -e ABS_INTERNAL_URL=http://audiobookshelf:80 -e LIBRARY_ROOTS=/audiobooks laabs-companion
```

**Audiobookshelf elsewhere, port published, with a path mapping:**

```bash
docker run -d --name laabs-companion --restart unless-stopped -p 8787:8787 -v /mnt/nas/audiobooks:/audiobooks -e ABS_INTERNAL_URL=http://192.168.1.20:13378 -e LIBRARY_ROOTS=/audiobooks -e "PATH_MAPPINGS=/data/audiobooks=/audiobooks" laabs-companion
```

**In the foreground, to see logs while you test** (Ctrl-C stops and removes it):

```bash
docker run --rm -it --name laabs-companion -p 8787:8787 -v /srv/media/audiobooks:/audiobooks -e ABS_INTERNAL_URL=http://192.168.1.20:13378 -e LIBRARY_ROOTS=/audiobooks laabs-companion
```

Put quotes around `PATH_MAPPINGS` so your shell doesn't read the `|` between mappings as a pipe.

### All environment variables

| Variable | Required | Default | Notes |
|---|---|---|---|
| `ABS_INTERNAL_URL` | yes | | How the container reaches Audiobookshelf. |
| `LIBRARY_ROOTS` | yes | | Folders the Companion may write into, as the container sees them. |
| `PATH_MAPPINGS` | no | | `absPrefix=containerPrefix`, several separated by `\|`. |
| `PORT` | no | `8787` | |
| `HOST` | no | `0.0.0.0` | Keep `0.0.0.0` in Docker. |
| `BASE_PATH` | no | | `/laabs` only if your proxy forwards `/laabs/...` without stripping it. |
| `ME_CACHE_TTL_SECONDS` | no | `300` | How long a token's `/api/me` result is cached. |
| `ABS_TIMEOUT_MS` | no | `10000` | Timeout for each Audiobookshelf request. |
| `MAX_BODY_BYTES` | no | `5242880` | Maximum request body size. |

When it starts, the Companion logs the settings it's using:

```
laabs-companion listening on http://0.0.0.0:8787
Audiobookshelf: http://audiobookshelf:80
Library roots: /audiobooks
Path mapping: /data/audiobooks -> /audiobooks
```

## File ownership and permissions

The Companion creates files in your book folders, so the container's user needs write access to them.

- **Linux hosts:** set `user:` (Compose) or `--user` (`docker run`) to the uid:gid that owns your media. Check it with `ls -ln /srv/media/audiobooks`. The default is `1000:1000`.
- **Unraid:** media is usually owned by `nobody:users`, so use `user: "99:100"`.
- **Synology and other NAS systems:** use the uid and gid of the account that owns the shared folder. Run `id <username>` over SSH to find them.
- **Docker Desktop and OrbStack on macOS:** file sharing writes files as your Mac user, so you can usually leave `user:` out. Your Mac account needs write access to the folder.
- **Read-only mounts don't work.** If you copied Audiobookshelf's volume lines, remove any `:ro`.

New sidecars are created with mode `664`.

### Network shares (SMB, NFS)

If the media lives on a share mounted on the Docker host (CIFS/SMB or NFS), mount the share on the host as usual and bind-mount it into the container. Things to know:

- **Permissions come from the share's mount options,** not from the container's `user:`. For CIFS, set `uid=`, `gid=`, `file_mode=` and `dir_mode=` in the host's mount options so the container's user can write.
- **Some network filesystems refuse `fsync`.** SMB shares passed through Docker Desktop or OrbStack file sharing are one example. The Companion carries on when `fsync` isn't supported, and the write is still atomic, because it writes a temp file and then renames it. The difference is that the newest change could be lost if the server loses power right after a write.
- **Listing a whole share is slow.** Searching an entire SMB library with `find` can take minutes. Check one book folder at a time instead.

## Reverse proxy

LAABS Audio first looks for the Companion at `<your Audiobookshelf URL>/laabs/health`. Serve the Companion there and the app finds it with no setup on the phone.

Add a `/laabs/` route on the same host name as Audiobookshelf. It has to:

- forward to the Companion's port `8787`.
- remove the `/laabs` prefix before forwarding. If your proxy can't, set `BASE_PATH=/laabs` on the Companion instead.
- be matched **before** Audiobookshelf's catch-all `/` route.

The [README](../README.md#reverse-proxy-at-abs-hostlaabs) has ready-made examples for nginx, Caddy, Traefik and Nginx Proxy Manager. With Traefik, the labels go on the Companion service in the Compose file.

If Audiobookshelf has a path in its URL (for example `https://example.com/audiobookshelf`), the Companion belongs at `https://example.com/audiobookshelf/laabs`.

Check the route from outside your network:

```bash
curl https://abs.example.com/laabs/health
```

## Connect LAABS Audio

Open **Settings → LAABS Companion** in LAABS Audio.

- **Behind your proxy at `/laabs`:** leave the URL empty and tap **Save and check**. The status should change to **Connected**.
- **No proxy:** enter the Companion's URL and tap **Save and check**, for example `http://192.168.1.20:8787`. Don't add `/laabs` unless you set `BASE_PATH`. The iOS simulator on the machine running Docker can use `http://localhost:8787`. iOS may block plain `http` on real devices, so prefer HTTPS through your proxy.

On first connection, the app queues every book and podcast that has bookmarks on the device and uploads them. The **Bookmarks on this device** list on the same screen shows each item as **Waiting**, **Synced**, **Failed** (with the error message and a Retry button) or **Needs you**. **Needs you** appears when the audio changed or sync is paused.

## Check that it works

### 1. Health check

```bash
curl -s http://localhost:8787/health
```

```json
{ "service": "laabs-companion", "apiVersion": 1, "schemaVersions": [1] }
```

`docker ps` should also show the container as `(healthy)` about a minute after it starts.

### 2. One book, end to end

With your Audiobookshelf API token and a book's item id:

```bash
curl -s -H "Authorization: Bearer <token>" http://localhost:8787/v1/items/<id>/bookmarks
```

| Response | Meaning |
|---|---|
| `404 no_sidecar` | Everything is working. That book just has no sidecar yet. |
| `200` with JSON | Everything is working, and that book already has a sidecar. |
| `500 item_folder_missing` | The paths don't match. See [Matching paths](#the-rule-that-matters-matching-paths). |
| `403 path_not_allowed` | The folder isn't under `LIBRARY_ROOTS`. |
| `401 invalid_token` | Wrong or expired token. |
| `502 abs_unreachable` | The container can't reach `ABS_INTERNAL_URL`. |

### 3. Look at the file on disk

Add a bookmark to a book in LAABS Audio and let it sync. Then list that book's folder:

```bash
ls -la "/srv/media/audiobooks/Nonfiction/Cal Newport/Deep Work"
```

```
.laabs.bookmarks.41acc6f3-f692-42ec-8c4d-0861f11a931d.json
```

The name starts with a dot, so Finder, Windows Explorer and plain `ls` hide it. To show hidden files:

- **macOS Finder:** press **Cmd+Shift+.**
- **Windows Explorer:** **View → Show → Hidden items**.
- **Terminal:** use `ls -la`.

Audiobookshelf ignores dotfiles too, so sidecars never show up as library files or trigger a rescan.

The file contains the Audiobookshelf user and item, the book's title, author and ASIN, an audio fingerprint, and your bookmarks:

```json
{
  "schemaVersion": 1,
  "absUserId": "41acc6f3-…",
  "username": "mark",
  "libraryItemId": "029a37d6-…",
  "mediaKind": "book",
  "item": { "title": "Deep Work", "author": "Cal Newport", "asin": "B0189PX1RQ", "relPath": "Cal Newport/Deep Work" },
  "audioFingerprint": { "durationSeconds": 27884, "trackCount": 9 },
  "records": [
    { "id": "bookmark_…", "kind": "point", "startTimeSeconds": 25, "title": "Bookmark 1", "updatedAt": 1793590732544, "deletedAt": null }
  ]
}
```

When the app replaces a sidecar instead of merging into it (for example, after the book's audio changed), the previous file is kept beside it as `.laabs.bookmarks.<absUserId>.<timestamp>.bak.json`.

## Testing on a Mac with OrbStack or Docker Desktop

You can try the Companion on a Mac against your real Audiobookshelf server before deploying it next to Audiobookshelf. Mount the library share in Finder first (for example `smb://nas/Audiobooks`, which appears under `/Volumes/Audiobooks`).

1. **Find the path Audiobookshelf reports** for any book ([how](#finding-the-path-audiobookshelf-reports)), for example:

   ```
   /mnt/wd14/audiobooks/audiobookshelf/audiobooks/Nonfiction/Cal Newport/Deep Work
   ```

2. **Find the same folder on your Mac:**

   ```
   /Volumes/Audiobooks/audiobookshelf/audiobooks/Nonfiction/Cal Newport/Deep Work
   ```

3. **Mount the shared part of the two paths** at the path Audiobookshelf reports ([option B](#option-b-mount-at-the-path-audiobookshelf-reports-from-a-different-host-path)). Point `ABS_INTERNAL_URL` at your Audiobookshelf server:

   ```bash
   docker build -t laabs-companion .
   ```

   ```bash
   docker run --rm -it --name laabs-companion -p 8787:8787 -v /Volumes/Audiobooks/audiobookshelf/audiobooks:/mnt/wd14/audiobooks/audiobookshelf/audiobooks -e ABS_INTERNAL_URL=https://abs.example.com -e LIBRARY_ROOTS=/mnt/wd14/audiobooks/audiobookshelf/audiobooks laabs-companion
   ```

   If Audiobookshelf also runs on the Mac, use `http://host.orb.internal:13378` (OrbStack) or `http://host.docker.internal:13378` (Docker Desktop).

4. **In the iOS simulator,** set the Companion URL in LAABS Audio to `http://localhost:8787`. The automatic `/laabs` lookup won't find it, because your public proxy doesn't route to your Mac.

Leave `--user` out on macOS. OrbStack and Docker Desktop write files as your Mac user.

## Updating

```bash
git pull
```

```bash
docker compose up -d --build laabs-companion
```

If you use `docker run`, rebuild with `docker build -t laabs-companion .`, then remove and re-create the container.

Sidecar files are versioned (`schemaVersion`). The Companion never rewrites a file that has a newer schema than it understands; it returns `409 unsupported_schema` instead.

Run **one** Companion per set of libraries. Its write locks are held in memory, so two instances writing the same folders could overwrite each other's changes.

## Troubleshooting

The Companion logs only failures (5xx responses and startup errors). Successful syncs leave no log lines. To see which books synced, use the **Bookmarks on this device** list in LAABS Audio or look for the dotfiles on disk.

```bash
docker logs -f laabs-companion
```

| Symptom | Cause | Fix |
|---|---|---|
| Container exits at start: `ABS_INTERNAL_URL …` or `LIBRARY_ROOTS …` | A required variable is missing. | Set both. |
| Container exits at start: `Library root "…" is not an accessible folder` | That path isn't mounted in the container, or isn't a directory. | Check the `-v` / `volumes:` line and that the host path exists (for a share: that it's mounted). |
| Container exits at start: `PATH_MAPPINGS entry "…" must look like /abs/path=/local/path` | Malformed mapping. | Use `absPrefix=containerPrefix`, separated by `\|`, and quote the whole value in a shell. |
| `item_folder_missing` | The folder Audiobookshelf reports doesn't exist in the container. | [Match the paths](#the-rule-that-matters-matching-paths). Get the real path from `/api/items/<id>` and compare it with your mount and mapping. |
| `path_not_allowed` | The folder exists but is outside `LIBRARY_ROOTS`. | Add its library root, or a parent folder, to `LIBRARY_ROOTS`. |
| `EACCES: permission denied` in the log | The container user can't write to the book folder. | Fix `user:` or the share's mount options. Remove any `:ro`. See [permissions](#file-ownership-and-permissions). |
| `ENOTSUP … fsync` in the log | You're running a Companion build from before `fsync` errors were tolerated. | Pull and rebuild the image. |
| `abs_unreachable` | The container can't reach `ABS_INTERNAL_URL`. | Use the Compose service name on a shared network, or a LAN address. `localhost` inside a container means the container itself. |
| `invalid_token` | Audiobookshelf rejected the user's token. | Sign out and back in to LAABS Audio. In curl, check the token. |
| `unsupported_item` | The item is a single audio file with no folder of its own. | Expected. Those items keep their bookmarks on the device only. |
| LAABS Audio shows **Not found** | The app can't reach `<Audiobookshelf URL>/laabs/health`. | Check the proxy route with curl, or enter the Companion URL by hand. |
| Container shows `unhealthy` | The healthcheck can't reach `/health` inside the container. | Make sure `HOST` is `0.0.0.0` and `PORT` matches. |
| Items stay **Waiting** in the app | Sync hasn't run since they were queued. | Tap **Sync all bookmarks now**, or **Sync now** on an item. |
| Can't see the sidecar files | They're hidden dotfiles. | `ls -la`, or Cmd+Shift+. in Finder. |
