# Reverse Proxy

PosterFlow is a single-port FastAPI app — both the SPA bundle and the API live on container port 8000. To put it behind a proxy you only need to forward HTTP and WebSocket upgrade to one upstream. There is **no** sub-path support; PosterFlow assumes it's mounted at `/`. See the [Sub-paths](#sub-paths) section.

There is no authentication built into PosterFlow's HTTP layer except the optional app password ([`security.md`](security.md#app-password)). If you want OIDC, SAML, mTLS, etc., you front it with a proxy that does the auth and proxies to PosterFlow.

## Required upstream behavior

| Property | Why |
|---|---|
| Forward `Connection: Upgrade` and `Upgrade: websocket` | Three WebSocket endpoints under `/api/jobs/ws`, `/api/logs/ws`, `/api/job-logs/{type}/live`. The live status panel is unusable without this. |
| Long read timeout on the upstream | A poster sync can take 30+ minutes. The WebSocket sends heartbeats every 30 s, so any read timeout above ~60 s is fine. 24 h is safe. |
| HTTP/1.1 between proxy and upstream | uvicorn supports HTTP/1.1; HTTP/2 is not configured in PosterFlow. WebSockets work over HTTP/1.1 only. |
| Pass-through of `Host` (or set a sane one) | Not strictly required by PosterFlow's logic, but FastAPI uses `request.url` for some responses. |
| Body size large enough for backup restore | `POST /api/backup/` accepts up to 50 MB. Service-account JSON uploads are small. |

PosterFlow does **not** trust `X-Forwarded-*` headers anywhere. The auth middleware reads from `Authorization` directly; CORS reads from the configured origin list, not `Origin` reflection. Rate limiting (slowapi) keys off `get_remote_address()` which returns the direct peer — if you want true per-user limits behind a proxy, you'll need to handle that at the proxy layer.

## Traefik v2 / v3 — Docker labels

Drop these labels into your compose file. Replace `posterflow.example.com` and the cert resolver name with your own.

```yaml
services:
  posterflow:
    image: dweagle/posterflow:develop
    container_name: posterflow
    volumes:
      - ./config:/config
    environment:
      - PUID=1000
      - PGID=1000
      - TZ=America/New_York
      # Add your proxy hostname so the browser can reach the API:
      - CORS_ORIGINS=https://posterflow.example.com
    restart: unless-stopped
    networks:
      - traefik
    labels:
      - traefik.enable=true
      - traefik.http.routers.posterflow.rule=Host(`posterflow.example.com`)
      - traefik.http.routers.posterflow.entrypoints=websecure
      - traefik.http.routers.posterflow.tls.certresolver=letsencrypt
      - traefik.http.services.posterflow.loadbalancer.server.port=8000
      # WebSocket upgrade is automatic; Traefik forwards Connection/Upgrade by default.
      # Useful long timeout for slow syncs streaming through job_logs websocket:
      - traefik.http.services.posterflow.loadbalancer.responseforwarding.flushinterval=100ms

networks:
  traefik:
    external: true
```

Notes:

- Traefik handles the WebSocket upgrade automatically; no extra middleware required. This is unlike nginx, where you have to explicitly forward the Upgrade header.
- The `flushinterval=100ms` label is optional but recommended — without it, the streaming progress bar in the UI can appear jerky because Traefik buffers small WS frames.
- If you put this on the internal `web` entrypoint (HTTP), set `CORS_ORIGINS=http://posterflow.example.com` instead of HTTPS.
- The `loadbalancer.server.port` is the container port (8000), not the host port. If your compose has `ports: ["8357:8000"]`, Traefik does not need that mapping — Traefik talks to the container directly via the shared `traefik` network.

If your Traefik is on a separate compose stack, you may also need:

```yaml
    networks:
      - default
      - traefik
```

so the container is on both its own network (for any other internal stack dependencies) and Traefik's network.

## nginx

A production-ready `server` block:

```nginx
upstream posterflow {
    server posterflow.internal:8357;   # Or container_name:8000 if on the same Docker network.
    keepalive 32;
}

map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}

server {
    listen 443 ssl http2;
    server_name posterflow.example.com;

    ssl_certificate /etc/letsencrypt/live/posterflow.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/posterflow.example.com/privkey.pem;

    # Backup restore is the largest upload PosterFlow accepts (50 MB max).
    client_max_body_size 55M;

    # API + SPA — everything proxies the same way.
    location / {
        proxy_pass http://posterflow;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # WebSocket upgrade — required for /api/jobs/ws, /api/logs/ws, /api/job-logs/*/live.
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;

        # Long enough to survive a multi-hour sync.
        proxy_read_timeout 86400s;
        proxy_send_timeout 86400s;
        proxy_buffering off;
    }
}
```

Notes:

- `proxy_buffering off` matters for WebSockets and the SSE-adjacent log streaming. With buffering on, the live log panel appears to hang for several seconds before flushing — confusing.
- `proxy_read_timeout 86400s` (24 h) is overkill for the request lifecycle but exactly right for WebSocket connections that you want to last the duration of a long sync. PosterFlow heartbeats every 30 s, so a 60 s timeout will close the connection between heartbeats only on a stuck server.
- Add `posterflow.example.com` (with the right scheme) to `CORS_ORIGINS` in your compose env.
- `keepalive 32` in the upstream block reuses connections; saves a handful of ms per request.

If you're running nginx on the same host as PosterFlow (not as a separate container), use `proxy_pass http://127.0.0.1:8357;` and skip the upstream block.

## Caddy

Caddy is the path of least resistance:

```
posterflow.example.com {
    reverse_proxy posterflow:8000
}
```

Caddy forwards WebSocket Upgrade headers automatically; it sets a generous read timeout by default; it sources a Let's Encrypt cert without configuration. Add the FQDN to `CORS_ORIGINS` and you're done.

For a longer-lived setup with explicit headers:

```
posterflow.example.com {
    reverse_proxy posterflow:8000 {
        flush_interval 100ms
        transport http {
            read_timeout 24h
            write_timeout 24h
        }
    }
}
```

## Sub-paths

**PosterFlow does not support being mounted at a sub-path** like `https://example.com/posterflow/`. The SPA at `/` resolves all asset URLs absolute (`/assets/...`), and the SPA router does not respect a base path. Mounting under a sub-path will break the JS bundle resolution and the WebSocket connections.

If you absolutely must put PosterFlow behind a path, set up a wildcard subdomain instead (`posterflow.example.com` rather than `example.com/posterflow/`). This is the supported topology.

## Forward auth compatibility

PosterFlow can sit behind forward-auth (Authelia, PocketID, traefik-forward-auth, oauth2-proxy) **if** the auth provider:

- Allows WebSocket upgrade through. Some auth providers terminate the request to do an OAuth round-trip; if they do this for `/api/jobs/ws`, the WebSocket never opens and the UI sits there with empty job lists. Verify with `wscat`:

  ```bash
  npm i -g wscat
  wscat -c wss://posterflow.example.com/api/jobs/ws \
      -H "Cookie: <your-authelia-session-cookie>"
  ```

  Expect the server to send a `{"jobs":[...]}` or `{"heartbeat":...}` payload within 1 second of the handshake. Anything else (HTML, 302, timeout) means your forward auth is intercepting.

- Does not strip `Authorization: Bearer` headers. PosterFlow's app password uses this header. If your forward auth uses bearer tokens for itself, you have a header collision — disable PosterFlow's app password in this case and rely solely on the forward auth.

- Plays nicely with the `POST /api/posterflow/plex-upload/webhook` endpoint, which is hit by Radarr/Sonarr from inside your network with no session cookie. Either:
  - Exclude `/api/posterflow/plex-upload/webhook` from forward auth, **or**
  - Configure Radarr/Sonarr to include a static bearer token, **or**
  - Use a separate hostname for inbound webhooks that bypasses forward auth entirely.

Recommended topology: a public hostname behind forward auth for human users + a separate internal hostname (no forward auth, no public DNS) for Radarr/Sonarr webhooks.

## CORS

Once PosterFlow is behind a proxy on a non-default hostname, the browser's CORS preflight will reject API calls unless the proxy hostname is in PosterFlow's `CORS_ORIGINS`. Add it:

```yaml
environment:
  - CORS_ORIGINS=https://posterflow.example.com,https://www.photopea.com
```

Keep `https://www.photopea.com` if you use Maker Tools' PSD editing — see [`configuration.md`](configuration.md#cors).

`CORS_ORIGINS` is an exact-match comma-separated list; wildcards are not supported. If you have both an internal and external hostname, list both.

## TLS termination

PosterFlow does not itself terminate TLS. It expects clear-text HTTP from upstream. Run TLS at the proxy. Inside the home LAN this can be a self-signed cert; on the public internet, Let's Encrypt via Traefik/Caddy/cert-manager.

The websocket scheme follows the page scheme — if the SPA is served from `https://`, the WebSocket connections use `wss://`. PosterFlow's SPA derives the WebSocket URL from `window.location.protocol`, so no extra configuration is needed in the app.

## Connectivity verification checklist

After you set up the proxy, walk through this list:

1. **Browser** — load `https://posterflow.example.com/` and confirm the dashboard renders. Check the dev console for CORS errors on `/api/*` calls; if you see any, your hostname isn't in `CORS_ORIGINS`.
2. **WebSocket** — open the Logs page → System tab. You should see new log lines appearing as you click around. If the panel is empty but the REST `GET /api/logs/` works, the WebSocket upgrade isn't passing through your proxy.
3. **Live job progress** — start a small job (e.g., subscribe to a community drive and click Sync). The sidebar's mini progress widget should update in real time. Same diagnosis as #2 if it doesn't.
4. **Backup download** — Settings → Backup & Restore → Download Backup. The response is a binary `.zip`. If your proxy chokes on the download (truncation, hangs), check `proxy_buffering` and the response timeout.
5. **Photopea round-trip** (only if you use Maker Tools): export a PSD, edit in Photopea, hit File → Save. If Save fails with a CORS message in Photopea's console, your `CORS_ORIGINS` is missing `https://www.photopea.com` or your proxy is stripping the `Access-Control-Allow-Private-Network` header on the OPTIONS preflight (PosterFlow sets it; don't let your proxy remove it).

A failure mode worth noting: some proxies — especially older nginx defaults — buffer the entire WebSocket initial message before forwarding. That hides the heartbeats and gives the impression of a stuck connection. `proxy_buffering off` fixes it.
