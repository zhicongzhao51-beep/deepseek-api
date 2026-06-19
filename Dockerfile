# DeepSeek API Service - Production Docker Image
FROM node:20-alpine

# Create app directory
WORKDIR /app

# Install dependencies first (better layer caching)
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Copy application code
COPY . .

# Create data directory for SQLite persistence
RUN mkdir -p /app/data

# Environment
ENV NODE_ENV=production
ENV PORT=3456
ENV DB_PATH=/app/data/data.db

# Note: Running as root inside Railway container (Railway provides container-level isolation)

EXPOSE 3456

HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3456/api/health',r=>{process.exit(r.statusCode===200?0:1)})"

CMD ["node", "server.js"]
