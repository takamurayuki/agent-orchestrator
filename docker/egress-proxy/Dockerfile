# syntax=docker/dockerfile:1
# egress allowlist プロキシ。ビルド: pnpm sandbox:build（scripts/build-images.mjs）
ARG NODE_IMAGE=node:22.23.4-bookworm-slim
FROM ${NODE_IMAGE}
COPY egress-proxy.mjs /opt/proxy/egress-proxy.mjs
ENV EGRESS_PORT=3128
RUN useradd --uid 1001 --create-home --shell /usr/sbin/nologin agent
USER 1001:1001
EXPOSE 3128
CMD ["node", "/opt/proxy/egress-proxy.mjs"]
