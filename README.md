# Palworld Webhook Watcher

![Palworld Webhook Watcher Discord preview](Screenshot%202026-07-17%20002440.png)

Discord webhook status updater for a Palworld dedicated server. It updates one Discord message with server status, players, performance, uptime, world info, and optional restart schedule.

## Features

- One persistent Discord webhook message.
- Palworld REST API status, players, FPS, uptime, and world info.
- Optional scheduled restart.
- Docker Compose ready.
- Editable Discord template and icons from `./config`.

## Docker Compose

Create `docker-compose.yml`:

```yaml
services:
  palworld-webhook:
    image: ghcr.io/rachmad42/palworld-webhook-watcher:latest
    container_name: palworld-webhook-watcher
    restart: unless-stopped
    environment:
      DISCORD_WEBHOOK_URL: https://discord.com/api/webhooks/your-webhook-id/your-webhook-token
      PALWORLD_REST_BASE_URL: http://your-palworld-server:8212/v1/api
      PALWORLD_REST_USERNAME: admin
      PALWORLD_REST_PASSWORD: change-me
      PALWORLD_GAME_ADDRESS: your-palworld-server:8211
      REFRESH_INTERVAL_SECONDS: 30
      REQUEST_TIMEOUT_SECONDS: 10
      MESSAGE_ID_FILE: /app/data/.discord-message-id
      STATE_FILE: /app/data/.palworld-webhook-state.json
      MESSAGE_TEMPLATE_FILE: /app/config/message-template.jsonc
      ICONS_FILE: /app/config/icons.jsonc
      TIME_ZONE: Asia/Jakarta
      RESTART_ENABLED: false
      RESTART_TIMES: "04:00"
      RESTART_WAIT_SECONDS: 300
      RESTART_MESSAGE: Scheduled restart in 5 minutes. Please log out safely.
      MAX_PLAYER_NAMES: 10
    volumes:
      - webhook-data:/app/data
      - ./config:/app/config

volumes:
  webhook-data:
```

Start:

```bash
docker compose up -d
docker compose logs -f palworld-webhook
```

Update:

```bash
docker compose pull
docker compose up -d
```

## REST API URL

Use the URL that is reachable from the webhook container:

```yaml
# Palworld REST on another VPS/server
PALWORLD_REST_BASE_URL: http://your-palworld-server-ip:8212/v1/api

# Palworld REST on the Docker host
PALWORLD_REST_BASE_URL: http://host.docker.internal:8212/v1/api

# Palworld REST in the same Docker network
PALWORLD_REST_BASE_URL: http://palworld:8212/v1/api
```

Avoid `127.0.0.1` inside Docker unless the REST API is in the same container.

## Custom Template And Icons

On first start, the app creates:

```text
config/message-template.jsonc
config/icons.jsonc
```

Edit those files, then restart:

```bash
docker compose restart palworld-webhook
```

## Scheduled Restart

Enable it in `docker-compose.yml`:

```yaml
RESTART_ENABLED: true
RESTART_TIMES: "04:00"
TIME_ZONE: Asia/Jakarta
```

Multiple times:

```yaml
RESTART_TIMES: "04:00,16:00"
```

## Troubleshooting

Check the URL used by the container:

```bash
docker compose exec palworld-webhook printenv PALWORLD_REST_BASE_URL
```

- `Unauthorized`: check `PALWORLD_REST_USERNAME` and `PALWORLD_REST_PASSWORD`.
- `fetch failed` or timeout: check the REST URL and port `8212`.
- `EACCES` on `/app/config`: run `sudo chown -R 1000:1000 config`, then restart.
- Wrong restart time: check `TIME_ZONE`.

## Run Without Docker

```bash
cp .env.example .env
npm start
```

Requires Node.js 18 or newer.
