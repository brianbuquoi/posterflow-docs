# Install

PosterFlow ships as the multi-arch Docker image `dweagle/posterflow`. There is no Helm chart, no host install, no bare-metal install path. The image bundles `rclone` 1.73.4, a Python 3.12 FastAPI backend, and a Vite-compiled React frontend into a single process listening on container port 8000.

## Prerequisites

| Requirement | Notes |
|---|---|
| Docker Engine 24+ | Docker Compose v2 (the `docker compose` subcommand) is assumed throughout these docs. |
| Linux/amd64 or linux/arm64 host | Both are published; see [`.github/workflows/build-docker.yml`](https://github.com/dweagle/posterflow/blob/develop/.github/workflows/build-docker.yml). The image is **not** built for arm/v7. |
| Host clock in sync with reality | The scheduler keys cron triggers off the host's local timezone via `get_localzone()` (`backend/core/scheduler.py`). NTP skew breaks scheduling and breaks Plex token validation. |
| A persistent host directory for `/config` | The SQLite database, rclone config, drive cache, logs and the default poster store all live under this single mount. Back it up the same way you back up the rest of your homelab state. |
| A `PUID`/`PGID` matching the host user that owns the mounted directories | The entrypoint remaps the in-container `posterflow` user's UID/GID at boot and then `chown`s `/config` (`entrypoint.sh`). Mismatched IDs cause permission failures inside `/config/logs/` and `/config/posters/`. |

You do **not** need: a separate database server (SQLite is embedded), a separate reverse proxy (the static bundle is served from the same port as the API), Node.js or Python on the host, or rclone on the host.

## Image tags

The CI workflow at `.github/workflows/build-docker.yml` publishes exactly two tags, gated on the branch and triggered only by `workflow_dispatch`:

| Tag | Source branch | Updated |
|---|---|---|
| `latest` | `main` | When a maintainer runs the workflow against `main`. |
| `develop` | `develop` | When a maintainer runs the workflow against `develop`. |

There are no SemVer tags published, despite the project itself following SemVer in `CHANGELOG.md`. To pin to a specific version you must build locally from the tag (see [`upgrade.md`](upgrade.md)). The same workflow builds both `linux/amd64` and `linux/arm64`.

## docker-compose.yml

The canonical compose file. Every key is explained inline.

```yaml
services:
  posterflow:
    image: dweagle/posterflow:develop
    container_name: posterflow
    ports:
      # Host:container. Container port is hardcoded to 8000 (Dockerfile EXPOSE 8000,
      # uvicorn binds 0.0.0.0:8000 in backend/main.py). The host port is
      # convention only — 8357 is what the upstream README uses; pick any free
      # port you like.
      - "8357:8000"
    volumes:
      # The only required mount. Holds posterflow.db, rclone.conf, drives_cache.json,
      # the default poster cache (/config/posters/gdrive/), /config/logs/,
      # /config/scripts/ and /config/idarr/. Back this directory up.
      - ./config:/config

      # Optional. Mount your Kometa assets directory here (or anywhere) and point
      # the renamer's "Destination" setting at it. Without this mount, PosterFlow
      # writes its organized output under /config/posters/assets/ and you have
      # to copy it out yourself.
      - /path/to/kometa/assets:/assets

      # Optional, poster-makers only. Mount the directory where you stage posters
      # you intend to upload to your personal Google Drive via IDarr.
      - /path/to/idarr/staging:/idarr
    environment:
      - PUID=1000        # Host UID that owns the mount points above.
      - PGID=1000        # Host GID. Both default to 1000 if unset.
      - TZ=America/New_York   # Host timezone. Drives scheduler local-time interpretation.
      - DEBUG=false      # Optional. true forces file logging to DEBUG on startup.
      - LOG_LEVEL=INFO   # Optional. File log level when DEBUG=false.
      - CORS_ORIGINS=    # Optional. Comma-separated origins (see configuration.md).
    restart: unless-stopped
```

### Equivalent `docker run`

```bash
docker run -d \
  --name posterflow \
  -p 8357:8000 \
  -v /srv/posterflow/config:/config \
  -v /srv/kometa/assets:/assets \
  -e PUID=1000 -e PGID=1000 \
  -e TZ=America/New_York \
  --restart unless-stopped \
  dweagle/posterflow:develop
```

## Volumes

| Container path | Required? | Created by | Purpose |
|---|---|---|---|
| `/config` | Yes | The entrypoint `chown`s this and the app `mkdir`s `/config/logs`, `/config/idarr` and `/config/scripts` on every boot (see `backend/core/config.py`). | SQLite DB at `/config/posterflow.db`, WAL/SHM sidecars next to it, `rclone.conf`, `drives_cache.json`, the default GDrive cache at `/config/posters/gdrive/`, logs at `/config/logs/posterflow.log` (plus per-job log dirs), after-job scripts at `/config/scripts/`, IDarr working dir at `/config/idarr/`. |
| `/assets` (or anywhere) | No | You. | Destination for organized, renamed, bordered posters. Point Kometa's `asset_directory` at the same host path. |
| `/idarr` (or anywhere) | No | You. | Poster-maker staging area for IDarr. Used only if you operate the IDarr workflow. |

PosterFlow does not require or special-case a `/custom` mount; the upstream README listing one is unsourced. You can mount any host directory at any container path and refer to it from the relevant in-app setting (gdrive storage path, destination directory, IDarr sync target source, etc.).

## Ports

| Container port | Protocol | Notes |
|---|---|---|
| 8000 | HTTP (REST + WebSocket on same port) | Hardcoded in `backend/main.py` line 527; `EXPOSE 8000` in `Dockerfile`. |

The host port is your choice. The upstream convention is 8357. If you change it, also update `CORS_ORIGINS` (see [`configuration.md`](configuration.md)) so your browser can reach the app from its new origin.

## Environment variables

Every env var that the backend reads. Defaults are from `backend/core/config.py` unless noted.

| Variable | Default | Type | What it controls |
|---|---|---|---|
| `PUID` | `1000` | int | The UID that the container's `posterflow` user is remapped to before the app starts. Must match the host user that owns `/config`. |
| `PGID` | `1000` | int | Group equivalent. |
| `TZ` | `UTC` | tz name | The IANA timezone for the container. Drives the scheduler's local-time interpretation of `daily`/`weekly`/`cron` triggers. |
| `DEBUG` | `false` | bool | If `true` on startup, file logging is forced to `DEBUG`. After startup, the in-app toggle (Logs page) takes precedence and is persisted in the DB; subsequent restarts restore the persisted value (see `backend/main.py` lines 254–268). |
| `LOG_LEVEL` | `INFO` | string | File log level when `DEBUG` is off. Accepted: `TRACE`, `DEBUG`, `INFO`, `SUCCESS`, `WARNING`, `ERROR`, `CRITICAL`. |
| `CORS_ORIGINS` | `http://localhost:8357,http://127.0.0.1:8357,http://localhost:5173,http://127.0.0.1:5173,https://www.photopea.com` | comma-separated string | Browser origins the FastAPI CORS middleware will accept. The `:5173` entries are the Vite dev server; `https://www.photopea.com` is required for Maker Tools' PSD save round-trip. |
| `MALLOC_ARENA_MAX` | `2` (set in Dockerfile) | int | glibc setting. Lowers heap fragmentation so `malloc_trim(0)` after each job actually returns memory to the OS. Leave it alone unless you understand glibc allocators. |
| `BRANCH` | unset locally, set in CI builds | string | If set, appended to the displayed version (`0.5.3.develop`). Comes from the GitHub workflow's `GITHUB_REF_NAME`. |
| `POSTERFLOW_TESTING` | unset | bool | If `1`/`true`/`yes`/`on`, the lifespan handler skips startup side effects. Only used by the test suite. Do not set in production. |

There is no environment variable for the API password — see [`security.md`](security.md). The bind address (`0.0.0.0`) and port (8000) are hardcoded.

## First boot

What happens, in order, from `docker run` to a usable app:

1. The container's entrypoint (`entrypoint.sh`) runs as root. It `groupmod`s and `usermod`s the in-container `posterflow` user/group to match `PUID`/`PGID`. It then `chown`s `/config` to that user. It logs a single `[STARTUP] • Entrypoint ready (uid=… gid=…)` line and `exec`s `gosu posterflow python main.py`.

2. `backend/main.py` initializes Loguru (`setup_logging()` — log file is created at `/config/logs/posterflow.log`, rotated at 10 MB, 1 backup kept).

3. The FastAPI lifespan runs `run_database_migrations()`. Alembic runs every migration in `backend/alembic/versions/` against the SQLite URL `sqlite:////config/posterflow.db`. There are six migrations as of 0.5.3 (`0001_initial` through `0006_add_file_mtime_to_plex_upload_records`). On a fresh `/config` this creates the database file and applies all migrations in one pass. On an existing `/config` it applies only the migrations newer than the recorded `alembic_version`. Migrations are idempotent across restarts — interrupting the container during this phase leaves the database in a valid state (Alembic wraps each migration in a transaction).

4. The lifespan restores the persisted `gdrive_storage_path` setting if set, restores the persisted `debug_enabled` flag (overriding the `DEBUG` env var), then marks any job in `pending` or `running` state from a prior run as `failed` with the message `Job interrupted by application restart` (or for IDarr, `Stale IDarr job after application shutdown; job was not resumed`). It prunes the job history per retention rules (≥30 days for completed, ≥14 days for failed, max 750 rows per type).

5. The lifespan calls `load_drives_data()` (`backend/services/drive_loader.py`), which fetches the community drive preset list from `https://raw.githubusercontent.com/dweagle/posterflow/develop/backend/assets/drives.json` with a 10-second timeout and a cache-busting query string. On success it writes the file to `/config/drives_cache.json` and upserts every drive into the `drives` table. On failure it falls back to the cached file. If neither succeeds, the app continues but logs `Application will continue, but drives may not be available`.

6. The lifespan starts APScheduler (`backend/core/scheduler.py`). The scheduler is backed by a `SQLAlchemyJobStore` against the same SQLite database, so persisted schedules survive restarts. `update_schedules()` rebuilds the APScheduler job table from the `schedules` table.

7. The app is ready. The first browser request returns a 200 on `/api/health` and serves the SPA bundle at `/`. Because there is no `setup_complete` setting on a fresh boot, the SPA redirects to `/setup`.

![First-boot welcome screen — the wizard's three-card entry point](images/wizard-step-0-welcome.png)
*The first screen you see on a fresh `/config`. Choose **Start Fresh** to begin the wizard, **Restore Backup** to upload a previously-taken backup `.zip` (see [`backup-restore.md`](backup-restore.md)), or **Skip Setup** to land on the dashboard and configure the app entirely from Settings.*

## Health check

The `Dockerfile` defines a `HEALTHCHECK` that calls `http://localhost:8000/api/health` every 30 s with a 10 s timeout and a 30 s start period. The endpoint is `backend/main.py` line 461 and returns `{"status": "healthy"}` unconditionally as long as uvicorn is serving. Use this in your compose stack with `depends_on: { posterflow: { condition: service_healthy } }` if anything downstream needs to wait for PosterFlow.

## Recovering from an interrupted first boot

The migrations are transactional and the drive sync is best-effort, so a hard kill during first boot leaves a recoverable state:

| Symptom | Cause | Fix |
|---|---|---|
| `/config/posterflow.db` exists but is empty (0 bytes) | Killed before SQLite created the file | Delete `/config/posterflow.db` (and any `posterflow.db-shm` / `posterflow.db-wal` siblings) and restart. |
| `alembic_version` table missing or partial | Killed mid-migration; rare because each migration is atomic | Restart. Alembic detects missing/partial state and re-applies. |
| `/config/drives_cache.json` missing and remote fetch failed | Hit `raw.githubusercontent.com` rate limit or no network egress | Restart with network connectivity. The app will continue without drives if the fetch keeps failing; you can subscribe to a Custom drive manually. |
| Endless `Database migration failed` in logs on every boot | Out-of-band manual edits to SQLite, or interrupted upgrade from an older version that had a destructive migration | Restore from backup; see [`backup-restore.md`](backup-restore.md). |
| `[STARTUP] ✓ Drives synced: 0 added, 0 updated, …` and the drives list is empty | Remote fetch returned an empty list, no cache file | Check container egress to `raw.githubusercontent.com:443`. |

## Confirming a healthy install

After `docker compose up -d` and the start-period delay, all three of these should respond:

```bash
curl -s http://localhost:8357/api/health
# {"status":"healthy"}

curl -s http://localhost:8357/api/version
# 0.5.3   (or 0.5.3.develop, depending on how the image was built)

curl -s http://localhost:8357/api/setup/status
# {"setup_complete":false}     on a fresh /config
# {"setup_complete":true}      after you finish the wizard
```

The browser should resolve `http://<your-host>:8357/` to the wizard (fresh `/config`) or the dashboard (existing `/config` with setup complete).

## What's next

- Walk through the wizard: [`setup-wizard.md`](setup-wizard.md).
- Or skip the wizard and configure from Settings: [`configuration.md`](configuration.md).
- If you're putting this behind Traefik or nginx, read [`reverse-proxy.md`](reverse-proxy.md) **before** you expose the websocket.
- If you have an existing PosterFlow install you're restoring, jump to [`backup-restore.md`](backup-restore.md).
