# NOTE: You should mount a persistent volume at /tmp/actual-cache to avoid re-downloading budget on every restart.
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
EXPOSE 5007
CMD ["node", "index.js"]