#!/usr/bin/env bash
# Offline supabase e2e suite runner (B27, #94).
#
# Usage:
#   scripts/e2e-supabase.sh [pytest args...]   # run the suite (starts stack if down)
#   scripts/e2e-supabase.sh --down             # stop the local supabase stack
#
# The stack is left running between invocations for fast iteration.
set -euo pipefail

cd "$(dirname "$0")/.."

command -v supabase >/dev/null 2>&1 || {
    echo "error: supabase CLI not found (brew install supabase/tap/supabase)" >&2
    exit 1
}

if [[ "${1:-}" == "--down" ]]; then
    # Plain stop (keeps the DB volume as a backup): local reruns therefore
    # accumulate GoTrue users across stack generations — which is exactly
    # why run-unique identities, not cleanup, are the correctness mechanism.
    supabase stop
    exit 0
fi

docker info >/dev/null 2>&1 || {
    echo "error: docker daemon not reachable (colima start?)" >&2
    exit 1
}

# ES256 signing key for local GoTrue. With signing_keys_path declared in
# config.toml, `gen signing-key` reads the declared file BEFORE writing and
# hard-errors if it is absent (discovered in Task 1; the redirect form
# corrupts the file with a JSON error object). Working recipe: pre-seed an
# empty array, then let the CLI write the declared file itself (native JSON
# array; --yes answers the overwrite prompt; stdout discarded — it names
# the file, not the key, but stay conservative). A failed generation leaves
# `[]`, which the condition below treats as regenerate-needed: self-healing.
if [[ ! -s supabase/signing_keys.json ]] || [[ "$(cat supabase/signing_keys.json)" == "[]" ]]; then
    echo '[]' > supabase/signing_keys.json
    supabase gen signing-key --algorithm ES256 --yes >/dev/null
fi

# NOTE: a running stack keeps its boot-time config — edits to
# supabase/config.toml or supabase/templates/ require
# `scripts/e2e-supabase.sh --down` first.
# Start the stack only if it is not already running. stdout is discarded:
# supabase start prints the stack's keys there.
if ! supabase status >/dev/null 2>&1; then
    supabase start >/dev/null
fi

# Stack coordinates and keys, from the CLI's own env output. SECRET maps to
# the legacy SERVICE_ROLE_KEY: local GoTrue rejects the sb_secret_ opaque
# key as a Bearer admin credential (the hosted platform translates it, the
# local Kong does not) — verified on CLI 2.114.0.
# Unset first: values inherited from the caller's shell must not survive a
# partially failed status call and masquerade as fresh stack coordinates.
unset API_URL PUBLISHABLE_KEY SERVICE_ROLE_KEY MAILPIT_URL
eval "$(supabase status -o env 2>/dev/null | grep -E '^(API_URL|PUBLISHABLE_KEY|SERVICE_ROLE_KEY|MAILPIT_URL)=' || true)"
for var in API_URL PUBLISHABLE_KEY SERVICE_ROLE_KEY MAILPIT_URL; do
    [[ -n "${!var:-}" ]] || {
        echo "error: supabase status did not report $var — is the stack healthy? (supabase status)" >&2
        exit 1
    }
done
export FW_SUPABASE_E2E_API_URL="$API_URL"
export FW_SUPABASE_E2E_MAILPIT_URL="$MAILPIT_URL"
export FW_SUPABASE_PUBLISHABLE_KEY="$PUBLISHABLE_KEY"
export FW_SUPABASE_SECRET_KEY="$SERVICE_ROLE_KEY"

cd backend
# "$@" before -n0: pytest's last-argument-wins would otherwise let a
# forwarded -n/--numprocesses re-enable xdist against the single shared app.
exec uv run pytest tests_e2e -q "$@" -n0
