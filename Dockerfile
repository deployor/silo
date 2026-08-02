FROM oven/bun:1.3.14 AS base
ENV DEBIAN_FRONTEND=noninteractive
WORKDIR /usr/src/app

FROM base AS install
RUN apt-get update && \
    apt-get install -y --no-install-recommends python3 make g++ && \
    rm -rf /var/lib/apt/lists/*
RUN mkdir -p /temp/dev
COPY package.json bun.lock /temp/dev/
RUN cd /temp/dev && bun install --frozen-lockfile && bun pm trust @mongodb-js/zstd || true

RUN mkdir -p /temp/prod
COPY package.json bun.lock /temp/prod/
RUN cd /temp/prod && bun install --frozen-lockfile --production && bun pm trust @mongodb-js/zstd || true

FROM base AS prerelease
RUN apt-get update && \
    apt-get install -y --no-install-recommends git && \
    rm -rf /var/lib/apt/lists/*
COPY --from=install /temp/dev/node_modules node_modules
COPY . .
# Generate git info file
ARG GIT_SHA=unknown
ARG GIT_DATE=unknown
ARG GIT_MESSAGE=unknown
ENV GIT_SHA=$GIT_SHA
ENV GIT_DATE=$GIT_DATE
ENV GIT_MESSAGE=$GIT_MESSAGE
RUN bun -e 'const fs = require("node:fs"); const cp = require("node:child_process"); const known = (value) => { value = String(value || "").trim(); return value && value !== "unknown" ? value : undefined; }; const git = (args) => { try { return known(cp.execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })); } catch { return undefined; } }; const info = { sha: known(process.env.GIT_SHA) || git(["rev-parse", "HEAD"]) || "unknown", date: known(process.env.GIT_DATE) || git(["show", "-s", "--format=%cI", "HEAD"]) || "unknown", message: known(process.env.GIT_MESSAGE) || git(["show", "-s", "--format=%s", "HEAD"]) || "unknown", buildDate: new Date().toISOString() }; fs.writeFileSync("src/git-info.json", JSON.stringify(info));'
RUN bun run build

FROM base AS release
RUN apt-get update && \
    apt-get install -y --no-install-recommends zstd && \
    rm -rf /var/lib/apt/lists/*
COPY --from=install /temp/prod/node_modules node_modules
COPY --from=prerelease /usr/src/app/src src
COPY --from=prerelease /usr/src/app/drizzle drizzle
COPY --from=prerelease /usr/src/app/package.json .
ENV DISK_CACHE_DIR=/tmp/s3-disk-cache

USER bun
EXPOSE 3000/tcp
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD bun -e "fetch('http://127.0.0.1:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT [ "bun", "run", "src/index.ts" ]
