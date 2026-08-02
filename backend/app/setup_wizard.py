"""Interactive setup wizard for the containerized deployment (B17, #58).

Invoked as ``docker run --rm -it -v fabulous-config:/config <image> setup``
(the entrypoint dispatches ``setup`` to ``python -m app.setup_wizard``).

Contract: the wizard owns the config directory and regenerates BOTH files
completely on every run — ``fabulous.env`` (secrets only) and
``config.yaml`` (non-secret config, extending the baked-in template). A
re-run pre-fills every prompt from the existing files; because the files
are rewritten whole from the merged answers, switching providers can never
leave a stale key behind. Secrets are read via getpass, never echoed, and
never written anywhere but the env file.
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

InputFn = Callable[[str], str]
ProbeFn = Callable[[str, str], tuple[bool, str]]


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


def check_ollama(base_url: str, model: str) -> tuple[bool, str]:
    """Probe /api/tags from inside the container — the app's own vantage.

    Probe failures are warnings by contract, so the parse of the payload
    lives inside the same exception boundary as the request: a reachable
    endpoint returning malformed JSON must not abort the wizard.
    """
    try:
        response = httpx.get(f"{base_url.rstrip('/')}/api/tags", timeout=5.0)
        response.raise_for_status()
        names = [m.get("name", "") for m in response.json().get("models", [])]
    except Exception as exc:  # noqa: BLE001 - any failure is the same advice
        return False, str(exc)
    if any(n == model or n.split(":")[0] == model for n in names):
        return True, "ok"
    return False, f"model '{model}' not in Ollama's list: {', '.join(names) or '(empty)'}"


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
    probe: ProbeFn = check_ollama,
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
    existing_providers = existing_config.get("providers", {})
    if rerun:
        current_provider = existing_providers.get("default_provider")
    provider = _ask_provider(input_fn, current_provider)

    api_key = None
    ollama_url = None
    ollama_model = None
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
        ollama_model = _ask(
            input_fn, "Ollama model", existing_providers.get("ollama_model")
        )
        ok, detail = probe(ollama_url, ollama_model)
        if ok:
            print("Ollama reachable, model found.")
        else:
            print(f"WARNING: Ollama check failed: {detail}")
            print(
                "  The config is written anyway. On Linux, try"
                " --add-host=host.docker.internal:host-gateway on the run"
                " command, or use the docker0 gateway IP. On macOS/Windows"
                " host.docker.internal works out of the box."
            )
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

    _backup(env_path)
    _backup(config_path)
    _write_env(env_path, env_values)
    config_path.write_text(
        yaml.safe_dump(config_data, sort_keys=False), encoding="utf-8"
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
