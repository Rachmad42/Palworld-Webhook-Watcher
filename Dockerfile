FROM node:22-alpine

WORKDIR /app

ENV NODE_ENV=production

RUN apk add --no-cache tzdata

COPY package*.json ./
RUN npm install --omit=dev --ignore-scripts \
  && npm cache clean --force

COPY --chown=node:node palworld-webhook.js message-template.jsonc icons.jsonc ./

RUN mkdir -p /app/data /app/config \
  && chown -R node:node /app

USER node

CMD ["node", "palworld-webhook.js"]
