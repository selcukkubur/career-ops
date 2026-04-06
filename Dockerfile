# Career-Ops Docker Image
# Node.js + Playwright + OpenAI-powered job search pipeline

# Use Playwright's official image which includes all system dependencies
FROM mcr.microsoft.com/playwright:v1.59.1-jammy

# Set working directory
WORKDIR /app

# Set environment variables
ENV NODE_ENV=production \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    PUPPETEER_SKIP_DOWNLOAD=true

# Install Node.js 20.x
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# Copy package files and install dependencies
COPY package.json ./
RUN npm install --omit=dev \
    && npm cache clean --force

# Copy application source code
COPY . .

# Copy mode files into the modes directory (they're read at runtime)
# (Already included via COPY . .)

# Create runtime directories with proper permissions
RUN mkdir -p /app/data /app/reports /app/output /app/batch/logs /app/batch/tracker-additions

# Create non-root user and set permissions
RUN groupadd -r career-ops && useradd -r -g career-ops -d /app -s /sbin/nologin career-ops \
    && chown -R career-ops:career-ops /app

# Switch to non-root user
USER career-ops

# Expose API port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD node -e "require('http').get('http://localhost:3000/health', (r) => { process.exit(r.statusCode === 200 ? 0 : 1) })"

# Default command: start the API server
CMD ["node", "src/server.js"]