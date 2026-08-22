"""Container-deployment hooks: FW_CONFIG_FILE, SPA serving, health version."""

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.core.config import EmbedSettings, FrontendSettings, Settings, load_settings
from app.main import create_app


def make_dist(tmp_path: Path, embed: bool = True) -> Path:
    dist = tmp_path / "dist"
    (dist / "assets").mkdir(parents=True)
    (dist / "index.html").write_text("<!doctype html><title>FW</title>", encoding="utf-8")
    (dist / "assets" / "app-abc123.js").write_text("console.log('fw')", encoding="utf-8")
    (dist / "favicon.svg").write_text("<svg/>", encoding="utf-8")
    if embed:
        (dist / "embed.html").write_text(
            "<!doctype html><title>FW embed</title>", encoding="utf-8"
        )
    return dist


def make_app(
    tmp_path: Path, dist: Path | None, ancestors: list[str] | None = None
) -> TestClient:
    settings = Settings(
        db_path=tmp_path / "test.db",
        rules_dir=tmp_path / "rules",
        frontend=FrontendSettings(dist_dir=dist),
        embed=EmbedSettings(allowed_ancestors=ancestors or []),
    )
    return TestClient(create_app(settings))


class TestConfigFileEnv:
    def test_env_var_selects_config_file(self, tmp_path, monkeypatch):
        cfg = tmp_path / "elsewhere.yaml"
        cfg.write_text("environment: dev\n", encoding="utf-8")
        monkeypatch.setenv("FW_CONFIG_FILE", str(cfg))
        assert load_settings().environment == "dev"

    def test_explicit_argument_beats_env_var(self, tmp_path, monkeypatch):
        env_cfg = tmp_path / "env.yaml"
        env_cfg.write_text("environment: dev\n", encoding="utf-8")
        arg_cfg = tmp_path / "arg.yaml"
        arg_cfg.write_text("environment: staging\n", encoding="utf-8")
        monkeypatch.setenv("FW_CONFIG_FILE", str(env_cfg))
        assert load_settings(arg_cfg).environment == "staging"

    def test_empty_env_var_falls_back_to_default_path(self, tmp_path, monkeypatch):
        # An empty FW_CONFIG_FILE (e.g. `FW_CONFIG_FILE= uvicorn ...`) must
        # behave like unset — the default backend/config.yaml resolution
        # still applies, rather than Path("") suppressing it.
        import app.core.config as config_module

        monkeypatch.setattr(config_module, "BACKEND_DIR", tmp_path)
        (tmp_path / "config.yaml").write_text("environment: dev\n", encoding="utf-8")
        monkeypatch.setenv("FW_CONFIG_FILE", "")
        assert load_settings().environment == "dev"


class TestSpaServing:
    def test_index_served_at_root(self, tmp_path):
        client = make_app(tmp_path, make_dist(tmp_path))
        r = client.get("/")
        assert r.status_code == 200
        assert "<!doctype html>" in r.text
        assert r.headers["content-security-policy"] == "frame-ancestors 'none'"

    def test_deep_link_falls_back_to_index(self, tmp_path):
        client = make_app(tmp_path, make_dist(tmp_path))
        r = client.get("/documents/42")
        assert r.status_code == 200
        assert "<!doctype html>" in r.text
        assert r.headers["content-security-policy"] == "frame-ancestors 'none'"

    def test_hashed_asset_served(self, tmp_path):
        client = make_app(tmp_path, make_dist(tmp_path))
        r = client.get("/assets/app-abc123.js")
        assert r.status_code == 200
        assert "console.log" in r.text
        assert "content-security-policy" not in r.headers

    def test_top_level_file_served(self, tmp_path):
        client = make_app(tmp_path, make_dist(tmp_path))
        r = client.get("/favicon.svg")
        assert r.status_code == 200
        assert "content-security-policy" not in r.headers

    def test_index_html_exact_path_still_carries_csp(self, tmp_path):
        # index.html is itself an entry in spa_files (an exact match, not a
        # fallback) — it must still route through the CSP-header branch
        # rather than the file-list fast path used for non-HTML assets.
        client = make_app(tmp_path, make_dist(tmp_path))
        r = client.get("/index.html")
        assert r.status_code == 200
        assert r.headers["content-security-policy"] == "frame-ancestors 'none'"

    def test_index_csp_stays_none_even_with_ancestors_configured(self, tmp_path):
        # The main SPA must never be frameable, regardless of the embed
        # allowlist — only /embed opts into frame-ancestors.
        client = make_app(
            tmp_path, make_dist(tmp_path), ancestors=["chrome-extension://abc"]
        )
        r = client.get("/")
        assert r.status_code == 200
        assert r.headers["content-security-policy"] == "frame-ancestors 'none'"
        r = client.get("/documents/42")
        assert r.headers["content-security-policy"] == "frame-ancestors 'none'"

    def test_unknown_api_path_stays_404(self, tmp_path):
        client = make_app(tmp_path, make_dist(tmp_path))
        r = client.get("/api/definitely-not-a-route")
        assert r.status_code == 404
        assert "<!doctype html>" not in r.text
        assert r.json() == {"detail": "Not Found"}
        assert "content-security-policy" not in r.headers

    def test_api_routes_still_reachable(self, tmp_path):
        client = make_app(tmp_path, make_dist(tmp_path))
        assert client.get("/api/health").status_code == 200

    def test_no_dist_dir_means_no_spa_routes(self, tmp_path):
        client = make_app(tmp_path, None)
        assert client.get("/").status_code == 404

    def test_path_traversal_is_not_served(self, tmp_path):
        client = make_app(tmp_path, make_dist(tmp_path))
        secret = tmp_path / "secret.txt"
        secret.write_text("nope", encoding="utf-8")
        # Percent-encoded dot segments survive httpx's client-side URL
        # normalization and reach the ASGI path decoded — a literal
        # "/../secret.txt" would be normalized away before the app sees it.
        r = client.get("/%2e%2e/secret.txt")
        assert "nope" not in r.text

    def test_dist_dir_without_index_fails_loudly(self, tmp_path):
        empty = tmp_path / "not-a-dist"
        empty.mkdir()
        with pytest.raises(RuntimeError, match="index.html"):
            make_app(tmp_path, empty)


class TestEmbedServing:
    @pytest.mark.parametrize("path", ["/embed", "/embed/", "/embed/anything", "/embed.html"])
    def test_embed_paths_serve_embed_html(self, tmp_path, path):
        client = make_app(tmp_path, make_dist(tmp_path))
        r = client.get(path)
        assert r.status_code == 200
        assert "FW embed" in r.text

    @pytest.mark.parametrize("path", ["/embed", "/embed/", "/embed/anything", "/embed.html"])
    def test_embed_default_csp_is_none(self, tmp_path, path):
        client = make_app(tmp_path, make_dist(tmp_path))
        r = client.get(path)
        assert r.headers["content-security-policy"] == "frame-ancestors 'none'"

    @pytest.mark.parametrize("path", ["/embed", "/embed/", "/embed/anything", "/embed.html"])
    def test_embed_configured_ancestors_allowlisted(self, tmp_path, path):
        client = make_app(
            tmp_path,
            make_dist(tmp_path),
            ancestors=["chrome-extension://abc", "https://example.com"],
        )
        r = client.get(path)
        assert r.status_code == 200
        assert (
            r.headers["content-security-policy"]
            == "frame-ancestors chrome-extension://abc https://example.com"
        )

    def test_index_and_root_stay_none_when_ancestors_configured(self, tmp_path):
        client = make_app(
            tmp_path, make_dist(tmp_path), ancestors=["chrome-extension://abc"]
        )
        r = client.get("/")
        assert r.status_code == 200
        assert "FW embed" not in r.text
        assert r.headers["content-security-policy"] == "frame-ancestors 'none'"

    def test_dist_without_embed_html_falls_back_to_index(self, tmp_path):
        # Forward-compat: an old dist (pre-embed frontend) paired with a new
        # backend must not 500 — /embed just falls back to the main SPA.
        client = make_app(tmp_path, make_dist(tmp_path, embed=False))
        r = client.get("/")
        assert r.status_code == 200
        r = client.get("/embed")
        assert r.status_code == 200
        assert "FW embed" not in r.text
        assert "<!doctype html>" in r.text
        assert r.headers["content-security-policy"] == "frame-ancestors 'none'"


class TestHealthVersion:
    def test_version_from_env(self, tmp_path, monkeypatch):
        monkeypatch.setenv("FW_APP_VERSION", "1.2.3")
        client = make_app(tmp_path, None)
        assert client.get("/api/health").json()["version"] == "1.2.3"

    def test_version_defaults_to_dev(self, tmp_path, monkeypatch):
        monkeypatch.delenv("FW_APP_VERSION", raising=False)
        client = make_app(tmp_path, None)
        assert client.get("/api/health").json()["version"] == "dev"
