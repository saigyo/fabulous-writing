from pathlib import Path

import pytest

from app.core.models import Language
from app.services.profiles import ProfileStore


@pytest.fixture()
def store(tmp_path):
    return ProfileStore(tmp_path / "test.db")


def test_create_and_list_profiles(store):
    p = store.create_profile(
        Language.DE,
        "Marketing",
        categories_off=["correctness"],
        rule_exceptions=["style.weasel-words"],
        domain_ids=[1, 4],
        llm_provider="ollama",
        llm_model=None,
        llm_instructions="Zielgruppe: Kunden.",
        example_text="Beispieltext.",
    )
    assert p.id > 0 and p.name == "Marketing" and not p.is_standard
    listed = store.list_profiles(Language.DE)
    assert [x.name for x in listed] == ["Marketing"]
    assert listed[0].rule_exceptions == ["style.weasel-words"]
    assert store.list_profiles(Language.EN) == []


def test_duplicate_name_raises(store):
    store.create_profile(Language.EN, "Blog", llm_provider="ollama")
    with pytest.raises(ValueError, match="exists"):
        store.create_profile(Language.EN, "Blog", llm_provider="ollama")


def test_update_profile(store):
    p = store.create_profile(Language.EN, "Blog", llm_provider="ollama")
    updated = store.update_profile(p.id, name="Blog posts", domain_ids=[2])
    assert updated.name == "Blog posts" and updated.domain_ids == [2]
    assert store.get_profile(p.id).domain_ids == [2]
    assert store.update_profile(9999, name="x") is None


def test_delete_profile(store):
    p = store.create_profile(Language.EN, "Blog", llm_provider="ollama")
    assert store.delete_profile(p.id) is True
    assert store.delete_profile(p.id) is False
    assert store.list_profiles(Language.EN) == []


def test_remove_domain_everywhere(store):
    a = store.create_profile(Language.EN, "A", domain_ids=[1, 2], llm_provider="ollama")
    b = store.create_profile(Language.DE, "B", domain_ids=[2, 3], llm_provider="ollama")
    store.remove_domain_everywhere(2)
    assert store.get_profile(a.id).domain_ids == [1]
    assert store.get_profile(b.id).domain_ids == [3]


def test_llm_tier_roundtrip(tmp_path: Path) -> None:
    store = ProfileStore(tmp_path / "p.db")
    p = store.create_profile(Language.EN, "Blog", llm_tier="quality")
    assert store.get_profile(p.id).llm_tier == "quality"
    updated = store.update_profile(p.id, llm_tier=None)
    assert updated.llm_tier is None


def test_llm_tier_column_migration_is_idempotent(tmp_path: Path) -> None:
    # Opening the store twice must not fail on the ALTER TABLE guard.
    ProfileStore(tmp_path / "p.db")
    store = ProfileStore(tmp_path / "p.db")
    assert store.create_profile(Language.EN, "X", llm_tier="local").llm_tier == "local"


from app.core.models import Language as L  # noqa: E402
from app.services.seed_profiles import (  # noqa: E402
    EXAMPLE_LANGUAGES,
    seed_profiles,
    standard_defaults,
)

DEMOS = __import__("pathlib").Path(__file__).parent.parent / "demos"


def test_seed_creates_standard_for_every_language(store):
    seed_profiles(store, DEMOS, seed_examples=False)
    for lang in Language:
        std = store.standard_profile(lang)
        assert std is not None and std.name == "Standard"
        assert std.llm_provider is None and std.llm_model is None
        assert std.llm_tier == "balanced"
        assert std.categories_off == [] and std.rule_exceptions == []
        assert std.example_text == (DEMOS / f"{lang.value}.txt").read_text(
            encoding="utf-8"
        )


def test_seed_is_idempotent(store):
    seed_profiles(store, DEMOS, seed_examples=True)
    seed_profiles(store, DEMOS, seed_examples=True)
    for lang in Language:
        names = [p.name for p in store.list_profiles(lang)]
        assert names.count("Standard") == 1
        if lang in EXAMPLE_LANGUAGES:
            assert names.count("Marketing") == 1
            assert names.count("Technical Documentation") == 1


def test_example_seeding_and_deletion_sticks(store):
    seed_profiles(store, DEMOS, seed_examples=True)
    marketing = [
        p for p in store.list_profiles(L.EN) if p.name == "Marketing"
    ][0]
    assert not marketing.is_standard
    assert "customer" in marketing.llm_instructions.lower()
    assert marketing.example_text.startswith("Introducing SuperWidget")
    store.delete_profile(marketing.id)
    seed_profiles(store, DEMOS, seed_examples=True)
    assert "Marketing" not in [p.name for p in store.list_profiles(L.EN)]


def test_seed_examples_off(store):
    seed_profiles(store, DEMOS, seed_examples=False)
    assert [p.name for p in store.list_profiles(L.EN)] == ["Standard"]
    # Turning the switch on later seeds the not-yet-marked languages.
    seed_profiles(store, DEMOS, seed_examples=True)
    assert "Marketing" in [p.name for p in store.list_profiles(L.EN)]


def test_standard_defaults_reads_demo(store):
    defaults = standard_defaults(L.EN, DEMOS)
    assert defaults["llm_provider"] is None
    assert defaults["llm_tier"] == "balanced"
    assert defaults["example_text"].startswith("At the end of the day")


def test_seed_survives_name_collisions(store):
    # A user-created profile occupying a seeded name must not crash seeding,
    # and must not cause a retry loop on the next run.
    store.create_profile(L.EN, "Technical Documentation", llm_provider="ollama")
    seed_profiles(store, DEMOS, seed_examples=True)
    names = [p.name for p in store.list_profiles(L.EN)]
    assert names.count("Marketing") == 1
    assert names.count("Technical Documentation") == 1
    assert store.is_example_seeded(L.EN)
    seed_profiles(store, DEMOS, seed_examples=True)
    names = [p.name for p in store.list_profiles(L.EN)]
    assert names.count("Marketing") == 1


def test_seed_survives_user_profile_named_standard(store):
    store.create_profile(L.EN, "Standard", llm_provider="ollama")
    seed_profiles(store, DEMOS, seed_examples=False)
    # The colliding user profile blocks the seeded Standard for EN; seeding
    # must not crash and must still seed the other languages.
    assert store.standard_profile(L.DE) is not None


def test_packs_on_roundtrip(tmp_path) -> None:
    store = ProfileStore(tmp_path / "p.sqlite")
    profile = store.create_profile(
        Language.EN, "Docs", packs_on=["techdocs", "blog"]
    )
    assert profile.packs_on == ["techdocs", "blog"]
    updated = store.update_profile(profile.id, packs_on=["techdocs"])
    assert updated is not None and updated.packs_on == ["techdocs"]
    assert store.get_profile(profile.id).packs_on == ["techdocs"]


def test_seed_pack_profiles(tmp_path) -> None:
    store = ProfileStore(tmp_path / "profiles.sqlite")
    seed_profiles(store, DEMOS, seed_examples=True)
    en = {p.name: p for p in store.list_profiles(Language.EN)}
    assert en["Marketing"].packs_on == ["marketing"]
    assert en["Technical Documentation"].packs_on == ["techdocs"]
    assert en["Blog"].packs_on == ["blog"]
    assert en["Blog"].example_text  # demo file exists and is non-empty
    de = {p.name: p for p in store.list_profiles(Language.DE)}
    assert de["Blog"].packs_on == ["blog"]
    # Japanese keeps Marketing/TechDoc (packs are no-ops there for now), no Blog.
    ja = {p.name: p for p in store.list_profiles(Language.JA)}
    assert "Blog" not in ja


def test_packs_on_migration_defaults_empty(tmp_path) -> None:
    # A database created before the column existed gets it via _migrate.
    import sqlite3

    db = tmp_path / "old.sqlite"
    conn = sqlite3.connect(db)
    conn.executescript(
        """CREATE TABLE profiles (
               id INTEGER PRIMARY KEY AUTOINCREMENT,
               language TEXT NOT NULL, name TEXT NOT NULL,
               is_standard INTEGER NOT NULL DEFAULT 0,
               categories_off TEXT NOT NULL DEFAULT '[]',
               rule_exceptions TEXT NOT NULL DEFAULT '[]',
               domain_ids TEXT NOT NULL DEFAULT '[]',
               llm_provider TEXT, llm_model TEXT, llm_tier TEXT,
               llm_instructions TEXT NOT NULL DEFAULT '',
               example_text TEXT NOT NULL DEFAULT '',
               UNIQUE(language, name));
           CREATE TABLE profile_seed_markers (language TEXT PRIMARY KEY);
           INSERT INTO profiles (language, name) VALUES ('en', 'Old');"""
    )
    conn.commit()
    conn.close()
    store = ProfileStore(db)
    old = store.list_profiles(Language.EN)[0]
    assert old.packs_on == []
