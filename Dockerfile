FROM node:22-bookworm-slim

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    fonts-liberation \
    && rm -rf /var/lib/apt/lists/*

ENV CHROME_PATH=/usr/bin/chromium \
    NODE_ENV=production

COPY package*.json ./
RUN npm install --omit=dev --ignore-scripts

COPY src/ ./src/

EXPOSE 8088

CMD ["node", "src/index.js"]
