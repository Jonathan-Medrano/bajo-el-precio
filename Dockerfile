# Playwright official image — includes Chromium + all system deps
FROM mcr.microsoft.com/playwright:v1.49.0-noble

WORKDIR /app

# Install Node deps (prod only)
COPY package*.json ./
RUN npm ci --omit=dev

# App source
COPY . .

# Generate Prisma client
RUN npx prisma generate

# Tell Playwright where browsers are (pre-installed in image)
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
ENV HEADLESS=1
ENV NODE_ENV=production

EXPOSE 3000

# Corre migraciones al arrancar (idempotente), luego inicia el server.
CMD ["sh", "-c", "npx prisma migrate deploy && node src/server.js"]
