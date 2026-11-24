#!/bin/sh
# Open the project, fetching or creating it first if this container is new.
#
#   LITMARK_PROJECT       where the project lives (default /data/project)
#   LITMARK_GIT_REMOTE    the project's git remote; cloned on first start
#   LITMARK_GIT_TOKEN     a token for an https remote (or mount an SSH key)
#   LITMARK_S3_BUCKET     where papers are kept, when creating a new project
#   LITMARK_S3_PREFIX, LITMARK_S3_ENDPOINT, LITMARK_S3_REGION
#   AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY   credentials for that bucket
#   ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN   the agent's credential
#   LITMARK_PASSWORD      asked for by the browser; set it on any shared network
#
# Arguments are passed on to `litmark serve`, e.g. `--allow-host papers.example`.
set -eu

PROJECT="${LITMARK_PROJECT:-/data/project}"

if [ ! -f "$PROJECT/project.toml" ]; then
    if [ -n "${LITMARK_GIT_REMOTE:-}" ]; then
        # An existing project is fetched; an empty remote gets a new one.
        litmark clone "$LITMARK_GIT_REMOTE" "$PROJECT" --or-init
    else
        echo "No LITMARK_GIT_REMOTE: this project's text lives only in this container's volume." >&2
        litmark init "$PROJECT" --git
    fi
fi

exec litmark serve "$PROJECT" --host 0.0.0.0 --port "${PORT:-8765}" "$@"
