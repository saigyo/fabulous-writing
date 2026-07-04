#!/usr/bin/env bash
# Install spaCy models for the languages you want to check.
# Usage: ./scripts/install-models.sh en de [fr es it ja zh]
set -euo pipefail
cd "$(dirname "$0")/.."

VER=3.8.0  # must match the installed spaCy minor version
BASE=https://github.com/explosion/spacy-models/releases/download

for lang in "$@"; do
  case "$lang" in
    en) uv pip install "en-core-web-sm @ $BASE/en_core_web_sm-$VER/en_core_web_sm-$VER-py3-none-any.whl" ;;
    de) uv pip install "de-core-news-sm @ $BASE/de_core_news_sm-$VER/de_core_news_sm-$VER-py3-none-any.whl" ;;
    fr) uv pip install "fr-core-news-sm @ $BASE/fr_core_news_sm-$VER/fr_core_news_sm-$VER-py3-none-any.whl" ;;
    es) uv pip install "es-core-news-sm @ $BASE/es_core_news_sm-$VER/es_core_news_sm-$VER-py3-none-any.whl" ;;
    it) uv pip install "it-core-news-sm @ $BASE/it_core_news_sm-$VER/it_core_news_sm-$VER-py3-none-any.whl" ;;
    ja) uv pip install ginza ja_ginza ;; # GiNZA; fallback model: ja_core_news_sm (see README)
    zh) uv pip install "zh-core-web-sm @ $BASE/zh_core_web_sm-$VER/zh_core_web_sm-$VER-py3-none-any.whl" ;;
    *) echo "Unknown language: $lang" >&2; exit 1 ;;
  esac
done
