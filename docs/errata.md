# Errata

Things in the upstream README, in the code, or in the documentation set itself that are wrong, inaccurate, missing, or that didn't make it into the screenshots. Maintained in sync with the rest of `docs/` — when something here is fixed in the repo, the entry moves to a "Fixed" section.

## Upstream README inaccuracies (relative to develop @ 0.5.3)

| Claim in README | Reality in code |
|---|---|
| "Defualt Poster Storage" appears twice in the Volumes table | Typo — should be "Default". `README.md` lines 44, 56. |
| Volumes table includes `/custom` | Nothing in `Dockerfile`, `entrypoint.sh`, or `backend/core/config.py` special-cases `/custom`. Users mount any host directory at any container path; the in-app settings (gdrive storage path, destination directory) reference the container path. The `/custom` row gives the false impression of a documented mount point. See [`install.md`](install.md#volumes). |
| Volumes table says `/config` holds the "Default Poster Storage" | The default cache lives at `/config/posters/gdrive/`, not directly at `/config/`. The destination of organized posters defaults to `/config/posters/assets/`. Both are overridable. See [`configuration.md`](configuration.md#whats-in-config). |
| Example compose `image: dweagle/posterflow:develop` | Correct, but the README's compose YAML uses `/path/to/idarr/posters:/idarr` — the `/idarr` mount only matters for poster makers using IDarr's sync-to-personal-Drive feature. Most operators don't need it. The note above the volumes section in the README ("These are default locations…") is also misleading; the paths are settings, not defaults baked into the image. |
| Quick Start section says "The setup wizard runs on first launch to configure your media server connections and Google Drive credentials" | Accurate. Not a defect, just confirming. |
| The README implies SemVer tags exist | No SemVer tags are published to Docker Hub by the CI workflow. Only `latest` (from `main`) and `develop` (from `develop`). See [`upgrade.md`](upgrade.md#image-tags). |
| Env var table omits `MALLOC_ARENA_MAX` | The Dockerfile sets it to `2`. It matters — without it, `malloc_trim` in the job-queue post-job cleanup doesn't return memory to the OS, and the container's RSS grows monotonically across long-running installs. Documented in [`install.md`](install.md#environment-variables). |
| Env var table omits `BRANCH` and `POSTERFLOW_TESTING` | Both are read by `backend/main.py`. `BRANCH` is set by CI to suffix the displayed version; `POSTERFLOW_TESTING` is used only by the test suite to skip startup side effects. Operators don't need to set either, but they exist. |
| Env var table description: `DEBUG` "can be toggled in-app" | Correct, but understates: the in-app toggle persists to the DB and wins over the env var on subsequent restarts. The env var is a one-time "force-on at boot" override. |

## Code behaviors that surprised the documentation author

These aren't bugs, but they're worth flagging because they affect operator decisions:

- **The community drives list is fetched from `develop` even on `main` builds.** `backend/services/drive_loader.py` hardcodes `https://raw.githubusercontent.com/dweagle/posterflow/develop/backend/assets/drives.json`. If `develop` ships a poorly-formed drives file, every running PosterFlow on every branch sees it. There's no env-var override.
- **The CORS allowlist includes `https://www.photopea.com` by default.** This is necessary for Maker Tools, but it's a deliberate cross-origin trust users should be aware of. See [`security.md`](security.md#what-posterflow-does-not-protect-against).
- **The `Access-Control-Allow-Private-Network: true` header is unconditionally echoed.** `backend/main.py` lines 424–437. This is a Chrome PNA mechanism for LAN-to-localhost requests; only Photopea triggers the preflight in practice, but the header is sent on every response.
- **`max_concurrent_jobs=1` is the default and is not exposed in the UI.** Some operators expect jobs to run in parallel; they don't. Sequential. Listed in [`configuration.md`](configuration.md), no UI control.
- **The job queue's `coalesce=True` collapses missed scheduled fires.** After a 24-hour outage, a daily job fires once on restart, not 24 times. Documented in [`scheduler.md`](scheduler.md#scheduler-configuration). Some users coming from cron may expect the cron behavior of "fire all missed jobs" (which cron itself doesn't do either, but tools like anacron do).
- **Post-job hooks run with a clean environment.** Only `POSTERFLOW_*` plus `HOME` and `PATH`. Scripts can't rely on `$DOCKER_HOST`, `$KOMETA_TOKEN`, etc. — they must read those from a file. Documented in [`scheduler.md`](scheduler.md#script-execution-contract).
- **The wizard never validates Google credentials.** Tokens go straight to the DB. Validation happens only when a sync actually runs against rclone. So you can finish the wizard with garbage credentials and not know until the first sync log shows the rclone error. Documented in [`setup-wizard.md`](setup-wizard.md#step-1--google-drive).

## Screens that could not be captured

The Playwright capture script in `scratch/capture.mjs` covers most surfaces. The following screens require state that the docs setup couldn't produce; they're referenced in `docs/` but no PNG exists in `docs/images/`:

| Reference | Why missing |
|---|---|
| `dashboard-active-job-running.png` (referenced in [`jobs.md`](jobs.md)) | Would require starting a job and timing the screenshot mid-run. The capture script doesn't wait for a running job because the test fixtures have no real Google Drive credentials, so a Sync immediately fails. Could be added by running with valid credentials. |
| `dashboard-update-available.png` (referenced in [`upgrade.md`](upgrade.md)) | The Dashboard's "Update Available" badge appears only when GitHub Releases returns a newer SemVer than the running version. The instance documenting these docs ran `develop` at 0.5.3 with no newer 0.5.x release tagged at capture time, so the badge didn't render. |
| `discord-message-example.png` (referenced in [`notifications.md`](notifications.md)) | Would require a real Discord webhook that the docs author has access to. None was used. Operators should run the Test Notification button in their own install to see the actual message format. |
| `drives-card-deprecated.png` (referenced in [`drives.md`](drives.md)) | A drive only becomes deprecated when it disappears from the upstream community list. No drive was deprecated at the time of capture; the community list had 41 drives, all present. Could be reproduced by editing `/config/drives_cache.json` to remove a drive then hitting Reload. |
| `wizard-step-3-test-success.png` (referenced in [`setup-wizard.md`](setup-wizard.md)) | The capture used placeholder URLs that the Test buttons cannot reach. The failed-test screenshot (`wizard-test-failed.png`) is the closest visual fixture. A successful test would require real Plex/Sonarr/Radarr endpoints. |
| `settings-restart-required-modal.png` (referenced in [`configuration.md`](configuration.md)) | The capture didn't trigger a settings change requiring restart. Could be added by editing the env-var-related settings in a follow-up run. |
| `backup-restore-confirm-restart.png` (referenced in [`backup-restore.md`](backup-restore.md)) | The modal only appears after a successful restore. The capture didn't perform a restore. |
| `toast-error-example.png` (referenced in [`troubleshooting.md`](troubleshooting.md)) | Triggering a UI error toast deterministically requires forcing a 5xx from the backend; the capture script didn't include this. |

The remaining ~47 screenshots in `docs/images/` cover the entire setup wizard, every top-level page, all six Poster Manager tabs, all nine Settings tabs, the four major modals (storage, custom drive add, drive edit, schedule edit), and both Logs tabs.

## Doc-set issues

- **The hero screenshot in `overview.md` shows an unsubscribed drive count of 1/41.** The instance had one community drive (`BZ`) subscribed for the screenshot. Real installs will have different numbers; the screenshot is illustrative.
- **The `drives-list-cl2k.png` shows 17 drives, but the upstream list had 41 total at the time of capture.** The other 24 are MM2K or Custom and not visible under the CL2K filter. The screenshot is accurate but the count is style-dependent — running drive count `Reload` may produce different totals.
- **Several entries in this doc-set link to features that are upstream-only.** The Maker Tools → Monitor frequency setting and the Community Requests Supabase integration are documented but the corresponding screens haven't been exercised on the documentation instance (no Supabase keys, no Discord OAuth). They appear in [`jobs.md`](jobs.md#maker-tools) for completeness from code reading.

## Things this doc set deliberately does not cover

- **Internal architecture beyond what an operator needs.** The `backend/util/`, `backend/modules/`, and `backend/services/` layers are described in terms of inputs/outputs, not as a Python API reference. If you're hacking on PosterFlow, read the code.
- **Per-version migration playbooks.** The Alembic migrations are listed in [`install.md`](install.md#first-boot) by name and chronological order; for the specific schema changes in each, read the migration's docstring or the migration `upgrade()` body.
- **DAPS feature parity matrices.** PosterFlow targets byte-for-byte output compatibility for the same inputs, but DAPS has its own configuration surface that doesn't map 1:1 to settings here. If you're migrating from DAPS, expect to re-set things via the Settings UI rather than translate `config.yaml`.
- **Performance tuning beyond `MALLOC_ARENA_MAX` and the container memory limit.** The single-worker job queue, the SQLite WAL mode, and the rclone tpslimit are all hardcoded. If you outgrow them, the project has not yet shipped tuning knobs.
