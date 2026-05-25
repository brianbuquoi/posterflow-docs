# Notifications

PosterFlow's notification surface is **Discord webhooks**. There is no email path, no Pushover/Gotify integration, no syslog forwarder. If you want something other than Discord, the after-job script hook ([`scheduler.md`](scheduler.md#after-job-scripts)) is the escape hatch.

Implementation: [`backend/services/discord_notifications.py`](https://github.com/dweagle/posterflow/blob/develop/backend/services/discord_notifications.py). UI: Settings → Notifications, [`frontend/src/components/settings/`](https://github.com/dweagle/posterflow/tree/develop/frontend/src/components/settings).

## Setup

![Notifications tab with webhook URL and per-feature toggles](images/settings-tab-notifications.png)
*The Notifications tab. Master enable + a global webhook URL + a default mention; each feature has its own enable, success/error filters, and optional override webhook.*

### Creating the webhook in Discord

1. In your Discord server, **Server Settings** → **Integrations** → **Webhooks** → **New Webhook**.
2. Name it (e.g., "PosterFlow"), pick a channel, optionally set an avatar.
3. Click **Copy Webhook URL**. The URL must match `^https://(discord|discordapp)\.com/api/webhooks/<id>/<token>` — PosterFlow's `_is_valid_discord_webhook()` rejects anything else.
4. Paste the URL into Settings → Notifications → Webhook URL.

### Global configuration

| Field | Setting key | What it does |
|---|---|---|
| Enable Discord Notifications | `discord_notifications_enabled` | Master switch. If off, nothing fires regardless of per-feature config. |
| Webhook URL | `discord_notifications_webhook_url` (masked) | Default webhook used by features that don't override. |
| Mention | `discord_notifications_mention` | Optional. `@here`, `@everyone`, `<@USER_ID>`, `<@&ROLE_ID>`, or a bare snowflake. Bare snowflakes are auto-wrapped to `<@N>` user mentions. |
| Mention on error | `discord_notifications_mention_on_error` | Apply the mention to error events. |
| Mention on success | `discord_notifications_mention_on_success` | Apply the mention to success events. |

The **Send Test Notification** button calls `POST /api/settings/notifications/discord/test` with the current form state. It fires a test embed to the configured webhook so you can verify routing and mention behavior before relying on real events.

### Per-feature configuration

Each feature has its own row with the same shape:

| Field | What it does |
|---|---|
| Enabled | Per-feature switch. |
| On Success | Send notification on successful runs. |
| On Error | Send notification on failures. |
| Include Summary | Add a summary field (counts, totals). |
| Include Details | Add per-item detail fields (long; capped at 25 fields per payload). |
| Webhook URL (override) | If set, this feature uses this webhook instead of the global one. Useful for routing critical events (e.g., `system_errors`) to an ops channel. |
| Mention (override) | Same as global. |
| Mention on Error / on Success | Same as global. |

The features:

| Feature key | Fires for |
|---|---|
| `workflow` | The Poster Workflow parent job (one summary embed at the end, plus optional per-step embeds). |
| `sync` | Drive Sync jobs (`sync_one`, `sync_all`). |
| `poster_renamer` | Standalone Poster Renamer jobs. |
| `border_replacer` | Standalone Border Replacer jobs (note: present in code under a slightly different feature key set — verify in `core/hooks.py` and `services/discord_notifications.py`). |
| `unmatched_assets` | Unmatched Detection jobs. |
| `plex_upload` | Plex Upload jobs. |
| `idarr` | IDarr jobs. |
| `maker_monitor` | Maker Tools → Monitor jobs. |
| `system_errors` | Unhandled exceptions from the scheduler, queue, modules, services. Set this one separately — it's the "something deeper went wrong" pager. |

## Message format

PosterFlow sends Discord embed payloads, not plain content. The exact shape, per `discord_notifications.py` lines 215–245:

```json
{
  "content": "@here",
  "allowed_mentions": {"parse": ["here"]},
  "embeds": [
    {
      "title": "✅ Sync All — completed",
      "description": "Synced 12 drives: 247 added, 19 updated, 3 deleted",
      "color": 5025616,
      "fields": [
        {"name": "Duration", "value": "6m 56s", "inline": true},
        {"name": "Files transferred", "value": "266", "inline": true},
        {"name": "Errors", "value": "0", "inline": true}
      ],
      "image": {"url": "https://cdn.jsdelivr.net/gh/dweagle/extras@main/spacer.png"},
      "footer": {"text": "PosterFlow v0.5.3"},
      "timestamp": "2026-05-25T17:42:11.314000+00:00"
    }
  ]
}
```

### Title prefixes

The title is auto-prefixed with an emoji based on `event_type`:

| event_type | Prefix |
|---|---|
| `success` | ✅ |
| `error` | ❌ |
| `start` | 🚀 |
| `end` | 🏁 |
| `info` | ℹ️ |

### Colors

Common values:

| Hex | Decimal | Used for |
|---|---|---|
| `#4CAF50` | 5025616 | Success |
| `#F44336` | 16022824 | Error |
| `#64B5F6` | 6599158 | Info (default) |
| `#FFB74D` | 16758605 | Warning / partial-success |

The exact set of (event, color) mappings is in `discord_notifications.py`; per-feature defaults may differ.

### Truncation

Discord's hard limits and what PosterFlow does:

| Field | Discord limit | PosterFlow caps at |
|---|---|---|
| Embed title | 256 chars | not enforced (relies on Discord) |
| Embed description | 4096 chars | 3500 chars |
| Field name | 256 chars | as-is |
| Field value | 1024 chars | as-is |
| Footer text | 2048 chars | as-is |
| Fields per embed | 25 | enforced for workflow summaries |
| Embeds per message | 10 | enforced in workflow summary batch |

A workflow with 30 step-result fields is split: only the first 25 are included; the rest are summarized in the description.

### Spacer image

The `SPACER_IMAGE_URL` value `https://cdn.jsdelivr.net/gh/dweagle/extras@main/spacer.png` is a 1×1 transparent PNG hosted on jsDelivr. Discord renders the embed at full width when an image is present — without it, embeds collapse to text width and look cramped next to mentions. The image URL is hardcoded; if jsDelivr ever goes away or the asset is removed, embeds will visually shrink but still deliver content.

## Mention behavior

The mention field accepts five formats. The parser converts each into the right `allowed_mentions` shape so Discord actually notifies someone:

| Input | Discord parse type | Notes |
|---|---|---|
| `@here` | `["here"]` | Notifies online users in the channel. |
| `@everyone` | `["everyone"]` | Notifies all users. Spammy; use sparingly. |
| `<@123456789012345678>` | none (explicit) | Notifies a specific user by snowflake. |
| `<@&123456789012345678>` | none (explicit) | Notifies a specific role by snowflake. |
| `123456789012345678` | wrapped to `<@N>` | Bare snowflakes are interpreted as user IDs. |

Discord rejects payloads where the mention is in `content` but no matching parse type is in `allowed_mentions` — PosterFlow always sets `allowed_mentions` consistent with the mention string so the mention actually fires.

## Rate limits

Per the code: no client-side throttle. Each notification is a single `requests.post(..., timeout=10)`. Discord's own rate limit is 30 messages per channel per 60 seconds for webhooks; a busy workflow with `include_details=true` can approach this if you have ~30 jobs in flight.

If you do hit a rate limit, Discord returns 429 with a `Retry-After` header. PosterFlow does **not** read it — it logs a warning and the notification is dropped, the job is unaffected. The fix is to disable `include_details` for high-volume features or route them to a separate webhook in a separate channel.

## Silencing categories

Two ways to silence:

1. **Toggle per feature**: uncheck the feature's Enabled box in Settings → Notifications. Or uncheck just **On Success** / **On Error** if you want to keep one direction.
2. **Master kill switch**: uncheck "Enable Discord Notifications" at the top. Disables everything, no per-feature query.

There is no separate "do not disturb" schedule. If you want quiet hours, point the webhook at a Discord channel with channel-level notification settings that match.

## A real example

A successful Workflow run with all features enabled and `include_details=true` produces, on the configured webhook:

1. **One step-start embed** per workflow step (Sync All, Renamer, Border, Unmatched, Plex Upload). Title: `🚀 Sync All — started`. Color: info blue.
2. **One step-end embed** per step. Title: `🏁 Sync All — completed` or `❌ Sync All — failed`. Description: per-step stats. Color: success green or error red.
3. **One workflow summary embed** at the end. Up to 25 fields covering aggregate stats: drives synced, files added/updated/deleted, items matched, unmatched count, items uploaded to Plex. Color: success green for an all-green workflow, warning amber if any step had non-fatal errors, error red if any step failed.

A failed workflow short-circuits — the failing step's error embed fires, then the workflow summary fires with the failed step highlighted, and no subsequent steps run.

## Querying the test endpoint

To trigger a test message from the command line without using the UI:

```bash
curl -s -X POST http://localhost:8357/api/settings/notifications/discord/test \
  -H "Authorization: Bearer <pwd>" \
  -H "Content-Type: application/json" \
  -d '{
    "enabled": true,
    "webhook_url": "https://discord.com/api/webhooks/.../...",
    "features": {}
  }'
```

If the webhook URL is masked (`***masked***`) in the payload, the server resolves it from the DB by URL match. Returns `{"success": true, "message": "..."}` on success, `{"success": false, "message": "<reason>"}` on failure.

## What if I cannot reach a Discord webhook?

The screenshot captures for this documentation set were taken against a placeholder webhook URL that was never POST'd to. The example screenshots above are of the configuration UI, not real Discord messages. Set up your own webhook and use the **Send Test Notification** button to see what the message actually looks like in your channel — there is no test fixture in the codebase that demonstrates the rendered Discord embed.
