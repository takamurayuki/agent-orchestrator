# syntax=docker/dockerfile:1
# Builder（Claude Code）/ Reviewer（Codex）/ Verifier（pnpm / npm / yarn / uv / pip）が動くサンドボックスイメージ。
# - 版はすべて ARG で指定する。pinned 方針ではマニフェストの版、latest 方針では "latest" が渡される（D-46）
# - 実際に入った版は /etc/agent-orchestrator/versions.json に記録し、環境チェックが表示する
# - 非 root ユーザー agent (uid 1001)。ワークスペースは /workspace にボリュームとして与えられる
# - 自動更新・テレメトリは停止。許可されていない通信は egress プロキシが拒否する
ARG NODE_IMAGE=node:22.23.4-bookworm-slim
FROM ${NODE_IMAGE}
ARG PNPM_VERSION=12.16.1
ARG CLAUDE_CODE_VERSION=2.1.316
ARG CODEX_VERSION=0.166.0
ARG UV_VERSION=0.13.6
ARG VERSION_POLICY=pinned

# Python 3（Debian 付属、bookworm は 3.11）と pip / venv。uv は pip で入れる（版は ARG）
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates procps python3 python3-venv python3-pip \
  && rm -rf /var/lib/apt/lists/*

RUN npm install -g "pnpm@${PNPM_VERSION}" "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" "@openai/codex@${CODEX_VERSION}" \
  && npm cache clean --force

RUN if [ "${UV_VERSION}" = "latest" ]; then pip3 install --break-system-packages --no-cache-dir uv; \
    else pip3 install --break-system-packages --no-cache-dir "uv==${UV_VERSION}"; fi

# 入った版を記録する（環境チェックが読む。方針と取得日時も含める）
RUN mkdir -p /etc/agent-orchestrator \
  && node -e ' \
    const { execFileSync } = require("child_process"); \
    const v = (c, a) => { try { return execFileSync(c, a, { encoding: "utf8" }).trim().split("\n")[0]; } catch { return null; } }; \
    const out = { \
      policy: process.env.VERSION_POLICY || "pinned", \
      builtAt: new Date().toISOString(), \
      node: process.version, \
      pnpm: v("pnpm", ["--version"]), \
      npm: v("npm", ["--version"]), \
      yarn: v("yarn", ["--version"]), \
      claudeCode: v("claude", ["--version"]), \
      codex: v("codex", ["--version"]), \
      python: v("python3", ["--version"]), \
      uv: v("uv", ["--version"]) \
    }; \
    require("fs").writeFileSync("/etc/agent-orchestrator/versions.json", JSON.stringify(out, null, 2) + "\n"); \
    console.log(JSON.stringify(out));' \
  && chmod 0644 /etc/agent-orchestrator/versions.json

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
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_NO_INPUT=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    UV_NO_PROGRESS=1 \
    UV_LINK_MODE=copy \
    UV_PYTHON_PREFERENCE=only-system \
    UV_CACHE_DIR=/tmp/uv-cache \
    CI=1

USER 1001:1001
WORKDIR /workspace
CMD ["node", "--version"]
