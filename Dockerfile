FROM node:22-alpine

WORKDIR /app

ENV NODE_ENV=production

RUN apk add --no-cache su-exec tzdata

COPY package*.json ./
RUN npm install --omit=dev --ignore-scripts \
  && npm cache clean --force

COPY --chown=node:node palworld-webhook.js message-template.jsonc icons.jsonc ./
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

RUN mkdir -p /app/data /app/config \
  && chown -R node:node /app \
  && chmod +x /usr/local/bin/docker-entrypoint.sh

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "palworld-webhook.js"]
