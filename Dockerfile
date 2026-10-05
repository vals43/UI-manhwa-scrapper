FROM node:22-slim

ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/tmp/manhwa

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY src ./src
COPY public ./public

EXPOSE 3000
CMD ["node", "src/server.js"]
