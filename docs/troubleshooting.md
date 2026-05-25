# Troubleshooting

This page is a symptom → cause → fix table for the failures most likely to send you here. For each entry: the user-visible symptom, the log substring you should grep `posterflow.log` for, and the fix. Then sections on log locations and how to capture a useful diagnostic bundle.

## Symptom → cause → fix

### Wizard won't complete

**Symptom**: clicking Save & Continue on a wizard step has no visible effect.

**Confirm**: open the browser dev console. A `POST /api/settings/bulk` should fire on every Save & Continue. If it returns 401 with no `Authorization` header, you've set an app password and the wizard isn't passing it.

**Fix**: clear the password (Settings on a fresh wizard install won't have it set, but if you re-ran the wizard after setting a password, you'll need to pass `Authorization: Bearer <pwd>` from the SPA — log out and back in from the LockScreen so the password sits in `sessionStorage`).

If the network call succeeds (200) but the wizard still doesn't advance, refresh the page and check `/api/setup/status` — the bulk write may have already taken effect and the wizard is stuck on the client side. Re-running from `/setup` re-reads server state.

### Setup wizard advanced, but Plex/Sonarr/Radarr "Test Connection" fails

**Symptom**: the test result panel under a server's form shows a red ✗ with an error.

**Diagnostic** in `posterflow.log`:
- `Plex connection failed: Connection refused` — the URL is unreachable from inside the container.
- `Plex connection failed: Unauthorized` — the URL is reachable but the token is rejected.
- `Plex connection failed: Timeout` — the URL is too slow (10 s timeout).
- `Sonarr/Radarr connection failed: 401` — bad API key.
- `Sonarr/Radarr connection failed: connection error` — bad URL.

**Fix**:

| Cause | What to do |
|---|---|
| Plex URL uses `localhost` | Inside the container, `localhost` is the container itself, not the host. Use `host.docker.internal` on Docker Desktop, or the LAN IP of your Plex server on Linux. |
| Plex token is a **server** token | PosterFlow needs a **user** token (`X-Plex-Token`). [Plex token retrieval](https://support.plex.tv/articles/204059436-finding-an-authentication-token-x-plex-token/). |
| Sonarr/Radarr URL has a base URL prefix | If your `arr` instance is at `https://sonarr.example.com/sonarr/`, the base URL goes in the URL field; don't strip it. The client appends `/api/v3/...` to whatever you give it. |
| API key copied with whitespace | Check for trailing newlines. The Test endpoint trims but the bulk-save doesn't. |

### rclone auth fails

**Symptom**: a Sync job marks `failed` with a non-zero rclone exit code in the job log.

**Diagnostic** in `/config/logs/sync_one/sync_one.log` or `sync_all/sync_all.log`:
- `Couldn't find user credentials` — the OAuth fields are blank or the service-account path is wrong.
- `failed to configure token: invalid_grant` — the OAuth refresh token has been revoked. Common after long inactivity or after changing your Google account password.
- `googleapi: Error 403: User Rate Limit Exceeded` — you're hammering the API.
- `googleapi: Error 403: Daily Limit Exceeded` — exceeded the project's daily quota.
- `googleapi: Error 404: File not found` — the `drive_id` (folder ID) is wrong or you don't have access.
- `Permission denied` writing to `/config/posters/gdrive/...` — PUID/PGID mismatch.

**Fix**:

| Cause | Fix |
|---|---|
| Bad credentials | Re-run wizard Step 1 or Settings → Rclone with fresh values. For OAuth, regenerate the refresh token via `rclone config` and paste the whole token JSON. |
| Quota exhaustion | Switch from OAuth to a service-account JSON. The service account is bound to your own GCP project and has its own quota bucket. |
| Wrong folder ID | Verify the ID on the GDrives card — the info icon tooltip shows what's stored. Compare to the URL of the folder in Drive: `https://drive.google.com/drive/folders/<this-is-the-folder-id>`. |
| PUID/PGID | `ls -ln /srv/posterflow/config/posters/gdrive/` — if the directories are owned by `0:0` or some unexpected UID, `chown -R <PUID>:<PGID>` and restart. |

### Plex token rejected after wizard

**Symptom**: every Plex Upload or Renamer job logs `Unauthorized` on the Plex calls. Test Connection succeeds.

**Diagnostic**: in the job log, look for `plexapi.exceptions.Unauthorized: (401)`.

**Cause**: the Plex token in `plex_instances` is masked (`***masked***`) and the API client is literally sending the string `***masked***` to Plex. This happens if you saved the bulk-settings payload with the masked value left in.

**Fix**: Settings → Media Servers → click the eye icon next to the token field → re-enter the real token → Save. The settings save path calls `_unmask_setting_value()` to restore unchanged masked values from the DB, but if you cleared the field and pasted `***masked***` back in (or some other corruption), the real value is gone.

### Posters download but don't rename

**Symptom**: Sync All completes, posters appear under `/config/posters/gdrive/<style>/<drive>/`, but a subsequent Poster Renamer run reports `No assets found` or matches nothing.

**Diagnostic** in `/config/logs/poster_renamer/poster_renamer.log`:
- `Drive priority not configured` — you haven't set the order yet.
- `No assets found in source directories` — the renamer can't see the synced files.
- `0 matched` — files exist but don't match anything.

**Fix**:

| Cause | Fix |
|---|---|
| Drive priority empty | Poster Manager → Drive Priority → drag at least one drive into the priority list. |
| `poster_renamer_libraries` is empty for Plex | Settings → Media Servers → Plex → "Select Libraries" → tick the libraries you want to match against. Empty = no Plex libraries considered. |
| Synced drive isn't subscribed | Sync still ran (it's tolerant), but the renamer only walks subscribed drives. GDrives → click Subscribe. |
| Filenames don't include `{tmdb-N}` or year tags | The renamer falls back to title-only matching, which is fuzzier. Enable debug mode and look for `[MATCH]` log lines for the title-normalization output. |

### Unmatched report shows items that exist

**Symptom**: Unmatched Assets report lists, e.g., "Nosferatu (1922)", but you have a `Nosferatu (1922)/poster.jpg` in your destination.

**Diagnostic** in `posterflow.log`: `[MATCH]` lines for the title under question. Look for the normalized title — both the asset's normalized title and the media-server's normalized title.

**Cause**: title normalization edge case. Common causes:

| Title symptom | Issue |
|---|---|
| Contains `&` or `&amp;` | The renamer normalizes `&` to ` and ` (with surrounding spaces). The Unmatched detector does the same. Older asset folders named with literal `&` may not match. The 0.4.0 changelog notes fixes here — if you're on an older version, upgrade. |
| Contains diacritics | `unidecode` strips them: `Amélie` becomes `amelie`. Should match. If it doesn't, the asset's title has a different transliteration than the media server (e.g., `Amelie` vs `Amélie`). |
| Year mismatch | The asset is `Movie (1989)` but Radarr has it as `Movie (1990)` (different region's release year). The matcher includes the year, so this is a real mismatch — you need to either re-tag the asset or use the TMDB ID in the filename to override the year. |
| Article handling | The matcher drops common stopwords (`the`, `a`, `an`) before comparison. `The Matrix` and `Matrix` should match. If they don't, there's a stray punctuation character — open the asset filename in a hex editor. |

**Fix**: rename the asset folder to include the TMDB ID — `Movie Title (1989) {tmdb-12345}` — and the matcher's ID path takes over, bypassing title normalization entirely.

### Border replacer produces wrong dimensions

**Symptom**: posters are slightly off from 1000×1500.

**Cause**: not possible. The Border Replacer's last step before save is `image.resize((1000, 1500))`. If files are coming out at different sizes, the run is being interrupted before that step or you're looking at files the Border Replacer didn't touch.

**Confirm**: `identify -format "%wx%h\n" /assets/Title/poster.jpg` (ImageMagick) on a few files. If everything matches 1000×1500 except one, that file's `Poster.last_processed` is stale.

**Fix**: Border Replacer tab → switch mode to `Full` → run. This bypasses incremental skip and re-renders everything. Switch back to `Incremental` for routine runs.

### Websocket disconnects behind reverse proxy

**Symptom**: live job progress and live log streaming silently stop updating. REST endpoints work.

**Diagnostic**: open the browser dev console → Network → WS filter. Find the connection to `/api/jobs/ws`. Status `1006` means the proxy closed the connection.

**Fix**: see [`reverse-proxy.md`](reverse-proxy.md). Two most common causes:
1. nginx without `proxy_set_header Upgrade $http_upgrade; proxy_set_header Connection "upgrade";`.
2. Forward-auth (Authelia, oauth2-proxy) intercepting the `/api/jobs/ws` request and trying to do an OAuth round-trip on it. Exempt the `/api/*/ws` and `/api/job-logs/*/live` paths from forward auth, or configure your auth provider to skip WS upgrade requests.

### Scheduled jobs don't fire after restart

**Symptom**: schedules show up in the UI with their next-run time, but the time passes and no job appears.

**Diagnostic** in `posterflow.log`: look for `[SCHEDULER]` entries. On startup you should see `Reloaded N enabled schedule(s)` where N matches what you have. If N is 0, the schedules aren't reaching APScheduler.

**Cause**:

| Symptom | Cause |
|---|---|
| `Reloaded 0 enabled schedule(s)` but the schedule list isn't empty | Every schedule is `enabled=false`. Toggle them on in the UI. |
| `Skipped: maximum number of running instances reached (3)` | Three instances of the same scheduled job are already queued because previous fires didn't finish. The global job queue is overloaded. Cancel pending jobs from Settings → Maintenance or wait for the queue to drain. |
| Container TZ wrong | A schedule says `14:30` but fires at `19:30 local`. Set `TZ` in compose to your real timezone and restart. |

### PUID/PGID permission errors

**Symptom**: a job logs `PermissionError: [Errno 13] Permission denied: '/config/...'` or `'/assets/...'`.

**Diagnostic**: `docker exec -it posterflow ls -ln /config /assets` — compare the UID columns to your `PUID`/`PGID` env vars.

**Cause**: the directory was created by a different UID before you set PUID/PGID, or one of the volume mounts is on a filesystem with different ownership semantics (e.g., a CIFS share with `uid=0` mount option).

**Fix**:
- For `/config`: the entrypoint `chown`s the top-level mount on every boot, but it doesn't recurse. If the problem is in a subdirectory, run `docker compose exec posterflow chown -R posterflow:posterflow /config` once.
- For `/assets` and `/idarr`: not chown'd by the entrypoint. Run `chown -R <PUID>:<PGID> /srv/kometa/assets` on the host before starting the container.

### Container OOMs during border replace

**Symptom**: the container exits with code 137. The job log shows it stopped mid-Border Replacer.

**Cause**: Pillow holds full uncompressed bitmaps in memory. A 4000×6000 source image at 24 bpp is 72 MB resident; a 50-image batch with Python's reference-counted GC can easily push past a 512 MB container limit.

**Fix**:
- Raise the container memory limit: `deploy: { resources: { limits: { memory: 2G } } }` in compose.
- Downscale your source artwork. The Border Replacer's final output is 1000×1500 anyway, so a 4000×6000 source is wasted work.
- Confirm `MALLOC_ARENA_MAX=2` is set — it's in the Dockerfile by default. If you've overridden the entrypoint or env in a way that drops it, set it back.

### Discord notifications don't arrive

**Symptom**: a job completes, the log shows the right outcome, but no Discord message.

**Diagnostic** in `posterflow.log`: look for `[USER_ACTION]` and warnings around the `discord_notifications` feature.

| Log line | Cause |
|---|---|
| `Invalid Discord webhook URL: ...` | The URL isn't `https://discord.com/api/webhooks/...` or `https://discordapp.com/api/webhooks/...`. |
| `Discord webhook returned 404` | The webhook was deleted in Discord. Regenerate. |
| `Discord webhook returned 401 or 403` | Should not happen — webhooks don't use tokens. Implies you pasted a Discord bot URL instead of a webhook URL. |
| `Discord webhook returned 429` | Rate limited (30/min/channel). Reduce `include_details` or route to a less-busy channel. |
| Nothing logged at all | The feature is disabled for this event. Check Settings → Notifications → the specific feature row → On Success / On Error toggles. |

**Fix**: Settings → Notifications → "Send Test Notification" — this isolates whether the webhook itself is reachable from the feature filters.

### IDarr fails to assign IDs

**Symptom**: IDarr job completes but every file lands in `idarr_pending_matches`.

**Diagnostic** in `/config/logs/idarr/idarr.log`:
- `TMDB API key not configured` — set the global `tmdb_api_key` in Settings.
- `TMDB rate limit (429)` — you're hitting TMDB's rate limit. IDarr rate-limits itself at 100ms between requests; if you have other apps sharing the same key, you might collide.
- `TMDB returned no matches for '<title>'` — actually unfindable. Manually resolve in the Pending tab.

**Fix**: set the TMDB key in Settings → Rclone tab (yes, the key field is there; it's also in wizard Step 4). Then re-run IDarr.

### Workflow stuck

**Symptom**: a Workflow job shows `running` indefinitely. No progress updates. Other jobs queue behind it but never start.

**Cause**: a crash inside one of the workflow steps left the global workflow lock held. The lock auto-releases after 15 minutes; before that, you can either wait or force-release.

**Fix**:

```bash
# Mark the stuck job failed via SQL (stop the container first):
docker compose stop posterflow
docker run --rm -v /srv/posterflow/config:/c alpine:3 \
  sh -c "apk add --no-cache sqlite && sqlite3 /c/posterflow.db \
   \"UPDATE jobs SET status='failed', error='Manually released stuck workflow lock', completed_at=datetime('now') WHERE status IN ('running','pending') AND job_type='Poster Workflow';\""
docker compose start posterflow
```

The startup lifespan's stale-job cleanup will do the same thing if you just restart the container — so this manual route is for when restarting is undesirable.

### Migration failed

**Symptom**: container exits during startup with `Database migration failed: ...` in the logs.

**Diagnostic**:
- `relation already exists` — a previous migration was partially applied. Possible after a forced kill mid-upgrade.
- `column does not exist` — the DB is from a newer version than the container's migrations cover (you downgraded the image but not the DB).
- `database is locked` — another process has the DB file open. SQLite is single-writer; if you have a stray `sqlite3` shell open, close it.

**Fix**:

| Cause | Fix |
|---|---|
| Partially applied migration | Restore the DB from the safety_backups dir or your last good backup. See [`backup-restore.md`](backup-restore.md#recovering-from-a-corrupted-db). |
| Schema newer than container | Either upgrade the image to a version that knows about the schema, or restore from a pre-upgrade backup. |
| DB locked | Stop the container, ensure no other process is reading from `/config/posterflow.db`, restart. |

### Stale records

**Symptom**: Dashboard's Poster Stats card shows posters that no longer exist on disk. Drive cards show "N in DB" larger than the actual file count.

**Cause**: you deleted files under `/config/posters/gdrive/...` while the container was stopped, or files disappeared from Google Drive between syncs and the local cache was cleaned by `rclone sync`.

**Fix**: Settings → Maintenance → "Cleanup orphaned records" — runs `POST /api/database/cleanup/execute`. This deletes every `posters` row whose `file_path` doesn't resolve on disk. The preview endpoint (`GET /api/database/cleanup/preview`) shows what would be deleted before you commit.

## Log file layout

| Path | What's there |
|---|---|
| `/config/logs/posterflow.log` | App-wide log. Everything. Rotates at 10 MB with 1 backup. |
| `/config/logs/posterflow.log.1` | Most recent rotated log. |
| `/config/logs/sync_one/sync_one.log` | Per-job-type log for single-drive sync. One job per file, rotated; 10 most recent kept. |
| `/config/logs/sync_all/sync_all.log` | Same for sync-all. |
| `/config/logs/poster_renamer/poster_renamer.log` | Same for the renamer. |
| `/config/logs/border_replacer/border_replacer.log` | Same for border. |
| `/config/logs/unmatched_assets/unmatched_assets.log` | Same for unmatched. |
| `/config/logs/plex_upload/plex_upload.log` | Same for upload. |
| `/config/logs/workflow/workflow.log` | Workflow parent's log. Sub-step logs land in their own files; the parent only logs orchestration. |
| `/config/logs/idarr/idarr.log` | Same for IDarr. |
| `/config/logs/maker_monitor/maker_monitor.log` | Same for monitor. |

The format is `YY/MM/DD HH:MM:SS | LEVEL | [TAG] message`. Tags are the `LogTags` enum values listed in [`live-status.md`](live-status.md).

## Enabling debug mode

There are two ways to turn on debug-level file logging:

1. **`DEBUG=true` env var** — file log level is forced to `DEBUG` at startup. Survives container restart.
2. **Logs page → Debug toggle** — same effect but persisted in the DB as `debug_enabled`. The DB value wins over the env var on subsequent startups (see `backend/main.py` lifespan).

If both are set and you want to revert to non-debug:

```bash
# Turn off DB toggle:
curl -X POST -H "Authorization: Bearer <pwd>" \
  -H "Content-Type: application/json" \
  -d '{"enable": false}' \
  http://localhost:8357/api/logs/debug-toggle

# Remove env var from compose, then restart.
```

Console output is always at DEBUG (you can see it via `docker logs posterflow`). File output respects the level.

## Capturing a diagnostic bundle

When you file an issue, attach:

```bash
mkdir /tmp/pf-diagnostic
cd /tmp/pf-diagnostic

# Container version and config:
docker inspect posterflow-docs > inspect.json
docker logs posterflow-docs --tail 1000 > docker-logs.txt 2>&1
docker exec posterflow-docs cat /VERSION > version.txt

# Recent app logs (last 5000 lines):
docker exec posterflow-docs tail -n 5000 /config/logs/posterflow.log > app.log

# Per-job-type logs:
docker cp posterflow-docs:/config/logs ./logs

# DB schema (no data, no secrets):
docker exec posterflow-docs sh -c \
  'apt-get install -y --no-install-recommends sqlite3 2>/dev/null; \
   sqlite3 /config/posterflow.db ".schema"' > schema.sql

# Settings keys (values masked by API):
curl -s -H "Authorization: Bearer <pwd>" \
  http://localhost:8357/api/settings/ > settings.json

# Health and version endpoints:
curl -s http://localhost:8357/api/health > health.json
curl -s http://localhost:8357/api/version > version-api.txt
curl -s -H "Authorization: Bearer <pwd>" \
  http://localhost:8357/api/version/update > update.json

tar -czf pf-diagnostic.tgz *
```

Before sharing, **inspect every file for leaked secrets**. The settings API masks sensitive values but if you've revealed any via `/reveal` recently, those will be in `docker-logs.txt`. The schema is safe (no data). The app log usually doesn't contain raw tokens but does contain rclone progress, drive IDs, and URLs.

## Where to file an issue

`https://github.com/dweagle/posterflow/issues` — include the diagnostic bundle, the exact PosterFlow version, and the steps to reproduce. The maintainer is responsive.

If your issue is sensitive (a security finding, an internal URL you can't redact), follow the conventions in the upstream repo — at the time of writing there is no published security contact, so a private GitHub issue (if available) or a direct DM is the path.
