# syntax=docker/dockerfile:1
#
# Litmark in a container: the server, the browser assets, the agent runtime,
# and git. Papers live in S3 and text in a git remote, so the container holds
# nothing that cannot be fetched again — a volume on /data only saves the
# fetching.

# The first two stages produce files that are the same for every architecture
# (browser assets, a pure-Python wheel), so they run on the machine doing the
# build. Only the last stage is built per architecture; a multi-architecture
# build then emulates one stage rather than three.

# ---- browser assets ---------------------------------------------------------
FROM --platform=$BUILDPLATFORM node:22-slim AS assets
WORKDIR /src/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
# Writes ../src/litmark/static, where the Python package expects it.
RUN npm run build

# ---- the wheel --------------------------------------------------------------
FROM --platform=$BUILDPLATFORM python:3.12-slim AS wheel
WORKDIR /src
RUN pip install --no-cache-dir build
COPY pyproject.toml README.md LICENSE spec.md ./
COPY src/ src/
COPY --from=assets /src/src/litmark/static/ src/litmark/static/
RUN python -m build --wheel --outdir /dist

# ---- runtime ----------------------------------------------------------------
FROM python:3.12-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends git openssh-client ca-certificates tini \
 && rm -rf /var/lib/apt/lists/*

COPY --from=wheel /dist/ /tmp/dist/
# The `claude` extra brings the agent runtime with it; nothing else to install.
RUN pip install --no-cache-dir "$(ls /tmp/dist/*.whl)[claude,s3]" && rm -rf /tmp/dist
# An image without the agent runtime or the browser assets would start, and
# then be useless. Better that the build fails, on whichever architecture.
RUN python - <<'PY'
from litmark.agent.claude_sdk import _runtime_path
from litmark.api.app import static_root

assert _runtime_path(), "the agent runtime is missing from the image"
assert static_root(), "the browser assets are missing from the image"
PY

RUN useradd --create-home --uid 1000 litmark \
 && mkdir -p /data && chown litmark:litmark /data
COPY --chmod=755 docker/entrypoint.sh /usr/local/bin/litmark-entrypoint

USER litmark
ENV HOME=/home/litmark \
    LITMARK_PROJECT=/data/project \
    PYTHONUNBUFFERED=1
VOLUME /data
EXPOSE 8765

# Ties the published image to its repository, and so to its source and licence.
LABEL org.opencontainers.image.source="https://github.com/tlamadon/litmark" \
      org.opencontainers.image.description="Litmark: a research workspace for papers, cited notes, and an agent" \
      org.opencontainers.image.licenses="MIT"

ENTRYPOINT ["tini", "--", "litmark-entrypoint"]
