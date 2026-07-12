FROM node:22-bookworm

# Install system dependencies
RUN apt-get update && apt-get install -y \
  git \
  curl \
  jq \
  && rm -rf /var/lib/apt/lists/*

# Install GitHub CLI
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
  | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
  | tee /etc/apt/sources.list.d/github-cli.list > /dev/null \
  && apt-get update && apt-get install -y gh \
  && rm -rf /var/lib/apt/lists/*

# ---------------------------------------------------------------------------
# PROJECT TOOLING -- add anything your agents need at runtime here, while the
# build is still running as root (apt packages, browsers, extra runtimes,
# CLIs). Anything an agent would otherwise have to bootstrap from scratch at
# runtime burns its context window; bake it in instead.
#
# Example -- headless Chromium for verifying web-UI changes end-to-end:
#   ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
#   ENV PLAYWRIGHT_VERSION=1.49.1
#   RUN npx -y playwright@${PLAYWRIGHT_VERSION} install --with-deps chromium \
#     && chmod -R a+rwX /ms-playwright
# (Then tell the implementer how to use it via `implementNotes` in config.mts.)
# ---------------------------------------------------------------------------

# Build-args for UID/GID alignment: `sandcastle docker build-image` defaults
# these to the host user's UID/GID so image-built files and bind-mounted files
# share an owner without runtime chown.
ARG AGENT_UID=1000
ARG AGENT_GID=1000

# Rename the base image's "node" user to "agent" and align UID/GID.
RUN groupmod -o -g $AGENT_GID node && usermod -o -u $AGENT_UID -g $AGENT_GID -d /home/agent -m -l agent node
USER ${AGENT_UID}:${AGENT_GID}

# Pin HOME so per-user installs reliably land in /home/agent/.local/bin,
# which is added to PATH below.
ENV HOME=/home/agent

# Install Claude Code CLI
RUN curl -fsSL https://claude.ai/install.sh | bash

# Add Claude to PATH
ENV PATH="/home/agent/.local/bin:$PATH"

# rtk (https://github.com/rtk-ai/rtk): token-optimized CLI proxy for the agent.
# Telemetry is opt-in; the init consent prompt is skipped on non-TTY stdin, and
# this env var hard-disables collection regardless of config.
ENV RTK_TELEMETRY_DISABLED=1

# `rtk init -g --auto-patch` is the non-interactive path: it patches
# ~/.claude/settings.json (hook that rewrites commands through rtk), writes
# ~/.claude/RTK.md, and adds an @RTK.md reference to ~/.claude/CLAUDE.md.
RUN curl -fsSL https://raw.githubusercontent.com/rtk-ai/rtk/refs/heads/master/install.sh | sh \
  && mkdir -p /home/agent/.claude \
  && rtk init -g --auto-patch

WORKDIR /home/agent

# In worktree sandbox mode, Sandcastle bind-mounts the git worktree at
# /home/agent/workspace and overrides the working directory to it at container
# start. Structure this Dockerfile so /home/agent/workspace can serve as the
# project root.
ENTRYPOINT ["sleep", "infinity"]
