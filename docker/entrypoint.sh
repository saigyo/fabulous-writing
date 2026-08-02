#!/bin/sh
# Entrypoint: `setup` runs the wizard; anything else serves the app.
# Env-file semantics: /config/fabulous.env is applied only for variables
# not already set — real environment variables win (fly.io secrets, B16).
set -eu

if [ "${1:-serve}" = "setup" ]; then
    exec python -m app.setup_wizard
fi

CONFIG_FILE="${FW_CONFIG_FILE:-/config/config.yaml}"
if [ ! -f "$CONFIG_FILE" ]; then
    echo "No $CONFIG_FILE found. Run the setup wizard first:" >&2
    echo "  docker run --rm -it -v fabulous-config:/config <image> setup" >&2
    echo "(or ./fabulous.sh setup)" >&2
    exit 78
fi

if [ -f /config/fabulous.env ]; then
    while IFS= read -r line || [ -n "$line" ]; do
        case "$line" in ''|\#*) continue ;; esac
        key=${line%%=*}
        value=${line#*=}
        if ! printenv "$key" >/dev/null 2>&1; then
            export "$key=$value"
        fi
    done < /config/fabulous.env
fi

exec uvicorn app.main:app --host 0.0.0.0 --port 8000
