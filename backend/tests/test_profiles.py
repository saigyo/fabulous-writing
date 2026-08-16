import sqlite3
from pathlib import Path

import pytest

from app.core.models import Language
from app.services.db.sqlite import SqliteDatabase, connect
from app.services.ownership import GlobalReadOnlyError
from app.services.profiles import ProfileStore

# Schema as it existed before the packs_on column was added.
_SCHEMA_BEFORE_PACKS_ON = """
CREATE TABLE profiles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    language TEXT NOT NULL, name TEXT NOT NULL,
    is_standard INTEGER NOT NULL DEFAULT 0,
    categories_off TEXT NOT NULL DEFAULT '[]',
    rule_exceptions TEXT NOT NULL DEFAULT '[]',
    domain_ids TEXT NOT NULL DEFAULT '[]',
    llm_provider TEXT, llm_model TEXT, llm_tier TEXT,
    llm_instructions TEXT NOT NULL DEFAULT '',
    example_text TEXT NOT NULL DEFAULT '',
    UNIQUE(language, name)
);
CREATE TABLE profile_seed_markers (language TEXT PRIMARY KEY);
INSERT INTO profiles (language, name) VALUES ('en', 'Old');
"""


@pytest.fixture()
def store(tmp_path):
    return ProfileStore(SqliteDatabase(tmp_path / "test.db"))


def test_create_and_list_profiles(store):
    p = store.create_profile(
        Language.DE,
        "Marketing",
        owner_id=None,
        categories_off=["correctness"],
        rule_exceptions=["style.weasel-words"],
        domain_ids=[1, 4],
        llm_provider="ollama",
        llm_model=None,
        llm_instructions="Zielgruppe: Kunden.",
        example_text="Beispieltext.",
    )
    assert p.id > 0 and p.name == "Marketing" and not p.is_standard
    listed = store.list_profiles(Language.DE, owner_id=1)
    assert [x.name for x in listed] == ["Marketing"]
    assert listed[0].rule_exceptions == ["style.weasel-words"]
    assert store.list_profiles(Language.EN, owner_id=1) == []


def test_duplicate_name_raises(store):
    store.create_profile(Language.EN, "Blog", owner_id=None, llm_provider="ollama")
    with pytest.raises(ValueError, match="exists"):
        store.create_profile(Language.EN, "Blog", owner_id=None, llm_provider="ollama")


def test_update_profile(store):
    p = store.create_profile(Language.EN, "Blog", owner_id=None, llm_provider="ollama")
    updated = store.update_profile(
        p.id, owner_id=1, is_admin=True, name="Blog posts", domain_ids=[2]
    )
    assert updated.name == "Blog posts" and updated.domain_ids == [2]
    assert store.get_profile(p.id, owner_id=1).domain_ids == [2]
    assert store.update_profile(9999, owner_id=1, is_admin=True, name="x") is None


def test_delete_profile(store):
    p = store.create_profile(Language.EN, "Blog", owner_id=None, llm_provider="ollama")
    assert store.delete_profile(p.id, owner_id=1, is_admin=True) is True
    assert store.delete_profile(p.id, owner_id=1, is_admin=True) is False
    assert store.list_profiles(Language.EN, owner_id=1) == []


def test_remove_domain_everywhere(store):
    a = store.create_profile(
        Language.EN, "A", owner_id=None, domain_ids=[1, 2], llm_provider="ollama"
    )
    b = store.create_profile(
        Language.DE, "B", owner_id=None, domain_ids=[2, 3], llm_provider="ollama"
    )
    store.remove_domain_everywhere(2)
    assert store.get_profile(a.id, owner_id=1).domain_ids == [1]
    assert store.get_profile(b.id, owner_id=1).domain_ids == [3]


def test_llm_tier_roundtrip(tmp_path: Path) -> None:
    store = ProfileStore(SqliteDatabase(tmp_path / "p.db"))
    p = store.create_profile(Language.EN, "Blog", owner_id=None, llm_tier="quality")
    assert store.get_profile(p.id, owner_id=1).llm_tier == "quality"
    updated = store.update_profile(p.id, owner_id=1, is_admin=True, llm_tier=None)
    assert updated.llm_tier is None


def test_llm_tier_column_migration_is_idempotent(tmp_path: Path) -> None:
    # Opening the store twice must not fail on the ALTER TABLE guard.
    ProfileStore(SqliteDatabase(tmp_path / "p.db"))
    store = ProfileStore(SqliteDatabase(tmp_path / "p.db"))
    assert (
        store.create_profile(
            Language.EN, "X", owner_id=None, llm_tier="local"
        ).llm_tier
        == "local"
    )


from app.core.models import Language as L  # noqa: E402
from app.services.seed_profiles import (  # noqa: E402
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
        names = [p.name for p in store.list_profiles(lang, owner_id=1)]
        assert names.count("Standard") == 1
        assert names.count("Marketing") == 1
        assert names.count("Technical Documentation") == 1


def test_example_seeding_and_deletion_sticks(store):
    seed_profiles(store, DEMOS, seed_examples=True)
    marketing = [
        p for p in store.list_profiles(L.EN, owner_id=1) if p.name == "Marketing"
    ][0]
    assert not marketing.is_standard
    assert "customer" in marketing.llm_instructions.lower()
    assert marketing.example_text.startswith("Introducing SuperWidget")
    store.delete_profile(marketing.id, owner_id=1, is_admin=True)
    seed_profiles(store, DEMOS, seed_examples=True)
    assert "Marketing" not in [p.name for p in store.list_profiles(L.EN, owner_id=1)]


def test_seed_examples_off(store):
    seed_profiles(store, DEMOS, seed_examples=False)
    assert [p.name for p in store.list_profiles(L.EN, owner_id=1)] == ["Standard"]
    # Turning the switch on later seeds the not-yet-marked languages.
    seed_profiles(store, DEMOS, seed_examples=True)
    assert "Marketing" in [p.name for p in store.list_profiles(L.EN, owner_id=1)]


def test_standard_defaults_reads_demo(store):
    defaults = standard_defaults(L.EN, DEMOS)
    assert defaults["llm_provider"] is None
    assert defaults["llm_tier"] == "balanced"
    assert defaults["example_text"].startswith("At the end of the day")


def test_seed_survives_name_collisions(store):
    # A private profile occupying a seeded name must not crash seeding, and
    # must not suppress seeding the global row under the same name: private
    # and global names live in different partial-unique-index scopes, so
    # this is not actually a collision from the global seeder's point of view.
    store.create_profile(
        L.EN, "Technical Documentation", owner_id=1, llm_provider="ollama"
    )
    seed_profiles(store, DEMOS, seed_examples=True)
    profiles = store.list_profiles(L.EN, owner_id=1)
    names = [p.name for p in profiles]
    assert names.count("Marketing") == 1
    techdocs = [p for p in profiles if p.name == "Technical Documentation"]
    assert len(techdocs) == 2
    assert any(not p.is_global for p in techdocs)  # the private shadow survives
    assert any(p.is_global for p in techdocs)  # the global row still gets seeded
    assert store.is_example_seeded(L.EN)
    seed_profiles(store, DEMOS, seed_examples=True)
    names = [p.name for p in store.list_profiles(L.EN, owner_id=1)]
    assert names.count("Marketing") == 1
    assert names.count("Technical Documentation") == 2  # stable across reseed


def test_seed_survives_user_profile_named_standard(store):
    # A private profile named "Standard" must not suppress seeding the
    # global Standard row (different partial-unique-index scopes).
    store.create_profile(L.EN, "Standard", owner_id=1, llm_provider="ollama")
    seed_profiles(store, DEMOS, seed_examples=False)
    assert store.standard_profile(L.EN) is not None  # the seeded global row exists
    private_standard = [
        p for p in store.list_profiles(L.EN, owner_id=1)
        if p.name == "Standard" and not p.is_global
    ]
    assert len(private_standard) == 1  # the private shadow survives
    # Seeding must still proceed for other languages too.
    assert store.standard_profile(L.DE) is not None


def test_packs_on_roundtrip(tmp_path) -> None:
    store = ProfileStore(SqliteDatabase(tmp_path / "p.sqlite"))
    profile = store.create_profile(
        Language.EN, "Docs", owner_id=None, packs_on=["techdocs", "blog"]
    )
    assert profile.packs_on == ["techdocs", "blog"]
    updated = store.update_profile(
        profile.id, owner_id=1, is_admin=True, packs_on=["techdocs"]
    )
    assert updated is not None and updated.packs_on == ["techdocs"]
    assert store.get_profile(profile.id, owner_id=1).packs_on == ["techdocs"]


def test_seed_pack_profiles(tmp_path) -> None:
    store = ProfileStore(SqliteDatabase(tmp_path / "profiles.sqlite"))
    seed_profiles(store, DEMOS, seed_examples=True)
    en = {p.name: p for p in store.list_profiles(Language.EN, owner_id=1)}
    assert en["Marketing"].packs_on == ["marketing"]
    assert en["Technical Documentation"].packs_on == ["techdocs"]
    assert en["Blog"].packs_on == ["blog"]
    assert en["Blog"].example_text  # demo file exists and is non-empty
    de = {p.name: p for p in store.list_profiles(Language.DE, owner_id=1)}
    assert de["Blog"].packs_on == ["blog"]
    ja = {p.name: p for p in store.list_profiles(Language.JA, owner_id=1)}
    assert ja["Blog"].packs_on == ["blog"]
    assert ja["Blog"].llm_instructions
    assert "いかがでしたか" in ja["Blog"].example_text

    for language in (Language.FR, Language.ES, Language.IT, Language.ZH):
        profiles = {p.name: p for p in store.list_profiles(language, owner_id=1)}
        assert profiles["Marketing"].packs_on == ["marketing"]
        assert profiles["Technical Documentation"].packs_on == ["techdocs"]
        assert profiles["Blog"].packs_on == ["blog"]
        for name in ("Marketing", "Technical Documentation", "Blog"):
            assert profiles[name].llm_instructions, f"{language}: {name}"
            assert profiles[name].example_text, f"{language}: {name}"


def test_connection_is_closed_after_use(tmp_path: Path) -> None:
    # `with sqlite3.connect(...)` alone only manages the transaction; the
    # store must also close the connection or every operation leaks one.
    store = ProfileStore(SqliteDatabase(tmp_path / "profiles.db"))
    with store._connect() as conn:
        conn.execute("SELECT 1")
    with pytest.raises(sqlite3.ProgrammingError):
        conn.execute("SELECT 1")


def test_packs_on_migration_defaults_empty(tmp_path) -> None:
    # A database created before the column existed gets it via _migrate.
    db = tmp_path / "old.sqlite"
    conn = sqlite3.connect(db)
    conn.executescript(_SCHEMA_BEFORE_PACKS_ON)
    conn.commit()
    conn.close()
    store = ProfileStore(SqliteDatabase(db))
    old = store.list_profiles(Language.EN, owner_id=1)[0]
    assert old.packs_on == []


def test_profile_visibility_global_plus_own(tmp_path):
    store = ProfileStore(SqliteDatabase(tmp_path / "p.db"))
    builtin = store.create_profile(Language.EN, "Standard", owner_id=None, is_standard=True)
    mine = store.create_profile(Language.EN, "Mine", owner_id=1)
    theirs = store.create_profile(Language.EN, "Theirs", owner_id=2)
    visible = {p.name for p in store.list_profiles(Language.EN, owner_id=1)}
    assert visible == {"Standard", "Mine"}
    assert store.get_profile(theirs.id, owner_id=1) is None
    assert store.get_profile(builtin.id, owner_id=1).is_global is True
    assert store.get_profile(mine.id, owner_id=1).is_global is False


def test_global_profile_mutation_requires_admin(tmp_path):
    store = ProfileStore(SqliteDatabase(tmp_path / "p.db"))
    builtin = store.create_profile(Language.EN, "Standard", owner_id=None, is_standard=True)
    with pytest.raises(GlobalReadOnlyError):
        store.update_profile(builtin.id, owner_id=1, is_admin=False, example_text="x")
    with pytest.raises(GlobalReadOnlyError):
        store.delete_profile(builtin.id, owner_id=1, is_admin=False)
    assert (
        store.update_profile(
            builtin.id, owner_id=1, is_admin=True, example_text="x"
        ).example_text
        == "x"
    )


def test_profile_names_unique_per_owner_and_global_partition(tmp_path):
    store = ProfileStore(SqliteDatabase(tmp_path / "p.db"))
    store.create_profile(Language.EN, "Casual", owner_id=None)
    # A user may shadow a global name...
    store.create_profile(Language.EN, "Casual", owner_id=1)
    # ...and another user may hold it too...
    store.create_profile(Language.EN, "casual", owner_id=2)
    # ...but neither partition tolerates its own duplicate, case-insensitive (LOWER).
    with pytest.raises(ValueError):
        store.create_profile(Language.EN, "casual", owner_id=1)
    with pytest.raises(ValueError):
        store.create_profile(Language.EN, "CASUAL", owner_id=None)
    # The language dimension is load-bearing: same name, other language, fine.
    store.create_profile(Language.DE, "Casual", owner_id=1)


def test_owner_id_not_serialized_but_is_global_is(tmp_path):
    store = ProfileStore(SqliteDatabase(tmp_path / "p.db"))
    profile = store.create_profile(Language.EN, "Mine", owner_id=1)
    dumped = profile.model_dump()
    assert "owner_id" not in dumped
    assert dumped["is_global"] is False


def test_migration_backfills_ownership_by_seed_name_match(tmp_path):
    # Legacy pre-M3 shape with the table-level UNIQUE and no owner_id.
    db = tmp_path / "legacy.db"
    with connect(db) as conn:
        conn.execute(
            """CREATE TABLE profiles (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                language TEXT NOT NULL,
                name TEXT NOT NULL,
                is_standard INTEGER NOT NULL DEFAULT 0,
                categories_off TEXT NOT NULL DEFAULT '[]',
                rule_exceptions TEXT NOT NULL DEFAULT '[]',
                packs_on TEXT NOT NULL DEFAULT '[]',
                domain_ids TEXT NOT NULL DEFAULT '[]',
                llm_provider TEXT,
                llm_model TEXT,
                llm_tier TEXT,
                llm_instructions TEXT NOT NULL DEFAULT '',
                example_text TEXT NOT NULL DEFAULT '',
                UNIQUE(language, name)
            )"""
        )
        conn.execute("CREATE TABLE profile_seed_markers (language TEXT PRIMARY KEY)")
        conn.execute("INSERT INTO profile_seed_markers VALUES ('en')")
        rows = [
            ("en", "Standard", 1),   # standard -> global
            ("en", "Marketing", 0),  # seed name + seeded language -> global
            ("en", "My Style", 0),   # user row -> admin (1)
            ("de", "Marketing", 0),  # seed name, UNseeded language -> admin
        ]
        for language, name, std in rows:
            conn.execute(
                "INSERT INTO profiles (language, name, is_standard) VALUES (?, ?, ?)",
                (language, name, std),
            )
    store = ProfileStore(SqliteDatabase(db))
    with connect(db) as conn:
        owners = {
            (row["language"], row["name"]): row["owner_id"]
            for row in conn.execute("SELECT language, name, owner_id FROM profiles")
        }
        sql = conn.execute(
            "SELECT sql FROM sqlite_master WHERE type='table' AND name='profiles'"
        ).fetchone()[0]
    assert owners == {
        ("en", "Standard"): None,
        ("en", "Marketing"): None,
        ("en", "My Style"): 1,
        ("de", "Marketing"): 1,
    }
    assert "UNIQUE" not in sql.upper()  # rebuild dropped the constraint
    ProfileStore(SqliteDatabase(db))  # idempotent second open


def test_backfill_runs_exactly_once(tmp_path):
    # A post-migration rename onto a seed name must NOT be re-globalized.
    db = tmp_path / "p.db"
    store = ProfileStore(SqliteDatabase(db))
    mine = store.create_profile(Language.EN, "My Style", owner_id=1)
    store.update_profile(mine.id, owner_id=1, is_admin=False, name="Marketing")
    ProfileStore(SqliteDatabase(db))  # reopen: migration guard must skip the backfill
    assert store.get_profile(mine.id, owner_id=1).is_global is False


def test_seed_names_are_one_set_between_migration_and_seeder():
    # Two-way: a name added to either side without the other must fail.
    from app.services.profiles import SEED_EXAMPLE_NAMES
    from app.services.seed_profiles import _EXAMPLE_SPECS

    assert set(_EXAMPLE_SPECS) == set(SEED_EXAMPLE_NAMES)
