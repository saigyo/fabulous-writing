#!/usr/bin/env bash
# Download Hunspell dictionaries for morphology-aware suggestion vetting.
# Usage: ./scripts/install-dictionaries.sh en de [fr es it]
#
# Source: https://github.com/wooorm/dictionaries (each dictionary keeps its own
# license — e.g. de is igerman98, GPL-2.0/GPL-3.0 — which is why they are
# downloaded on demand rather than bundled with this MIT-licensed repository).
set -euo pipefail
cd "$(dirname "$0")/.."

BASE=https://raw.githubusercontent.com/wooorm/dictionaries/main/dictionaries
mkdir -p dictionaries

for lang in "$@"; do
  case "$lang" in
    en|de|fr|es|it)
      curl -fsSL -o "dictionaries/$lang.aff" "$BASE/$lang/index.aff"
      curl -fsSL -o "dictionaries/$lang.dic" "$BASE/$lang/index.dic"
      echo "installed dictionaries/$lang.{aff,dic}"
      ;;
    *) echo "No dictionary configured for language: $lang" >&2; exit 1 ;;
  esac
done
