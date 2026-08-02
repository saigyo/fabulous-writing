"""Interactive setup wizard for the containerized deployment (B17, #58).

Invoked as ``docker run --rm -it -v fabulous-config:/config <image> setup``
(the entrypoint dispatches ``setup`` to ``python -m app.setup_wizard``).

Contract: the wizard owns the config directory and regenerates BOTH files
completely on every run — ``fabulous.env`` (secrets only) and
``config.yaml`` (non-secret config, extending the baked-in template). A
re-run pre-fills every prompt from the existing files; because the files
are rewritten whole from the merged answers, switching providers can never
leave a stale key behind. Secrets are read via getpass, never echoed, and
never written anywhere but the env file. The ``.bak`` files written on each
run are a deliberate single-generation recovery mechanism for a
mis-answered re-run: they live in the same volume with the same 0600 mode
as the primary files and are overwritten by the following run. This means
that after a provider switch, the previous provider's key persists in
``fabulous.env.bak`` until the run after next. The generated config also carries a full per-language LLM routing table for the chosen provider (B24, #81), so every non-local quality tier works out of the box (the local tier stays on Ollama and is unavailable until Ollama is running).
"""

from __future__ import annotations

import getpass
import os
import secrets as secrets_module
import shutil
import sys
from pathlib import Path
from typing import Callable

import httpx
import yaml

from app.core.auth import ADMIN_SET_MIN_PASSWORD_LENGTH, validate_password
from app.core.config import BUILTIN_ENV_KEYS

MIN_SECRET_LENGTH = 32
DEFAULT_OLLAMA_URL = "http://host.docker.internal:11434"
# The Dockerfile's layout contract (Task 4 copies the template to exactly
# this path and declares the /config volume) — pinned by tests.
DEFAULT_CONFIG_DIR = "/config"
DEFAULT_TEMPLATE = "/app/config.container.yaml"

# Menu order is stable: tests and docs reference the numbers.
PROVIDER_MENU = ("claude", "openai", "mistral", "ollama")
PROVIDER_LABELS = {
    "claude": "Anthropic (Claude)",
    "openai": "OpenAI",
    "mistral": "Mistral",
    "ollama": "Ollama (existing local instance)",
}
KEY_PREFIXES = {"claude": "sk-ant-", "openai": "sk-"}
MIN_MISTRAL_KEY_LENGTH = 20

# Single-provider routing tables (B24, #81). Same models for all
# languages — language-specialized routing is a multi-provider luxury.
# IDs verified against provider model endpoints/docs 2026-08-02 (see the
# spec's research notes). Mistral's naming is inverted vs capability:
# Medium 3.5 is currently their strongest general model and Large 3 the
# fast multimodal — quality deliberately maps to medium.
LANGUAGES = ("en", "de", "fr", "es", "it", "ja", "zh")
COMMERCIAL_TIER_MODELS = {
    "claude": {
        "quality": "claude-opus-5",
        "balanced": "claude-sonnet-5",
        "cheap": "claude-haiku-4-5",
    },
    "openai": {
        "quality": "gpt-5.6-sol",
        "balanced": "gpt-5.6-terra",
        "cheap": "gpt-5.6-luna",
    },
    "mistral": {
        "quality": "mistral-medium-latest",
        "balanced": "mistral-large-latest",
        "cheap": "mistral-small-latest",
    },
}
# Mirrors ProviderSettings.ollama_model's default (pinned by a test): the
# local tier under a commercial provider resolves against that default.
DEFAULT_LOCAL_MODEL = "llama3.1"

InputFn = Callable[[str], str]
FetchFn = Callable[[str], tuple[list[str] | None, str]]


def parse_env_file(path: Path) -> dict[str, str]:
    """Parse KEY=VALUE lines; blank lines and #-comments are skipped.

    The stripped copy is used only to DETECT blanks/comments; the value is
    partitioned from the original line, so a password with deliberate
    leading/trailing spaces survives a re-run byte-for-byte.
    """
    result: dict[str, str] = {}
    if not path.is_file():
        return result
    for line in path.read_text(encoding="utf-8").splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        key, sep, value = line.partition("=")
        if sep:
            result[key.strip()] = value
    return result


def fetch_ollama_models(base_url: str) -> tuple[list[str] | None, str]:
    """Fetch installed model names from /api/tags — the app's own vantage.

    Failures are warnings by contract, so the parse of the payload lives
    inside the same exception boundary as the request: (None, reason)
    rather than an exception, whatever went wrong.
    """
    try:
        response = httpx.get(f"{base_url.rstrip('/')}/api/tags", timeout=5.0)
        response.raise_for_status()
        names = [m.get("name", "") for m in response.json().get("models", [])]
    except Exception as exc:  # noqa: BLE001 - any failure is the same advice
        return None, str(exc)
    return [n for n in names if n], "ok"


def _valid_text(value: str, label: str) -> str | None:
    if "\n" in value or "\r" in value:
        return f"{label} must not contain line breaks."
    return None


def _validate_key(provider: str, key: str) -> str | None:
    error = _valid_text(key, "API key")
    if error:
        return error
    prefix = KEY_PREFIXES.get(provider)
    if prefix and not key.startswith(prefix):
        return f"{PROVIDER_LABELS[provider]} keys start with '{prefix}'."
    if provider == "mistral" and len(key) < MIN_MISTRAL_KEY_LENGTH:
        return f"Mistral keys are at least {MIN_MISTRAL_KEY_LENGTH} characters."
    if not key:
        return "The key must not be empty."
    return None


def _ask(input_fn: InputFn, prompt: str, default: str | None = None) -> str:
    suffix = f" [{default}]" if default else ""
    while True:
        raw = input_fn(f"{prompt}{suffix}: ").strip()
        if not raw and default is not None:
            return default
        if raw:
            return raw


def _ask_email(input_fn: InputFn, default: str | None) -> str:
    while True:
        value = _ask(input_fn, "Admin email", default)
        if "@" in value and _valid_text(value, "Email") is None:
            return value
        print("That does not look like an email address — try again.")


def _ask_password(getpass_fn: InputFn, existing: str | None) -> str:
    prompt = (
        "Admin password (Enter = keep current): "
        if existing
        else f"Admin password (min {ADMIN_SET_MIN_PASSWORD_LENGTH} chars): "
    )
    while True:
        value = getpass_fn(prompt)
        if not value and existing:
            return existing
        if "\n" in value or "\r" in value:
            print("The password must not contain line breaks.")
            continue
        try:
            # The exact validator seed_admin() runs at container startup —
            # same character minimum AND bcrypt's byte maximum, so the
            # wizard can never write a password bootstrap will reject.
            return validate_password(value, min_length=ADMIN_SET_MIN_PASSWORD_LENGTH)
        except ValueError as exc:
            print(str(exc))


def _ask_provider(input_fn: InputFn, current: str | None) -> str:
    print("\nLLM provider — exactly one:")
    for index, name in enumerate(PROVIDER_MENU, start=1):
        marker = " (current)" if name == current else ""
        print(f"  {index}. {PROVIDER_LABELS[name]}{marker}")
    default = str(PROVIDER_MENU.index(current) + 1) if current in PROVIDER_MENU else None
    while True:
        choice = _ask(input_fn, "Choice", default)
        if choice in {"1", "2", "3", "4"}:
            return PROVIDER_MENU[int(choice) - 1]
        print("Enter 1, 2, 3, or 4.")


def _ask_api_key(getpass_fn: InputFn, provider: str, existing: str | None) -> str:
    label = PROVIDER_LABELS[provider]
    prompt = (
        f"{label} API key (Enter = keep current): "
        if existing
        else f"{label} API key: "
    )
    while True:
        value = getpass_fn(prompt)
        if not value and existing:
            return existing
        error = _validate_key(provider, value)
        if error is None:
            return value
        print(error)


def _ask_model_choice(
    input_fn: InputFn, names: list[str], prompt: str, default: str | None
) -> str:
    # A default the picker would reject (e.g. a commercial model ID left
    # over from a provider switch) must never be offered: on Enter it
    # would re-prompt with the same rejected default forever. But first,
    # resolve a unique basename to its canonical tag — pre-B24 configs
    # legitimately store e.g. "llama3.1" where the installed tag is
    # "llama3.1:latest" (the old probe accepted basename matches), and
    # the re-run contract says Enter keeps the current model.
    if default is not None and default not in names:
        matches = [n for n in names if n.split(":")[0] == default]
        default = matches[0] if len(matches) == 1 else None
    while True:
        raw = _ask(input_fn, prompt, default)
        if raw.isdigit() and 1 <= int(raw) <= len(names):
            return names[int(raw) - 1]
        if raw in names:  # an exact tag always wins over a basename match
            return raw
        matches = [n for n in names if n.split(":")[0] == raw]
        if len(matches) == 1:
            return matches[0]
        if matches:
            print(f"'{raw}' is ambiguous: {', '.join(matches)} — pick a number.")
            continue
        print(f"Pick 1-{len(names)} or one of the listed names.")


def build_routing_table(
    provider: str,
    *,
    strong: str | None = None,
    fast: str | None = None,
) -> dict[str, dict[str, dict[str, str]]]:
    """Full routing.languages table for a single-provider instance.

    Commercial providers: quality/balanced/cheap from the verified tier
    column, local stays honestly on Ollama's defaults (shows unavailable
    until the user runs Ollama). Ollama: quality+balanced -> strong,
    cheap+local -> fast.
    """
    if provider == "ollama":
        if not strong or not fast:
            raise ValueError("ollama routing needs strong and fast models")
        tier_entries = {
            "quality": ("ollama", strong),
            "balanced": ("ollama", strong),
            "cheap": ("ollama", fast),
            "local": ("ollama", fast),
        }
    else:
        models = COMMERCIAL_TIER_MODELS[provider]
        tier_entries = {
            "quality": (provider, models["quality"]),
            "balanced": (provider, models["balanced"]),
            "cheap": (provider, models["cheap"]),
            "local": ("ollama", DEFAULT_LOCAL_MODEL),
        }
    return {
        lang: {
            tier: {"provider": entry_provider, "model": entry_model}
            for tier, (entry_provider, entry_model) in tier_entries.items()
        }
        for lang in LANGUAGES
    }


def _backup(path: Path) -> None:
    if path.is_file():
        backup = path.with_name(path.name + ".bak")
        shutil.copy2(path, backup)
        backup.chmod(0o600)


def _write_env(path: Path, values: dict[str, str]) -> None:
    lines = [
        "# Generated by the Fabulous Writing setup wizard. Secrets only —",
        "# non-secret configuration lives in config.yaml next to this file.",
    ]
    lines += [f"{key}={value}" for key, value in values.items()]
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    path.chmod(0o600)


def run_wizard(
    config_dir: Path,
    template_path: Path,
    *,
    input_fn: InputFn = input,
    getpass_fn: InputFn = getpass.getpass,
    fetch_models: FetchFn = fetch_ollama_models,
) -> int:
    env_path = config_dir / "fabulous.env"
    config_path = config_dir / "config.yaml"
    existing_env = parse_env_file(env_path)
    existing_config: dict = {}
    if config_path.is_file():
        existing_config = yaml.safe_load(config_path.read_text(encoding="utf-8")) or {}
    rerun = bool(existing_env)

    print("Fabulous Writing setup" + (" (re-run — Enter keeps current values)" if rerun else ""))
    if rerun:
        print(
            "Note: admin email/password bootstrap the admin account only on"
            " the FIRST start against an empty database. Afterwards the"
            " password is changed in the app, not here."
        )

    email = _ask_email(input_fn, existing_env.get("FW_ADMIN_EMAIL"))
    password = _ask_password(getpass_fn, existing_env.get("FW_ADMIN_PASSWORD"))

    current_provider = None
    existing_providers = existing_config.get("providers") or {}
    if rerun:
        current_provider = existing_providers.get("default_provider")
    provider = _ask_provider(input_fn, current_provider)

    api_key = None
    ollama_url = None
    ollama_model = None
    strong_model = None
    fast_model = None
    if provider == "ollama":
        print(
            "The app runs inside Docker: 'localhost' would be the container"
            " itself. macOS/Windows reach the host via host.docker.internal;"
            " on Linux, add --add-host=host.docker.internal:host-gateway to"
            " the run command or use the docker0 gateway IP."
        )
        ollama_url = _ask(
            input_fn,
            "Ollama base URL (from inside the container)",
            existing_providers.get("ollama_base_url", DEFAULT_OLLAMA_URL),
        )
        # Prefill only from entries that are actually Ollama entries — after
        # a commercial run the table holds e.g. claude-opus-5, which must
        # never be offered as an Ollama default (the picker would reject it
        # on every Enter, and the fallback path would silently accept it).
        existing_en = existing_config.get("routing", {}).get("languages", {}).get("en", {})

        def _existing_ollama_model(tier: str) -> str | None:
            entry = existing_en.get(tier) or {}
            return entry.get("model") if entry.get("provider") == "ollama" else None

        default_strong = _existing_ollama_model("quality") or existing_providers.get(
            "ollama_model"
        )
        default_fast = _existing_ollama_model("cheap")
        names, detail = fetch_models(ollama_url)
        if names:
            print("Installed Ollama models:")
            for index, name in enumerate(names, start=1):
                print(f"  {index}. {name}")
            strong_model = _ask_model_choice(
                input_fn, names, "Strong model (quality/balanced tiers)", default_strong
            )
            fast_model = _ask_model_choice(
                input_fn,
                names,
                "Fast model (cheap/local tiers)",
                # A stale fast default (model since removed from Ollama)
                # must fall back to strong — the picker would drop it and
                # Enter would stop meaning "same as strong".
                default_fast if default_fast in names else strong_model,
            )
            print("Ollama reachable, models selected.")
        else:
            if names == []:
                print("Ollama is reachable but has no models installed — pull one")
                print("  first (ollama pull <model>); enter the model to use later.")
            else:
                print(f"WARNING: Ollama check failed: {detail}")
                print(
                    "  The config is written anyway. On Linux, try"
                    " --add-host=host.docker.internal:host-gateway on the run"
                    " command, or use the docker0 gateway IP. On macOS/Windows"
                    " host.docker.internal works out of the box."
                )
            strong_model = _ask(input_fn, "Ollama model", default_strong)
            fast_model = strong_model
        ollama_model = strong_model
    else:
        env_key = BUILTIN_ENV_KEYS[provider]
        api_key = _ask_api_key(getpass_fn, provider, existing_env.get(env_key))

    auth_secret = existing_env.get("FW_AUTH_SECRET", "")
    if auth_secret:
        rotate = _ask(input_fn, "Rotate FW_AUTH_SECRET? Logs everyone out (y/n)", "n")
        if rotate.lower().startswith("y"):
            auth_secret = ""
    if not auth_secret or len(auth_secret) < MIN_SECRET_LENGTH:
        auth_secret = secrets_module.token_urlsafe(48)
        print("Generated a new FW_AUTH_SECRET.")

    env_values = {
        "FW_AUTH_SECRET": auth_secret,
        "FW_ADMIN_EMAIL": email,
        "FW_ADMIN_PASSWORD": password,
    }
    if api_key is not None:
        env_values[BUILTIN_ENV_KEYS[provider]] = api_key

    config_data = yaml.safe_load(template_path.read_text(encoding="utf-8")) or {}
    providers_section = config_data.setdefault("providers", {})
    providers_section["default_provider"] = provider
    if provider == "ollama":
        providers_section["ollama_base_url"] = ollama_url
        providers_section["ollama_model"] = ollama_model
    else:
        # Commercial provider: still point Ollama at the host so the
        # local tier's availability ping probes the right place — the
        # tier lights up once host Ollama is reachable (B25, #84; needs
        # OLLAMA_HOST beyond 127.0.0.1 — see README troubleshooting).
        # The prefill-style read preserves a hand-edited custom URL
        # across re-runs and the last prompted URL across a provider
        # switch; `or` (not a .get default) so an explicit null cannot
        # emit an invalid config.
        providers_section["ollama_base_url"] = (
            existing_providers.get("ollama_base_url") or DEFAULT_OLLAMA_URL
        )

    config_data["routing"] = {
        "languages": build_routing_table(
            provider, strong=strong_model, fast=fast_model
        )
    }

    _backup(env_path)
    _backup(config_path)
    _write_env(env_path, env_values)
    header = ""
    if provider == "mistral":
        header = (
            "# Mistral's naming is inverted vs capability: Medium 3.5 is the\n"
            "# strongest general model, Large 3 the fast one — quality =>\n"
            "# mistral-medium-latest is deliberate (B24, #81).\n"
        )
    config_path.write_text(
        header + yaml.safe_dump(config_data, sort_keys=False), encoding="utf-8"
    )
    print(f"\nWrote {env_path.name} and {config_path.name} to {config_dir}.")
    print("Start the app with the serve command (see README quickstart).")
    return 0


def main() -> int:
    config_dir = Path(os.environ.get("FW_SETUP_CONFIG_DIR", DEFAULT_CONFIG_DIR))
    template = Path(os.environ.get("FW_CONFIG_TEMPLATE", DEFAULT_TEMPLATE))
    if not config_dir.is_dir():
        print(
            f"Config directory {config_dir} does not exist — run with"
            " -v fabulous-config:/config",
            file=sys.stderr,
        )
        return 1
    try:
        return run_wizard(config_dir, template)
    except (KeyboardInterrupt, EOFError):
        print("\nAborted — nothing was written.", file=sys.stderr)
        return 130


if __name__ == "__main__":
    raise SystemExit(main())
