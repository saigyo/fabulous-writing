#!/bin/sh
# Thin wrapper around the two docker run invocations. All behavior lives
# in the image (wizard + entrypoint); this only plumbs arguments.
# Usage:  ./fabulous.sh setup [version]
#         ./fabulous.sh serve [version]
# Env:    FW_PORT (host port, default 8080), FW_IMAGE (override image ref;
#         give it WITHOUT a tag — the version argument supplies the tag)
set -eu

IMAGE_BASE=${FW_IMAGE:-ghcr.io/saigyo/fabulous-writing}
COMMAND=${1:-}
VERSION=${2:-latest}
IMAGE="$IMAGE_BASE:$VERSION"
PORT=${FW_PORT:-8080}

case "$COMMAND" in
    setup)
        exec docker run --rm -it \
            -v fabulous-config:/config \
            "$IMAGE" setup
        ;;
    serve)
        # With some Docker backends (colima), publishing a taken host
        # port does not fail: the container serves healthily while the
        # squatter answers localhost:$PORT. Refuse up front when we can
        # tell; without nc, skip — the README covers the collision.
        # Probe both loopback families: a ::1-only squatter still wins
        # the browser's localhost lookup. An nc without IPv6 support
        # just fails the ::1 probe, which is the same as "free".
        if command -v nc >/dev/null 2>&1; then
            for probe_addr in 127.0.0.1 ::1; do
                if nc -z -w 1 "$probe_addr" "$PORT" >/dev/null 2>&1; then
                    echo "Port $PORT is already in use on this host." >&2
                    echo "Pick another port: FW_PORT=9090 $0 serve" >&2
                    exit 75
                fi
            done
        fi
        # Auto-update: a no-op when current; an offline host still
        # serves the cached image.
        if ! docker pull "$IMAGE"; then
            echo "WARNING: could not check for updates — serving the local $IMAGE if present." >&2
        fi
        version_label=$(docker image inspect \
            --format '{{index .Config.Labels "org.opencontainers.image.version"}}' \
            "$IMAGE" 2>/dev/null || true)
        if [ -n "$version_label" ] && [ "$version_label" != "<no value>" ]; then
            echo "Serving Fabulous Writing $version_label"
        fi
        exec docker run --rm \
            -v fabulous-config:/config \
            -v fabulous-data:/data \
            -p "$PORT:8000" \
            "$IMAGE" serve
        ;;
    *)
        echo "Usage: $0 {setup|serve} [version]" >&2
        exit 64
        ;;
esac
