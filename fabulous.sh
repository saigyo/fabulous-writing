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
