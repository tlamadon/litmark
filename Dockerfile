# syntax=docker/dockerfile:1
#
# Litmark in a container: the server, the browser assets, the agent runtime,
# and git. Papers live in S3 and text in a git remote, so the container holds
# nothing that cannot be fetched again — a volume on /data only saves the
# fetching.

# The first three stages produce files that are the same for every architecture
# (browser assets, a pure-Python wheel, the list of what it needs), so they run
# on the machine doing the build. Only the last stage is built per
# architecture; a multi-architecture build then emulates one stage, not four.
#
# The last stage is laid out by how often each layer changes. What the
# application needs is installed before the application: the needs change when
# the lock file does, the application at every commit — and installing the
# needs is minutes under emulation, where installing the application over them
# is seconds.

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

# ---- what the wheel needs ---------------------------------------------------
# Read from the lock file, so the image runs what the tests ran. Only the two
# files that say what is needed are copied in: a change to the code does not
# reach this stage, and so does not reach the layer installed from it.
FROM --platform=$BUILDPLATFORM python:3.12-slim AS requirements
WORKDIR /src
RUN pip install --no-cache-dir uv
COPY pyproject.toml uv.lock ./
# The `claude` extra brings the agent runtime with it.
RUN uv export --frozen --no-dev --no-emit-project --no-hashes \
      --extra claude --extra s3 --extra mcp --output-file /requirements.txt

# ---- runtime ----------------------------------------------------------------
FROM python:3.12-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends git openssh-client ca-certificates tini \
 && rm -rf /var/lib/apt/lists/*
RUN useradd --create-home --uid 1000 litmark \
 && mkdir -p /data && chown litmark:litmark /data

# Everything above and this layer stay as they are from one commit to the next.
COPY --from=requirements /requirements.txt /tmp/requirements.txt
RUN pip install --no-cache-dir -r /tmp/requirements.txt && rm /tmp/requirements.txt

# From here on it is the application, which is new each time.
COPY --from=wheel /dist/ /tmp/dist/
RUN pip install --no-cache-dir --no-deps /tmp/dist/*.whl && rm -rf /tmp/dist
# An image without the agent runtime or the browser assets would start, and
# then be useless; so would one whose needs were installed from a lock file
# that no longer says what the application asks for. Better that the build
# fails, on whichever architecture.
RUN pip check && python - <<'PY'
import boto3  # noqa: F401 - the s3 extra
import mcp  # noqa: F401 - the mcp extra

from litmark.agent.claude_sdk import _runtime_path
from litmark.api.app import static_root

assert _runtime_path(), "the agent runtime is missing from the image"
assert static_root(), "the browser assets are missing from the image"
PY

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
