#!/bin/sh
# Start an image and check that it is a working Litmark, not merely a running
# process. Used by the container workflow before anything is published, and
# runnable by hand:
#
#   docker build -t litmark:dev . && docker/smoke-test.sh litmark:dev
#
# No provider, bucket or remote is contacted: the container creates an empty
# project in its own filesystem.
set -eu

IMAGE="${1:?usage: smoke-test.sh IMAGE}"
NAME="litmark-smoke-$$"
PORT="${SMOKE_PORT:-18799}"
URL="http://127.0.0.1:$PORT"

cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; }
trap cleanup EXIT

fail() {
    echo "FAILED: $1" >&2
    echo "--- container log" >&2
    docker logs "$NAME" >&2 2>&1 || true
    exit 1
}

docker run -d --name "$NAME" -p "127.0.0.1:$PORT:8765" -e LITMARK_PASSWORD=smoke "$IMAGE" >/dev/null

code=000
for _ in $(seq 1 60); do
    code=$(curl -s -o /dev/null -w '%{http_code}' -u me:smoke "$URL/" || true)
    [ "$code" = 200 ] && break
    sleep 1
done
[ "$code" = 200 ] || fail "the server did not answer with the page (last status $code)"
echo "ok: the server answers"

# The password is asked for before anything is served.
[ "$(curl -s -o /dev/null -w '%{http_code}' "$URL/")" = 401 ] || fail "the page was served without the password"
echo "ok: nothing is served without the password"

# The page is the application, and its script is in the image.
page=$(curl -s -u me:smoke "$URL/")
token=$(printf '%s' "$page" | sed -n 's/.*name="litmark-token" content="\([^"]*\)".*/\1/p')
[ -n "$token" ] || fail "the page carries no session credential"
script=$(printf '%s' "$page" | grep -o '/assets/index-[^"]*\.js' | head -n 1)
[ -n "$script" ] || fail "the page names no application script"
[ "$(curl -s -o /dev/null -w '%{http_code}' -u me:smoke "$URL$script")" = 200 ] || fail "$script is not in the image"
echo "ok: the browser assets are served"

# The API works against the project the entrypoint created.
state=$(curl -s -u me:smoke -H "x-litmark-token: $token" "$URL/api/state")
printf '%s' "$state" | grep -q '"note_id": *"welcome"' || fail "the project has no welcome note: $state"
sync=$(curl -s -u me:smoke -H "x-litmark-token: $token" "$URL/api/sync")
printf '%s' "$sync" | grep -q '"state": *"local"' || fail "the project is not under git: $sync"
echo "ok: a project was created, and its text is committed to git"

# What the server shells out to is there and runs on this architecture.
docker exec "$NAME" git --version >/dev/null || fail "git does not run"
docker exec "$NAME" python -c '
import subprocess
from litmark.agent.claude_sdk import _runtime_path
out = subprocess.run([_runtime_path(), "--version"], capture_output=True, text=True, timeout=60)
assert out.returncode == 0, out.stderr
print("ok: agent runtime", out.stdout.strip())
' || fail "the agent runtime does not run"
docker exec "$NAME" python -c 'import boto3' || fail "the S3 client is not installed"
echo "ok: git, the agent runtime and the S3 client are present"

echo "The image works: $IMAGE ($(docker image inspect "$IMAGE" --format '{{.Architecture}}'))"
