FROM oven/bun:1 AS base
WORKDIR /usr/src/app

FROM base AS install
RUN mkdir -p /temp/dev
COPY package.json bun.lock /temp/dev/
RUN cd /temp/dev && bun install --frozen-lockfile

RUN mkdir -p /temp/prod
COPY package.json bun.lock /temp/prod/
RUN cd /temp/prod && bun install --frozen-lockfile --production

FROM base AS prerelease
# Install git early to allow caching (it won't re-run on code changes)
RUN apt-get update && \
    apt-get install -y --no-install-recommends git && \
    rm -rf /var/lib/apt/lists/*

COPY --from=install /temp/dev/node_modules node_modules
COPY . .
# Generate git info file
RUN echo "{\"sha\": \"$(git rev-parse HEAD)\", \"date\": \"$(git show -s --format=%cI HEAD)\", \"message\": \"$(git show -s --format=%s HEAD | tr -d '"' | tr -d '\n')\", \"buildDate\": \"$(date -u +"%Y-%m-%dT%H:%M:%SZ")\"}" > src/git-info.json
RUN bun run build:css

FROM base AS release
COPY --from=install /temp/prod/node_modules node_modules
COPY --from=prerelease /usr/src/app/src src
COPY --from=prerelease /usr/src/app/package.json .
COPY --from=prerelease /usr/src/app/drizzle.config.ts .

USER bun
EXPOSE 3000/tcp
ENTRYPOINT [ "bun", "run", "src/index.ts" ]
