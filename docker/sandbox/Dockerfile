# syntax=docker/dockerfile:1
# Builder（Claude Code）/ Reviewer（Codex）/ Verifier（pnpm）が動くサンドボックスイメージ。
# - バージョンはすべて ARG でピン留めし、ローカルでビルドする（pnpm sandbox:build）
# - 非 root ユーザー agent (uid 1001)。ワークスペースは /workspace に bind mount される
# - 自動更新・テレメトリは停止。許可されていない通信は egress プロキシが拒否する
ARG NODE_IMAGE=node:22.23.4-bookworm-slim
FROM ${NODE_IMAGE}
ARG PNPM_VERSION=12.9.1
ARG CLAUDE_CODE_VERSION=2.1.316
ARG CODEX_VERSION=0.163.0

RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates procps \
  && rm -rf /var/lib/apt/lists/*

RUN npm install -g "pnpm@${PNPM_VERSION}" "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" "@openai/codex@${CODEX_VERSION}" \
  && npm cache clean --force

RUN useradd --uid 1001 --create-home --shell /bin/bash agent \
  && mkdir -p /workspace && chown 1001:1001 /workspace

ENV HOME=/home/agent \
    DISABLE_AUTOUPDATER=1 \
    DISABLE_TELEMETRY=1 \
    DISABLE_ERROR_REPORTING=1 \
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 \
    pnpm_config_store_dir=/tmp/pnpm-store \
    pnpm_config_cache_dir=/tmp/pnpm-cache \
    npm_config_update_notifier=false \
    CI=1

USER 1001:1001
WORKDIR /workspace
CMD ["node", "--version"]
