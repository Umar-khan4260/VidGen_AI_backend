# VidGen AI Backend — Hostinger VPS Deployment Guide

The backend is a plain Express app (`functions/src/server.js`) + Docker. It
keeps using **Firebase Auth + Firestore** for data (free tier is fine) — only
the Express server moves to the VPS. Billing settlement runs as an in-process
**node-cron** loop (every 10 min), replacing Firebase's scheduler.

---

## 1. VPS prep (Ubuntu 22.04/24.04)

```bash
apt update && apt -y upgrade
apt install -y docker.io docker-compose-v2 nginx certbot python3-certbot-nginx
systemctl enable --now docker
```

## 2. Code + secrets

```bash
mkdir -p /opt/vidgen && cd /opt/vidgen
git clone https://github.com/Umar-khan4260/VidGen_AI_backend.git backend
cd backend
```

Place these two files in `VidGen_AI_backend/` (both gitignored, NEVER commit):

**`.env`**
```
KIE_API_KEY=<your new rotated key>
NODE_ENV=production
PORT=8080
ALLOW_UNVERIFIED_PURCHASES=true   # false ONLY after Apple verification is implemented
```

**`service-account-key.json`** — Firebase console → Project settings →
Service accounts → Create key (JSON). After rotating, the new key goes here.
Lock it down: `chmod 600 service-account-key.json`

## 3. Run

```bash
docker compose up -d --build
curl http://127.0.0.1:8080/health
# expected: {"status":"ok, health route is working"}
```

The settlement cron starts automatically with the app (visible in
`docker compose logs -f` as `[settler] In-process settlement cron started`).

## 4. Domain + HTTPS (mandatory for iOS — ATS blocks plain http)

1. DNS: `A` record `api.yourdomain.com` → VPS IP (Hostinger DNS or your registrar)
2. ```bash
   cp deploy/nginx.conf.example /etc/nginx/sites-available/vidgen
   nano /etc/nginx/sites-available/vidgen      # set server_name
   ln -s /etc/nginx/sites-available/vidgen /etc/nginx/sites-enabled/
   rm -f /etc/nginx/sites-enabled/default
   nginx -t && systemctl reload nginx
   certbot --nginx -d api.yourdomain.com       # installs SSL + https redirect
   ```

> **Cloudflare warning:** do NOT enable the Cloudflare proxy (orange cloud)
> on this subdomain. Free Cloudflare kills any request over 100 seconds, and
> this backend legitimately serves multi-minute uploads/generations. Use
> DNS-only (grey cloud) if the domain is on Cloudflare.

## 5. Point the app at this server

Build the Flutter app with your URL — it **must end with `/api`**:

```bash
flutter build ipa --dart-define=BACKEND_BASE_URL=https://api.yourdomain.com/api
```

or change `defaultValue` in `lib/core/services/backend_api_service.dart`.

## 6. Verify end-to-end

1. App: generate one image → it should succeed
2. Firestore: `users/{sharedCloudId}/tasks/{taskId}` exists, `settled: true`
3. User's `credits` dropped by the KIE-reported amount, a `transactions`
   entry with negative `amount` appeared
4. Kill the app mid-generation → within ~10 min the settler log line
   `Settled task ...` appears and billing still happened

## Tunables (.env, optional)

| Var | Default | Meaning |
|---|---|---|
| `MAX_UPLOAD_MB` | 200 | Upload size cap |
| `IMAGE_FLOOR_CREDITS` | 40 | Min balance to start an image generation |
| `VIDEO_FLOOR_CREDITS` | 80 | Min balance to start a video generation |
| `MUSIC_FLOOR_CREDITS` | 10 | Min balance to start music generation |
| `IMAGE_FALLBACK_CREDITS` | 5 | Flat charge when KIE reports no creditsConsumed (image) |
| `VIDEO_FALLBACK_CREDITS` | 25 | Flat charge when KIE reports no creditsConsumed (video) |
| `MUSIC_FALLBACK_CREDITS` | 8 | Flat charge when KIE reports no creditsConsumed (music) |

## Ongoing maintenance

```bash
apt update && apt -y upgrade          # monthly security patches
cd /opt/vidgen/backend
git pull && docker compose up -d --build
```

`docker compose logs -f app | grep settler` — watch billing activity.
