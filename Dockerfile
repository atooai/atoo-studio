# ---- Stage 1: Build ----
FROM node:20-slim AS build

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make gcc g++ && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install all dependencies (including dev)
COPY package.json package-lock.json ./
RUN npm ci

# Copy source and build
COPY tsconfig.json ./
COPY src/ src/
COPY preload/ preload/
COPY frontend/ frontend/
COPY bin/ bin/

# Build native modules + backend + frontend
RUN make -C preload && \
    cd src/serial/native && node-gyp rebuild && cd ../../.. && \
    npx tsc && \
    cd frontend && npm install && npm run build


# ---- Stage 2: Production dependencies ----
FROM node:20-slim AS deps

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make gcc g++ && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
COPY src/serial/native/binding.gyp src/serial/native/binding.gyp
COPY src/serial/native/pty_pair.c src/serial/native/pty_pair.c
COPY preload/ preload/

ENV PUPPETEER_CACHE_DIR=/opt/puppeteer-cache

RUN npm ci --omit=dev


# ---- Stage 3: Runtime ----
FROM node:20-slim

# Chrome/Puppeteer dependencies + system tools
RUN apt-get update && apt-get install -y --no-install-recommends \
    # Chrome libs
    libatk1.0-0 libatk-bridge2.0-0 libcups2 libatspi2.0-0 \
    libxcomposite1 libxdamage1 libxfixes3 libxrandr2 \
    libgbm1 libcairo2 libpango-1.0-0 \
    $(apt-cache show libasound2t64 >/dev/null 2>&1 && echo libasound2t64 || echo libasound2) \
    # Tools
    git ffmpeg procps curl gpg \
    && rm -rf /var/lib/apt/lists/*

# Install gh (GitHub CLI)
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      | gpg --dearmor -o /usr/share/keyrings/githubcli-archive-keyring.gpg && \
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list && \
    apt-get update && apt-get install -y --no-install-recommends gh && \
    rm -rf /var/lib/apt/lists/*

# Create non-root user
RUN useradd -m -s /bin/bash atoo

WORKDIR /app

# Copy production node_modules and Puppeteer Chrome
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /opt/puppeteer-cache /home/atoo/.cache/puppeteer

# Copy built artifacts
COPY --from=build /app/dist ./dist
COPY --from=build /app/frontend/dist ./frontend/dist
COPY --from=build /app/preload/atoo-studio-preload.so ./preload/atoo-studio-preload.so
COPY --from=build /app/src/serial/native/build ./src/serial/native/build

# Copy runtime files
COPY bin/ ./bin/
COPY package.json ./
COPY setup.sh ./
COPY src/serial/native/binding.gyp ./src/serial/native/binding.gyp
COPY src/serial/native/pty_pair.c ./src/serial/native/pty_pair.c
COPY preload/atoo-studio-preload.c ./preload/atoo-studio-preload.c
COPY preload/Makefile ./preload/Makefile

# Fix ownership
RUN chown -R atoo:atoo /app /home/atoo

USER atoo

VOLUME /home/atoo/.atoo-studio

EXPOSE 3010 8081

CMD ["node", "bin/atoo-studio.js"]
