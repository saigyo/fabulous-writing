"""CI gate for the committed fly.io deployment artifacts (B16, #57).

deploy/fly/config.yaml is loaded through the real Settings model, so a
config-schema change that orphans the deployment config fails CI instead
of failing at machine boot. fly.toml gets structural pins via tomllib
(fly's own semantic validation runs at rollout: `fly config validate`).
"""

import re
import tomllib
from pathlib import Path

import pytest
import yaml

from app.core.config import load_settings

REPO_ROOT = Path(__file__).resolve().parents[2]
FLY_DIR = REPO_ROOT / "deploy" / "fly"
CONFIG_PATH = FLY_DIR / "config.yaml"
FLY_TOML_PATH = FLY_DIR / "fly.toml"

LANGUAGES = ("en", "de", "fr", "es", "it", "ja", "zh")
# The wizard's Anthropic column (setup_wizard.py COMMERCIAL_TIER_MODELS).
CLAUDE_TIERS = {
    "quality": "claude-opus-5",
    "balanced": "claude-sonnet-5",
    "cheap": "claude-haiku-4-5",
}
# Secret NAMES are allowed anywhere (the standing rule bans VALUES, not
# names — comments in the artifacts reference these variables); the scan
# below rejects assignment-shaped occurrences only.
SECRET_ENV_NAMES = (
    "FW_AUTH_SECRET",
    "FW_DATABASE_URL",
    "FW_SUPABASE_SECRET_KEY",
    "FW_SUPABASE_PUBLISHABLE_KEY",
    "FW_ADMIN_EMAIL",
    "FW_ADMIN_PASSWORD",
    "ANTHROPIC_API_KEY",
)


def _assert_no_secret_values(text: str) -> None:
    # Value-shaped guards shared by both artifacts: DSNs, Anthropic key
    # prefix, Supabase hosted key prefix, and assignment-shaped secret
    # names ("=" for YAML/env style, " =" for TOML style).
    assert "postgresql://" not in text
    assert "sk-ant-" not in text
    assert "sb_secret_" not in text
    for name in SECRET_ENV_NAMES:
        assert f"{name}=" not in text, name
        assert f"{name} =" not in text, name


@pytest.fixture(scope="module")
def fly_settings():
    # load_settings falls back to defaults for a missing file; the
    # existence assert keeps every downstream test honest.
    assert CONFIG_PATH.is_file(), f"missing {CONFIG_PATH}"
    return load_settings(CONFIG_PATH)


@pytest.fixture(scope="module")
def fly_toml():
    assert FLY_TOML_PATH.is_file(), f"missing {FLY_TOML_PATH}"
    return tomllib.loads(FLY_TOML_PATH.read_text(encoding="utf-8"))


class TestFlyConfigYaml:
    def test_production_environment(self, fly_settings):
        assert fly_settings.environment == "production"

    def test_postgres_with_external_schema_management(self, fly_settings):
        assert fly_settings.database.backend == "postgres"
        assert fly_settings.database.manage_schema is False

    def test_supabase_auth_mode(self, fly_settings):
        assert fly_settings.auth.mode == "supabase"
        url = fly_settings.auth.supabase.url
        assert url.startswith("https://")
        assert url.endswith(".supabase.co")

    def test_single_origin_serving(self, fly_settings):
        assert fly_settings.cors.origins == []
        assert fly_settings.frontend.dist_dir == Path("/app/dist")

    def test_default_provider_is_claude(self, fly_settings):
        assert fly_settings.providers.default_provider == "claude"

    def test_remote_tiers_route_to_claude_for_all_languages(self, fly_settings):
        for lang in LANGUAGES:
            tiers = fly_settings.routing.languages[lang]
            for tier, model in CLAUDE_TIERS.items():
                assert tiers[tier].provider == "claude", (lang, tier)
                assert tiers[tier].model == model, (lang, tier)

    def test_local_tier_stays_on_ollama(self, fly_settings):
        for lang in LANGUAGES:
            assert fly_settings.routing.languages[lang]["local"].provider == "ollama"

    def test_raw_table_lists_all_languages_explicitly(self):
        # RoutingSettings overlays built-in defaults for unlisted
        # languages (B24): the settings-level assertions above could not
        # distinguish "listed" from "silently defaulted", so the raw
        # file must name all seven.
        raw = yaml.safe_load(CONFIG_PATH.read_text(encoding="utf-8"))
        assert set(raw["routing"]["languages"]) == set(LANGUAGES)

    def test_no_secret_values_in_config(self):
        text = CONFIG_PATH.read_text(encoding="utf-8")
        _assert_no_secret_values(text)
        for name in SECRET_ENV_NAMES:
            assert f"{name}:" not in text, name


class TestFlyToml:
    def test_app_identity(self, fly_toml):
        assert fly_toml["app"] == "fabulous-writing"
        assert fly_toml["primary_region"] == "fra"

    def test_deploys_pinned_release_image(self, fly_toml):
        # release.yml strips the git tag's leading "v" before pushing
        # (version=${GITHUB_REF_NAME#v}): release v0.5.0 publishes GHCR
        # tag 0.5.0. A "v"-prefixed pin here would reference an image
        # that does not exist and fail the first deploy.
        image = fly_toml["build"]["image"]
        assert re.fullmatch(r"ghcr\.io/saigyo/fabulous-writing:\d+\.\d+\.\d+", image)

    def test_config_file_delivery_is_cross_pinned(self, fly_toml):
        files = fly_toml["files"]
        assert len(files) == 1
        assert files[0]["guest_path"] == "/fly/config.yaml"
        assert files[0]["local_path"] == "deploy/fly/config.yaml"
        assert fly_toml["env"]["FW_CONFIG_FILE"] == files[0]["guest_path"]

    def test_trusted_proxies_narrower_than_wildcard(self, fly_toml):
        value = fly_toml["env"]["FW_TRUSTED_PROXIES"]
        assert value == "fdaa::/16,172.16.0.0/12"

    def test_trusted_proxies_entries_are_valid_networks(self, fly_toml):
        # Uvicorn files an unparseable entry under exact-match string
        # literals WITHOUT any error or log line — a malformed CIDR here
        # (e.g. fdaa::/8, which has host bits set) silently trusts no
        # peer at all. This is the only offline guard for that.
        import ipaddress

        for entry in fly_toml["env"]["FW_TRUSTED_PROXIES"].split(","):
            ipaddress.ip_network(entry)

    def test_http_service(self, fly_toml):
        svc = fly_toml["http_service"]
        assert svc["internal_port"] == 8000
        assert svc["force_https"] is True
        # Always-on (2026-08-22): background bot traffic defeated
        # scale-to-zero — see docs/fly-deployment.md "Lifecycle".
        assert svc["auto_stop_machines"] == "off"
        assert svc["auto_start_machines"] is True
        assert svc["min_machines_running"] == 1

    def test_health_check(self, fly_toml):
        checks = fly_toml["http_service"]["checks"]
        assert len(checks) == 1
        assert checks[0]["method"] == "GET"
        assert checks[0]["path"] == "/api/health"

    def test_vm_sizing(self, fly_toml):
        # [[vm]] parses as a list.
        assert fly_toml["vm"][0]["size"] == "shared-cpu-2x"
        assert fly_toml["vm"][0]["memory"] == "2gb"
        # Check timings (interval/timeout/grace_period) stay deliberately
        # unpinned: they are tuned at rollout.

    def test_no_secret_values_in_fly_toml(self, fly_toml):
        text = FLY_TOML_PATH.read_text(encoding="utf-8")
        _assert_no_secret_values(text)
        # Env section may only carry the two non-secret variables.
        assert set(fly_toml["env"]) == {"FW_CONFIG_FILE", "FW_TRUSTED_PROXIES"}
