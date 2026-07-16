# Palworld Webhook Watcher

![Palworld Webhook Watcher Discord preview](Screenshot%202026-07-17%20002440.png)

Discord webhook status updater for a Palworld dedicated server. It reads the Palworld REST API, updates one Discord webhook message, shows player/server status, and can optionally trigger scheduled restarts.

## Features

- Updates an existing Discord webhook message instead of spamming new messages.
- Shows server status, player count, player list, FPS, uptime, world day, and next restart.
- Supports custom Discord message layout through `message-template.jsonc`.
- Supports custom icons/emojis through `icons.jsonc`.
- Can run directly with Node.js or inside Docker Compose.
- Persists Discord message ID and restart state.

## Requirements

- Node.js 18 or newer, or Docker with Docker Compose.
- A Discord webhook URL.
- Palworld REST API enabled and reachable from where this app runs.

## Setup

Copy the example environment file:

```bash
cp .env.example .env
```

Edit `.env` and set at least:

```env
DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/...
PALWORLD_REST_BASE_URL=http://your-palworld-server:8212/v1/api
PALWORLD_REST_USERNAME=admin
PALWORLD_REST_PASSWORD=your-rest-password
PALWORLD_GAME_ADDRESS=your-palworld-server:8211
TIME_ZONE=Asia/Jakarta
```

Do not commit `.env`. It contains secrets.

## Run With Node.js

```bash
npm start
```

To check JavaScript syntax:

```bash
npm run check
```

## Run With Docker Compose

For normal use, you only need a `.env` file and a `docker-compose.yml` file. You do not need to clone this repository if you use the published Docker image.

Create `.env`:

```env
DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/...
PALWORLD_REST_BASE_URL=http://your-palworld-server:8212/v1/api
PALWORLD_REST_USERNAME=admin
PALWORLD_REST_PASSWORD=your-rest-password
PALWORLD_GAME_ADDRESS=your-palworld-server:8211
TIME_ZONE=Asia/Jakarta
RESTART_ENABLED=false
RESTART_TIMES=04:00
```

Create `docker-compose.yml`:

```yaml
services:
  palworld-webhook:
    image: ghcr.io/rachmad42/palworld-webhook-watcher:latest
    container_name: palworld-webhook-watcher
    restart: unless-stopped
    env_file:
      - .env
    environment:
      NODE_ENV: production
      TZ: ${TIME_ZONE:-Asia/Jakarta}
      PALWORLD_REST_BASE_URL: ${PALWORLD_REST_BASE_URL:-http://host.docker.internal:8212/v1/api}
      PALWORLD_GAME_ADDRESS: ${PALWORLD_GAME_ADDRESS:-127.0.0.1:8211}
      MESSAGE_ID_FILE: /app/data/.discord-message-id
      STATE_FILE: /app/data/.palworld-webhook-state.json
      MESSAGE_TEMPLATE_FILE: /app/message-template.jsonc
      ICONS_FILE: /app/icons.jsonc
      TIME_ZONE: ${TIME_ZONE:-Asia/Jakarta}
    volumes:
      - webhook-data:/app/data
    extra_hosts:
      - host.docker.internal:host-gateway

volumes:
  webhook-data:
```

Replace the image name with your published image, for example:

```yaml
image: ghcr.io/rachmad42/palworld-webhook-watcher:latest
```

Start:

```bash
docker compose up -d
```

View logs:

```bash
docker compose logs -f palworld-webhook
```

Stop:

```bash
docker compose down
```

The Docker setup stores `.discord-message-id` and `.palworld-webhook-state.json` in the `webhook-data` volume so they survive container recreation.

## Build From Source

If you cloned this repository and want to build the image locally, use the included `docker-compose.yml`:

```bash
docker compose up -d --build
```

You can also copy `docker-compose.example.yml` as a starting point for a prebuilt-image deployment.

## Publish Docker Image

This repository includes a GitHub Actions workflow at `.github/workflows/docker-publish.yml`. It publishes the image to GitHub Container Registry on pushes to `main`, version tags like `v1.0.0`, or manual workflow runs.

After pushing to GitHub, the image will be available as:

```text
ghcr.io/rachmad42/palworld-webhook-watcher:latest
```

If the package is private, open the package page in GitHub and change its visibility to public so users can pull it without logging in.

## Docker Networking Notes

If Palworld REST API runs on the same host as Docker, use:

```env
PALWORLD_REST_BASE_URL=http://host.docker.internal:8212/v1/api
```

If Palworld REST API runs on another VPS/server, use its public or private reachable IP:

```env
PALWORLD_REST_BASE_URL=http://158.178.237.188:8212/v1/api
PALWORLD_GAME_ADDRESS=158.178.237.188:8211
```

If this app and Palworld run in the same Docker network, use the Palworld service/container name:

```env
PALWORLD_REST_BASE_URL=http://palworld:8212/v1/api
```

Avoid `127.0.0.1` from inside Docker unless the REST API is running in the same container. Inside a container, `127.0.0.1` means that container itself.

## Scheduled Restart

Enable scheduled restart in `.env`:

```env
RESTART_ENABLED=true
RESTART_TIMES=04:00
RESTART_WAIT_SECONDS=300
TIME_ZONE=Asia/Jakarta
```

`RESTART_TIMES` uses `HH:mm` format and follows `TIME_ZONE`. Multiple times can be separated with commas:

```env
RESTART_TIMES=04:00,16:00
```

## Customization

Edit `message-template.jsonc` to change the Discord message structure.

Edit `icons.jsonc` to change icons or Discord custom emojis.

After changing these files in Docker, restart the container:

```bash
docker compose restart palworld-webhook
```

## Troubleshooting

Check which REST URL the container is using:

```bash
docker compose exec palworld-webhook printenv PALWORLD_REST_BASE_URL
```

If logs show `Unauthorized`, check `PALWORLD_REST_USERNAME` and `PALWORLD_REST_PASSWORD`.

If logs show `fetch failed` or timeout, check that the Palworld REST API URL is reachable from the container/VPS and that port `8212` is open.

If next restart time appears shifted, confirm:

```env
TIME_ZONE=Asia/Jakarta
```

Then pull the latest image and recreate the container:

```bash
docker compose pull
docker compose up -d
```

If you are building from source, use `docker compose up -d --build` instead.
