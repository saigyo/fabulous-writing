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
