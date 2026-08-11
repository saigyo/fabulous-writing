#!/bin/sh
# Entrypoint: `setup` runs the wizard; anything else serves the app.
# Env-file semantics: the env file (default: fabulous.env next to the
# config file, override with FW_ENV_FILE) is applied only for variables
# not already set — real environment variables win (fly.io secrets, B16).
# NB: the wizard writes into FW_SETUP_CONFIG_DIR (default /config) — a
# deployment that relocates FW_CONFIG_FILE must relocate that too, or
# set FW_ENV_FILE explicitly.
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

# Never echo the offending line: it may hold a mis-pasted secret.
bad_env_line() {
    echo "Error: $1 line $2 is not a KEY=VALUE line" >&2
    exit 78
}

ENV_FILE="${FW_ENV_FILE:-$(dirname "$CONFIG_FILE")/fabulous.env}"
if [ -f "$ENV_FILE" ]; then
    cr=$(printf '\r')
    lineno=0
    while IFS= read -r line || [ -n "$line" ]; do
        lineno=$((lineno + 1))
        line=${line%"$cr"}
        case "$line" in ''|\#*) continue ;; esac
        case "$line" in
            *=*) ;;
            *) bad_env_line "$ENV_FILE" "$lineno" ;;
        esac
        key=${line%%=*}
        value=${line#*=}
        # A key that export can't accept would crash with a bare shell
        # error under set -eu; validate POSIX name syntax first.
        case "$key" in
            ''|*[!A-Za-z0-9_]*|[0-9]*) bad_env_line "$ENV_FILE" "$lineno" ;;
        esac
        if ! printenv "$key" >/dev/null 2>&1; then
            export "$key=$value"
        fi
    done < "$ENV_FILE"
fi

exec uvicorn app.main:app --host 0.0.0.0 --port 8000
