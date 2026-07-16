'use strict';

const fs = require('node:fs');
const path = require('node:path');

loadEnvFile(path.join(process.cwd(), '.env'));

const configuredTimeZone = env('TIME_ZONE', process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC');
process.env.TZ = configuredTimeZone;

const config = {
  webhookUrl: requireEnv('DISCORD_WEBHOOK_URL'),
  restBaseUrl: trimTrailingSlash(env('PALWORLD_REST_BASE_URL', 'http://127.0.0.1:8212/v1/api')),
  restUsername: env('PALWORLD_REST_USERNAME', 'admin'),
  restPassword: env('PALWORLD_REST_PASSWORD', ''),
  gameAddress: env('PALWORLD_GAME_ADDRESS', '127.0.0.1:8211'),
  refreshIntervalSeconds: numberEnv('REFRESH_INTERVAL_SECONDS', 30),
  requestTimeoutSeconds: numberEnv('REQUEST_TIMEOUT_SECONDS', 10),
  metricsRefreshSeconds: numberEnv('METRICS_REFRESH_SECONDS', 30),
  playersRefreshSeconds: numberEnv('PLAYERS_REFRESH_SECONDS', 30),
  staticRefreshSeconds: numberEnv('STATIC_REFRESH_SECONDS', 600),
  messageIdFile: env('MESSAGE_ID_FILE', '.discord-message-id'),
  stateFile: env('STATE_FILE', '.palworld-webhook-state.json'),
  messageTemplateFile: env('MESSAGE_TEMPLATE_FILE', 'message-template.jsonc'),
  iconsFile: env('ICONS_FILE', 'icons.jsonc'),
  timeZone: configuredTimeZone,
  restartEnabled: boolEnv('RESTART_ENABLED', false),
  restartTimes: parseRestartTimes(env('RESTART_TIMES', '04:00')),
  restartWaitSeconds: numberEnv('RESTART_WAIT_SECONDS', 300),
  restartMessage: env('RESTART_MESSAGE', 'Scheduled restart in 5 minutes. Please log out safely.'),
  maxPlayerNames: numberEnv('MAX_PLAYER_NAMES', 10)
};

let isTickRunning = false;
const apiCache = new Map();

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exitCode = 1;
});

async function main() {
  ensureConfigFiles();

  console.log('Palworld Discord webhook updater started.');
  console.log(`REST API: ${config.restBaseUrl}`);
  console.log(`Game address: ${config.gameAddress}`);
  console.log(`Refresh interval: ${config.refreshIntervalSeconds}s`);

  if (config.restartEnabled) {
    console.log(`Restart schedule enabled: ${config.restartTimes.map(formatTimeConfig).join(', ')}`);
  } else {
    console.log('Restart schedule disabled.');
  }

  await tick();
  setInterval(tick, config.refreshIntervalSeconds * 1000);
}

async function tick() {
  if (isTickRunning) {
    console.warn('Previous refresh is still running; skipping this cycle.');
    return;
  }

  isTickRunning = true;
  try {
    const now = new Date();
    const data = await collectPalworldData(now);
    const variables = buildVariables(data, now);
    const payload = buildDiscordPayload(variables);

    await upsertWebhookMessage(payload);
    await runDueRestart(now, variables);

    if (data.errors.length > 0) {
      console.warn(`Palworld REST warnings: ${data.errors.join(' | ')}`);
    }

    console.log(
      `[${now.toISOString()}] Updated Discord status: ${variables.status} (${data.requestCount} REST request${data.requestCount === 1 ? '' : 's'})`
    );
  } catch (error) {
    console.error('Refresh failed:', error.message);
  } finally {
    isTickRunning = false;
  }
}

async function collectPalworldData(now) {
  const endpoints = [
    {
      key: 'metrics',
      endpoint: '/metrics',
      ttlSeconds: config.metricsRefreshSeconds,
      dynamic: true
    },
    {
      key: 'players',
      endpoint: '/players',
      ttlSeconds: config.playersRefreshSeconds,
      dynamic: true
    },
    {
      key: 'info',
      endpoint: '/info',
      ttlSeconds: config.staticRefreshSeconds,
      dynamic: false
    },
    {
      key: 'settings',
      endpoint: '/settings',
      ttlSeconds: config.staticRefreshSeconds,
      dynamic: false
    }
  ];

  let requestCount = 0;
  const results = await Promise.allSettled(
    endpoints.map(async (item) => {
      const result = await cachedPalworldGet(item.key, item.endpoint, item.ttlSeconds, now);
      if (result.requested) {
        requestCount += 1;
      }

      return {
        ...item,
        ...result
      };
    })
  );

  const data = {
    online: false,
    now,
    errors: [],
    requestCount
  };

  for (const result of results) {
    if (result.status === 'fulfilled') {
      const item = result.value;
      data[item.key] = item.value;

      if (item.dynamic && item.value && isFreshEnough(item.fetchedAt, item.ttlSeconds, now)) {
        data.online = true;
      }

      if (item.error) {
        data.errors.push(item.error);
      }
    } else {
      data.errors.push(result.reason.message);
    }
  }

  return data;
}

async function cachedPalworldGet(key, endpoint, ttlSeconds, now) {
  const cached = apiCache.get(key);
  const ttlMs = Math.max(0, ttlSeconds) * 1000;

  if (cached && ttlMs > 0 && now.getTime() - cached.fetchedAt.getTime() < ttlMs) {
    return {
      value: cached.value,
      fetchedAt: cached.fetchedAt,
      requested: false
    };
  }

  try {
    const value = await palworldGet(endpoint);
    const fetchedAt = new Date();
    apiCache.set(key, {
      value,
      fetchedAt
    });

    return {
      value,
      fetchedAt,
      requested: true
    };
  } catch (error) {
    if (cached) {
      return {
        value: cached.value,
        fetchedAt: cached.fetchedAt,
        requested: true,
        error: `${endpoint} refresh failed; using cached data: ${error.message}`
      };
    }

    throw error;
  }
}

function isFreshEnough(fetchedAt, ttlSeconds, now) {
  const ttlMs = Math.max(config.refreshIntervalSeconds, ttlSeconds, 1) * 1000;
  const maxAgeMs = Math.max(ttlMs * 2, config.refreshIntervalSeconds * 1000 * 2);
  return now.getTime() - fetchedAt.getTime() <= maxAgeMs;
}

function buildVariables(data, now) {
  const icons = loadIcons();
  const info = data.info || {};
  const metrics = data.metrics || {};
  const playersPayload = data.players || {};
  const settings = data.settings || {};
  const players = Array.isArray(playersPayload.players) ? playersPayload.players : [];
  const nextRestartDate = getNextRestartDate(now);
  const serverName = firstText(info.servername, settings.ServerName, 'Palworld Server');
  const currentPlayers = numberOr(metrics.currentplayernum, players.length, 0);
  const maxPlayers = numberOr(metrics.maxplayernum, settings.ServerPlayerMaxNum, 0);
  const playerRows = players.map((player) => formatPlayerRow(player, icons)).filter(Boolean);
  const playerNames = players.map(formatPlayerName).filter(Boolean);
  const visiblePlayerRows = playerRows.slice(0, config.maxPlayerNames);
  const visiblePlayerNames = playerNames.slice(0, config.maxPlayerNames);
  const hiddenPlayerCount = Math.max(0, playerRows.length - visiblePlayerRows.length);
  const playerList =
    visiblePlayerRows.length === 0
      ? 'No players online'
      : `${visiblePlayerRows.join('\n')}${hiddenPlayerCount > 0 ? `\n+${hiddenPlayerCount} more players` : ''}`;
  const playerNameList =
    visiblePlayerNames.length === 0
      ? 'No players online'
      : `${visiblePlayerNames.join(', ')}${hiddenPlayerCount > 0 ? `, +${hiddenPlayerCount} more` : ''}`;

  return {
    status: data.online ? 'Online' : 'Offline',
    statusIcon: data.online ? icons.statusOnline : icons.statusOffline,
    embedColor: data.online ? '5724261' : '15158332',
    iconTitle: icons.title,
    iconServerBadge: icons.serverBadge,
    iconConnection: icons.connection,
    iconStatus: icons.status,
    iconPlayers: icons.players,
    iconPerformance: icons.performance,
    iconWorld: icons.world,
    iconServer: icons.server,
    iconRestart: icons.restart,
    iconClock: icons.clock,
    iconPingGreen: icons.pingGreen,
    iconPingYellow: icons.pingYellow,
    iconPingRed: icons.pingRed,
    iconLevel: icons.level,
    serverName,
    description: firstText(info.description, settings.ServerDescription, 'No description'),
    version: firstText(info.version, 'Unknown'),
    worldGuid: firstText(info.worldguid, 'Unknown'),
    gameAddress: config.gameAddress,
    restBaseUrl: config.restBaseUrl,
    refreshIntervalSeconds: String(config.refreshIntervalSeconds),
    metricsRefreshSeconds: String(config.metricsRefreshSeconds),
    playersRefreshSeconds: String(config.playersRefreshSeconds),
    staticRefreshSeconds: String(config.staticRefreshSeconds),
    restRequestCount: String(data.requestCount),
    currentPlayers: String(currentPlayers),
    maxPlayers: maxPlayers > 0 ? String(maxPlayers) : 'Unknown',
    playerList,
    playerNameList,
    serverFps: metrics.serverfps === undefined ? 'Unknown' : String(metrics.serverfps),
    frameTimeMs: metrics.serverframetime === undefined ? 'Unknown' : `${Number(metrics.serverframetime).toFixed(2)} ms`,
    uptimeSeconds: metrics.uptime === undefined ? '0' : String(metrics.uptime),
    uptimeHuman: metrics.uptime === undefined ? 'Unknown' : formatDuration(metrics.uptime),
    baseCamps: metrics.basecampnum === undefined ? 'Unknown' : String(metrics.basecampnum),
    days: metrics.days === undefined ? 'Unknown' : String(metrics.days),
    difficulty: firstText(settings.Difficulty, 'Unknown'),
    region: firstText(settings.Region, 'Unknown'),
    publicIp: firstText(settings.PublicIP, 'Unknown'),
    publicPort: settings.PublicPort === undefined ? 'Unknown' : String(settings.PublicPort),
    nextRestart: nextRestartDate ? formatDiscordTime(nextRestartDate, 'F') : 'Not scheduled',
    nextRestartRelative: nextRestartDate ? formatDiscordTime(nextRestartDate, 'R') : 'Not scheduled',
    lastUpdated: formatDiscordTime(now, 'F'),
    lastUpdatedIso: now.toISOString(),
    lastUpdatedRelative: formatDiscordTime(now, 'R')
  };
}

function buildDiscordPayload(variables) {
  const isOnline = variables.status === 'Online';
  const payload = applyTemplateDeep(loadMessageTemplate(), variables);
  normalizeDiscordPayload(payload);

  if (!isOnline) {
    payload.embeds = [];
  }

  return payload;
}

function loadMessageTemplate() {
  if (!fs.existsSync(config.messageTemplateFile)) {
    return defaultMessageTemplate();
  }

  try {
    const rawTemplate = fs.readFileSync(config.messageTemplateFile, 'utf8');
    return JSON.parse(stripJsonComments(rawTemplate));
  } catch (error) {
    throw new Error(`Failed to load ${config.messageTemplateFile}: ${error.message}`);
  }
}

function loadIcons() {
  if (!fs.existsSync(config.iconsFile)) {
    return defaultIcons();
  }

  try {
    const rawIcons = fs.readFileSync(config.iconsFile, 'utf8');
    return {
      ...defaultIcons(),
      ...JSON.parse(stripJsonComments(rawIcons))
    };
  } catch (error) {
    throw new Error(`Failed to load ${config.iconsFile}: ${error.message}`);
  }
}

function defaultIcons() {
  return {
  "title": "`🛰️`",
  "connection": "`🔗`",
  "status": "`📡`",
  "players": "`👥`",
  "performance": "`📊`",
  "world": "`🗺️`",
  "server": "`🖥️`",
  "restart": "`🕒`",
  "clock": "`⏱️`",
  "statusOnline": "<a:online:1382546219963908116>",
  "statusOffline": "<a:offline:1382546138426769549>",
  "pingGreen": ":<:color_Green:1160950063921631323>",
  "pingYellow": "<:color_Yellow:1160950053712707685>",
  "pingRed": "<a:offline:1382546138426769549>",
  "level": "`🔹`"
  };
}

function defaultMessageTemplate() {
  return {
    username: 'Palworld Server',
    content:
      '## {serverName} {iconServerBadge}\n' +
      '-# {statusIcon} {status}\n' +
      '```text\n' +
      '{gameAddress}\n' +
      '```\n' +
      '-# {iconPlayers} {currentPlayers}/{maxPlayers} players | {iconClock} updated {lastUpdatedRelative}\n' +
      '-# powered by Legacy Indonesia',
    embeds: [
      {
        title: '{iconPlayers} Server Details',
        description: '{description}',
        color: '{embedColor}',
        fields: [
          {
            name: '{iconPlayers} Player List',
            value: '{playerList}',
            inline: false
          },
          {
            name: '{iconPerformance} Performance',
            value: 'FPS: {serverFps}\nFrame Time: {frameTimeMs}\nUptime: {uptimeHuman}',
            inline: true
          },
          {
            name: '{iconWorld} World',
            value: 'Day: {days}\nBase Camps: {baseCamps}\nDifficulty: {difficulty}',
            inline: true
          },
          {
            name: '{iconRestart} Next Restart',
            value: '{nextRestart}\n{nextRestartRelative}',
            inline: false
          }
        ],
        footer: {
          text: 'Last updated {lastUpdatedRelative}'
        },
        timestamp: '{lastUpdatedIso}'
      }
    ],
    allowed_mentions: {
      parse: []
    }
  };
}

function ensureConfigFiles() {
  ensureConfigFile(config.messageTemplateFile, path.join(__dirname, 'message-template.jsonc'));
  ensureConfigFile(config.iconsFile, path.join(__dirname, 'icons.jsonc'));
}

function ensureConfigFile(filePath, defaultFilePath) {
  const targetPath = path.resolve(process.cwd(), filePath);
  const sourcePath = path.resolve(defaultFilePath);

  if (targetPath === sourcePath) {
    return;
  }

  if (fs.existsSync(targetPath)) {
    if (fs.statSync(targetPath).isDirectory()) {
      throw new Error(`${filePath} is a directory. Remove it and restart so the default file can be created.`);
    }

    return;
  }

  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.copyFileSync(sourcePath, targetPath);
  console.log(`Created default config file: ${filePath}`);
}

function applyTemplateDeep(value, variables) {
  if (typeof value === 'string') {
    return applyTemplate(value, variables);
  }

  if (Array.isArray(value)) {
    return value.map((item) => applyTemplateDeep(item, variables));
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, entryValue]) => [key, applyTemplateDeep(entryValue, variables)])
    );
  }

  return value;
}

function normalizeDiscordPayload(payload) {
  if (!payload || typeof payload !== 'object') {
    throw new Error('Message template must be a JSON object.');
  }

  if (!payload.username) {
    payload.username = 'Palworld Server';
  }

  payload.content = truncate(payload.content || defaultMessageTemplate().content, 2000);
  payload.embeds = normalizeEmbeds(payload.embeds || []);

  if (!payload.allowed_mentions) {
    payload.allowed_mentions = {
      parse: []
    };
  }
}

function normalizeEmbeds(embeds) {
  if (!Array.isArray(embeds)) {
    return [];
  }

  return embeds.slice(0, 10).map((embed) => {
    const normalized = {
      ...embed,
      title: embed.title === undefined ? undefined : truncate(embed.title, 256),
      description: embed.description === undefined ? undefined : truncate(embed.description, 4096),
      color: normalizeColor(embed.color),
      fields: normalizeEmbedFields(embed.fields),
      timestamp: embed.timestamp || new Date().toISOString()
    };

    if (normalized.footer && normalized.footer.text) {
      normalized.footer = {
        ...normalized.footer,
        text: truncate(normalized.footer.text, 2048)
      };
    }

    return normalized;
  });
}

function normalizeEmbedFields(fields) {
  if (!Array.isArray(fields)) {
    return [];
  }

  return fields.slice(0, 25).map((field) => ({
    name: truncate(field.name || ' ', 256),
    value: truncate(field.value || ' ', 1024),
    inline: Boolean(field.inline)
  }));
}

function normalizeColor(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  if (typeof value !== 'string') {
    return 0x5865f2;
  }

  const trimmed = value.trim();
  if (/^#[0-9a-f]{6}$/i.test(trimmed)) {
    return Number.parseInt(trimmed.slice(1), 16);
  }

  if (/^0x[0-9a-f]{6}$/i.test(trimmed)) {
    return Number.parseInt(trimmed.slice(2), 16);
  }

  const number = Number(trimmed);
  return Number.isFinite(number) ? number : 0x5865f2;
}

function stripJsonComments(text) {
  let output = '';
  let inString = false;
  let quote = '';
  let escaped = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const nextChar = text[index + 1];

    if (inString) {
      output += char;

      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === quote) {
        inString = false;
      }

      continue;
    }

    if (char === '"' || char === "'") {
      inString = true;
      quote = char;
      output += char;
      continue;
    }

    if (char === '/' && nextChar === '/') {
      while (index < text.length && text[index] !== '\n') {
        index += 1;
      }
      output += '\n';
      continue;
    }

    if (char === '/' && nextChar === '*') {
      index += 2;
      while (index < text.length && !(text[index] === '*' && text[index + 1] === '/')) {
        index += 1;
      }
      index += 1;
      continue;
    }

    output += char;
  }

  return output;
}

async function upsertWebhookMessage(payload) {
  const messageId = readMessageId();

  if (messageId) {
    const editUrl = webhookMessageUrl(messageId);
    const editResponse = await discordFetch(editUrl, {
      method: 'PATCH',
      body: JSON.stringify(payload)
    });

    if (editResponse.ok) {
      return;
    }

    if (editResponse.status !== 404) {
      const body = await safeResponseText(editResponse);
      throw new Error(`Discord edit failed (${editResponse.status}): ${body}`);
    }

    console.warn('Saved Discord message was not found; creating a new webhook message.');
  }

  const createResponse = await discordFetch(withQueryParam(config.webhookUrl, 'wait', 'true'), {
    method: 'POST',
    body: JSON.stringify(payload)
  });

  if (!createResponse.ok) {
    const body = await safeResponseText(createResponse);
    throw new Error(`Discord create failed (${createResponse.status}): ${body}`);
  }

  const message = await createResponse.json();
  if (!message.id) {
    throw new Error('Discord did not return a message ID. Check webhook permissions and wait=true support.');
  }

  writeTextFile(config.messageIdFile, `${message.id}\n`);
}

async function runDueRestart(now, variables) {
  if (!config.restartEnabled || config.restartTimes.length === 0) {
    return;
  }

  const dueRestart = getDueRestart(now);
  if (!dueRestart) {
    return;
  }

  const state = readState();
  if (state.lastRestartKey === dueRestart.key) {
    return;
  }

  console.log(`Starting scheduled restart ${dueRestart.key}.`);
  await palworldPost('/shutdown', {
    waittime: config.restartWaitSeconds,
    message: applyTemplate(config.restartMessage, variables)
  });

  state.lastRestartKey = dueRestart.key;
  writeJsonFile(config.stateFile, state);
}

async function palworldGet(endpoint) {
  return palworldRequest(endpoint, { method: 'GET' });
}

async function palworldPost(endpoint, body) {
  return palworldRequest(endpoint, {
    method: 'POST',
    body: JSON.stringify(body)
  });
}

async function palworldRequest(endpoint, options) {
  const url = `${config.restBaseUrl}${endpoint}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.requestTimeoutSeconds * 1000);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Authorization: basicAuth(config.restUsername, config.restPassword)
      }
    });

    if (!response.ok) {
      const body = await safeResponseText(response);
      throw new Error(`${endpoint} failed (${response.status}): ${body}`);
    }

    if (response.status === 204) {
      return {};
    }

    const text = await response.text();
    return text ? JSON.parse(text) : {};
  } catch (error) {
    if (error.name === 'AbortError') {
      throw new Error(`${endpoint} timed out after ${config.requestTimeoutSeconds}s (${url})`);
    }

    throw new Error(`${endpoint} request failed (${url}): ${formatError(error)}`);
  } finally {
    clearTimeout(timeout);
  }
}

async function discordFetch(url, options) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.requestTimeoutSeconds * 1000);

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json'
      }
    });
  } catch (error) {
    if (error.name === 'AbortError') {
      throw new Error(`Discord request timed out after ${config.requestTimeoutSeconds}s`);
    }

    throw new Error(`Discord request failed: ${formatError(error)}`);
  } finally {
    clearTimeout(timeout);
  }
}

function readMessageId() {
  try {
    return fs.readFileSync(config.messageIdFile, 'utf8').trim();
  } catch (error) {
    if (error.code === 'ENOENT') {
      return '';
    }

    throw error;
  }
}

function readState() {
  try {
    return JSON.parse(fs.readFileSync(config.stateFile, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') {
      return {};
    }

    throw error;
  }
}

function getNextRestartDate(now) {
  if (!config.restartEnabled || config.restartTimes.length === 0) {
    return null;
  }

  const candidates = [];
  for (const time of config.restartTimes) {
    const today = new Date(now);
    today.setHours(time.hour, time.minute, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(today.getDate() + 1);
    candidates.push(today > now ? today : tomorrow);
  }

  return candidates.sort((a, b) => a.getTime() - b.getTime())[0] || null;
}

function getDueRestart(now) {
  const graceMs = Math.max(config.refreshIntervalSeconds * 1000, 60_000);

  for (const time of config.restartTimes) {
    const scheduled = new Date(now);
    scheduled.setHours(time.hour, time.minute, 0, 0);

    const elapsedMs = now.getTime() - scheduled.getTime();
    if (elapsedMs >= 0 && elapsedMs <= graceMs) {
      return {
        key: `${scheduled.getFullYear()}-${pad2(scheduled.getMonth() + 1)}-${pad2(scheduled.getDate())}T${pad2(time.hour)}:${pad2(time.minute)}`,
        scheduled
      };
    }
  }

  return null;
}

function parseRestartTimes(value) {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      const match = item.match(/^([01]?\d|2[0-3]):([0-5]\d)$/);
      if (!match) {
        throw new Error(`Invalid restart time "${item}". Use HH:mm, for example 04:00.`);
      }

      return {
        hour: Number(match[1]),
        minute: Number(match[2])
      };
    });
}

function formatTimeConfig(time) {
  return `${pad2(time.hour)}:${pad2(time.minute)}`;
}

function applyTemplate(template, variables) {
  return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (match, key) =>
    Object.prototype.hasOwnProperty.call(variables, key) ? variables[key] : match
  );
}

function formatDiscordTime(date, style) {
  return `<t:${Math.floor(date.getTime() / 1000)}:${style}>`;
}

function formatDuration(totalSeconds) {
  const seconds = Math.max(0, Number(totalSeconds) || 0);
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);

  const parts = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  if (parts.length === 0) parts.push(`${Math.floor(seconds % 60)}s`);

  return parts.join(' ');
}

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return;
  }

  const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    const separatorIndex = trimmed.indexOf('=');
    if (separatorIndex === -1) {
      continue;
    }

    const key = trimmed.slice(0, separatorIndex).trim();
    const rawValue = trimmed.slice(separatorIndex + 1).trim();
    if (!key || Object.prototype.hasOwnProperty.call(process.env, key)) {
      continue;
    }

    process.env[key] = unquote(rawValue);
  }
}

function unquote(value) {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }

  return value;
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

function env(name, fallback) {
  return process.env[name] === undefined || process.env[name] === '' ? fallback : process.env[name];
}

function numberEnv(name, fallback) {
  const value = env(name, String(fallback));
  const number = Number(value);
  if (!Number.isFinite(number)) {
    throw new Error(`Invalid number for ${name}: ${value}`);
  }

  return number;
}

function boolEnv(name, fallback) {
  const value = env(name, fallback ? 'true' : 'false').toLowerCase();
  return ['1', 'true', 'yes', 'on'].includes(value);
}

function basicAuth(username, password) {
  return `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
}

function formatPlayerRow(player, icons) {
  const name = formatPlayerName(player);
  const level = player.level === undefined || player.level === null ? 'Unknown' : String(player.level);
  const pingValue = Number(player.ping);
  const ping = Number.isFinite(pingValue) ? `${Math.round(pingValue)} ms` : 'Unknown';
  const pingIcon = getPingIcon(pingValue, icons);

  return `${pingIcon} ${ping} | **${name}** ${icons.level} Lv ${level}`;
}

function formatPlayerName(player) {
  return firstText(player.name, player.accountName, player.playerId, 'Unknown');
}

function getPingIcon(ping, icons) {
  if (!Number.isFinite(ping)) {
    return icons.pingRed;
  }

  if (ping <= 50) {
    return icons.pingGreen;
  }

  if (ping <= 100) {
    return icons.pingYellow;
  }

  return icons.pingRed;
}

function firstText(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && String(value).trim() !== '') {
      return String(value).trim();
    }
  }

  return '';
}

function numberOr(...values) {
  for (const value of values) {
    const number = Number(value);
    if (Number.isFinite(number)) {
      return number;
    }
  }

  return 0;
}

function trimTrailingSlash(value) {
  return value.replace(/\/+$/, '');
}

function withQueryParam(rawUrl, key, value) {
  const url = new URL(rawUrl);
  url.searchParams.set(key, value);
  return url.toString();
}

function webhookMessageUrl(messageId) {
  const url = new URL(config.webhookUrl);
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/messages/${encodeURIComponent(messageId)}`;
  return url.toString();
}

async function safeResponseText(response) {
  const text = await response.text();
  return truncate(text || response.statusText, 500);
}

function truncate(value, maxLength) {
  const text = String(value);
  if (text.length <= maxLength) {
    return text;
  }

  return `${text.slice(0, maxLength - 3)}...`;
}

function formatError(error) {
  const details = [error.message];
  if (error.code) {
    details.push(error.code);
  }

  if (error.cause) {
    details.push(formatError(error.cause));
  }

  return details.filter(Boolean).join(' | ');
}

function writeTextFile(filePath, text) {
  fs.writeFileSync(filePath, text, 'utf8');
}

function writeJsonFile(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function pad2(value) {
  return String(value).padStart(2, '0');
}
