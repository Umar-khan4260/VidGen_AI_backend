# VidGen AI — Backend Server

An Express.js backend for the VidGen AI platform. It handles AI media generation (image / video / music) via the KIE.ai API, real-time credit billing, Firebase Auth verification, and Apple in-app purchase validation — all running inside a single Docker container on a VPS.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Runtime | Node.js 20 |
| Framework | Express.js 5 |
| Database | Firebase Firestore (via firebase-admin) |
| Auth | Firebase Authentication (JWT verification) |
| AI API | KIE.ai (image, video, music generation) |
| IAP | Apple App Store Server API v2 |
| Scheduler | node-cron (in-process settlement loop) |
| Container | Docker + Docker Compose |
| Reverse Proxy | Nginx + Let's Encrypt (SSL) |

---

## Project Structure

```
VidGen_AI_backend/
├── functions/
│   ├── src/
│   │   ├── app.js            # Express app setup
│   │   ├── server.js         # Entry point (direct node run)
│   │   ├── config/           # Firebase admin init, env config
│   │   ├── controllers/      # Route handlers (image, video, music, IAP...)
│   │   ├── middleware/       # Auth middleware (Firebase JWT verify)
│   │   ├── routes/           # Express router definitions
│   │   ├── services/         # KIE.ai API calls, credit service
│   │   ├── cron/             # Billing settlement cron job
│   │   └── utils/            # Helpers
│   ├── index.js              # Firebase Cloud Functions entry (optional)
│   └── package.json
├── deploy/
│   └── nginx.conf.example    # Nginx reverse-proxy config template
├── .env.example              # ← copy this to .env and fill values
├── .env                      # ← your real secrets (gitignored, never commit)
├── service-account-key.json  # ← Firebase service account key (gitignored)
├── docker-compose.yml
├── firebase.json
├── firestore.rules
└── firestore.indexes.json
```

---

## Prerequisites

- **Node.js 20** (for local dev only)
- **Docker + Docker Compose** (for VPS deployment)
- **Firebase project** with Firestore enabled
- **KIE.ai API key** — from [https://kie.ai](https://kie.ai)
- **Firebase service account key** — JSON file from Firebase Console

---

## 1. Clone the Repository

```bash
git clone https://github.com/Umar-khan4260/VidGen_AI_backend.git
cd VidGen_AI_backend
```

---

## 2. Set Up Environment Variables

Copy the example file and fill in real values:

```bash
# Linux / macOS
cp .env.example .env

# Windows (PowerShell)
Copy-Item .env.example .env
```

Open `.env` and set the following:

```env
# KIE.ai platform API key
KIE_API_KEY=your_kie_api_key_here

# Port the server listens on
PORT=8080

NODE_ENV=production

# Apple IAP (leave ALLOW_UNVERIFIED_PURCHASES=true if not using Apple verification yet)
APPLE_ISSUER_ID=your_issuer_id
APPLE_KEY_ID=your_key_id
APPLE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----"
APPLE_BUNDLE_ID=com.vidgen
ALLOW_UNVERIFIED_PURCHASES=true
```

> **Never commit `.env` or `service-account-key.json` — both are gitignored.**

---

## 3. Add Firebase Service Account Key

1. Go to **Firebase Console** → Project Settings → **Service Accounts**
2. Click **Generate new private key** → Download the JSON file
3. Rename it to `service-account-key.json`
4. Place it in the **root** of `VidGen_AI_backend/` (same level as `docker-compose.yml`)

```bash
# Lock down permissions (Linux/macOS)
chmod 600 service-account-key.json
```

---

## 4. Running Locally (without Docker)

```bash
cd functions
npm install
npm run dev        # uses nodemon — auto-restarts on file changes
```

The server starts at `http://localhost:8080`.

> Set `GOOGLE_APPLICATION_CREDENTIALS` in `.env` to the **absolute path** of `service-account-key.json` for local runs.

---

## 5. Running with Docker (Recommended for VPS)

From the **root** of the repo (where `docker-compose.yml` is):

```bash
# Build and start the container in the background
docker compose up -d --build

# Check it's running
curl http://127.0.0.1:8080/health
# Expected: {"status":"ok, health route is working"}

# View live logs
docker compose logs -f

# Watch the billing settlement cron specifically
docker compose logs -f app | grep settler

# Stop the container
docker compose down

# Restart after a code or .env change
docker compose up -d --build
```

---

## 6. VPS Deployment (Hostinger Ubuntu 22.04 / 24.04)

### 6.1 — Prepare the Server

```bash
apt update && apt -y upgrade
apt install -y docker.io docker-compose-v2 nginx certbot python3-certbot-nginx
systemctl enable --now docker
```

### 6.2 — Clone & Configure

```bash
mkdir -p /opt/vidgen && cd /opt/vidgen
git clone https://github.com/Umar-khan4260/VidGen_AI_backend.git backend
cd backend
```

Place `.env` and `service-account-key.json` in `/opt/vidgen/backend/` (see steps 2 & 3 above).

### 6.3 — Start the Container

```bash
docker compose up -d --build
curl http://127.0.0.1:8080/health
```

### 6.4 — Set Up Nginx + HTTPS

1. Point a DNS `A` record → `api.yourdomain.com` → your VPS IP
2. Run:

```bash
cp deploy/nginx.conf.example /etc/nginx/sites-available/vidgen

# Edit the file and set your domain in server_name
nano /etc/nginx/sites-available/vidgen

ln -s /etc/nginx/sites-available/vidgen /etc/nginx/sites-enabled/
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx

# Install free SSL certificate
certbot --nginx -d api.yourdomain.com
```

> ⚠️ **Cloudflare users:** Keep the proxy **disabled (grey cloud / DNS-only)** for this subdomain. Cloudflare's free tier kills requests over 100 seconds, which breaks long AI generation jobs.

---

## 7. Connect the Flutter App

Build the Flutter app pointing to your deployed URL (must end with `/api`):

```bash
flutter build ipa --dart-define=BACKEND_BASE_URL=https://api.yourdomain.com/api
```

Or change `defaultValue` in `lib/core/services/backend_api_service.dart`.

---

## 8. Verify Everything Works

1. Open the app → generate one image → it should succeed
2. Check Firestore: `users/{userId}/tasks/{taskId}` exists with `settled: true`
3. User's `credits` decreased by the KIE-reported amount
4. A `transactions` entry with a negative `amount` appeared
5. Kill the app mid-generation → within ~10 min the settler cron bills it automatically

---

## 9. Available npm Scripts (inside `functions/`)

| Command | Description |
|---|---|
| `npm run dev` | Start with nodemon (auto-reload on save) |
| `npm start` | Start with plain node (production-like) |
| `npm run lint` | Run ESLint |
| `npm run serve` | Start Firebase local emulator |
| `npm run deploy` | Deploy to Firebase Cloud Functions |
| `npm run logs` | Stream Firebase Functions logs |

---

## 10. Configurable .env Tunables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `8080` | Port the Express server listens on |
| `MAX_UPLOAD_MB` | `200` | Max file upload size |
| `IMAGE_FLOOR_CREDITS` | `40` | Min credits required to start an image job |
| `VIDEO_FLOOR_CREDITS` | `80` | Min credits required to start a video job |
| `MUSIC_FLOOR_CREDITS` | `10` | Min credits required to start a music job |
| `IMAGE_FALLBACK_CREDITS` | `5` | Flat charge when KIE reports no consumption (image) |
| `VIDEO_FALLBACK_CREDITS` | `25` | Flat charge when KIE reports no consumption (video) |
| `MUSIC_FALLBACK_CREDITS` | `8` | Flat charge when KIE reports no consumption (music) |
| `ALLOW_UNVERIFIED_PURCHASES` | `true` | Set `false` once Apple IAP verification is live |

---

## 11. Ongoing Maintenance

```bash
# Pull latest code and rebuild container
cd /opt/vidgen/backend
git pull && docker compose up -d --build

# Monthly security patches (Ubuntu)
apt update && apt -y upgrade

# Monitor billing activity
docker compose logs -f app | grep settler
```

---

## Security Checklist

- [ ] `.env` is **not committed** to git
- [ ] `service-account-key.json` is **not committed** to git
- [ ] `chmod 600 service-account-key.json` on the VPS
- [ ] HTTPS is enabled (iOS ATS blocks plain HTTP)
- [ ] `ALLOW_UNVERIFIED_PURCHASES=false` once Apple verification is implemented
- [ ] Rotate `KIE_API_KEY` and Firebase service account key periodically
