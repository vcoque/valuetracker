# Development and test toolchain for ValueTracker.
#
# The host needs only Docker: Node, npm and the build tools all live in here.
# The version is pinned to match .nvmrc -- keep the two in step.
FROM node:24.20.0-bookworm-slim

# openssl  -- Prisma's query engine links libssl, and node:*-slim ships without
#             it. Omitting this fails at runtime, not at build time.
# git      -- npm dependencies on git URLs, and Prisma migration tooling.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates git openssl \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /home/node/.npm \
 && chown -R node:node /home/node

WORKDIR /workspace

# Nothing project-specific is baked in: the repo is bind-mounted at run time
# (see compose.yaml), so this image is pure toolchain and its layers stay
# cached across every dependency change.
USER node
CMD ["sleep", "infinity"]
