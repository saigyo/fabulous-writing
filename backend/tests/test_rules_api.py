from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.core.config import Settings
from app.main import create_app
from tests.conftest import auth_headers

RULES_DIR = Path(__file__).parent.parent / "rules"


@pytest.fixture
def client(tmp_path: Path):
    settings = Settings(db_path=tmp_path / "test.db", rules_dir=RULES_DIR)
    with TestClient(create_app(settings)) as client:
        client.headers.update(auth_headers(client))
        yield client


def test_rules_filtered_by_language(client: TestClient) -> None:
    body = client.get("/api/rules", params={"language": "de"}).json()
    languages = {rule["language"] for rule in body["rules"]}
    assert languages == {"de"}
    assert "style.fuellwoerter" in {rule["rule_id"] for rule in body["rules"]}


def test_rules_report_nlp_requirement(client: TestClient) -> None:
    body = client.get("/api/rules", params={"language": "en"}).json()
    by_id = {rule["rule_id"]: rule for rule in body["rules"]}
    assert by_id["style.passive-voice"]["requires_nlp"] is True
    assert by_id["style.weasel-words"]["requires_nlp"] is False


def test_rules_include_type_specific_detail(client: TestClient) -> None:
    body = client.get("/api/rules", params={"language": "en"}).json()
    by_id = {rule["rule_id"]: rule for rule in body["rules"]}

    weasel = by_id["style.weasel-words"]["detail"]
    assert "very" in weasel["tokens"]
    assert weasel["ignorecase"] is True

    wordiness = by_id["clarity.wordiness"]["detail"]
    assert wordiness["swap"]["utilize"] == "use"

    long_sentence = by_id["clarity.long-sentence"]["detail"]
    assert long_sentence["max"] == 30
    assert long_sentence["count"] == "matches"

    passive = by_id["style.passive-voice"]["detail"]
    assert isinstance(passive["pattern"], list) and passive["pattern"]


def test_token_count_occurrence_requires_nlp(client: TestClient) -> None:
    body = client.get("/api/rules", params={"language": "ja"}).json()
    by_id = {rule["rule_id"]: rule for rule in body["rules"]}
    assert by_id["clarity.long-sentence"]["requires_nlp"] is True
    assert by_id["clarity.long-sentence"]["detail"]["count"] == "tokens"
    assert by_id["clarity.touten-kajou"]["requires_nlp"] is False


def test_unfiltered_rules_keep_full_list(client: TestClient) -> None:
    body = client.get("/api/rules").json()
    languages = {rule["language"] for rule in body["rules"]}
    assert languages == {"en", "de", "fr", "es", "it", "ja", "zh"}


def test_rules_carry_pack_examples_and_packs_index(client: TestClient) -> None:
    payload = client.get("/api/rules?language=en").json()
    by_id = {rule["rule_id"]: rule for rule in payload["rules"]}
    weasel = by_id["style.weasel-words"]
    assert weasel["pack"] is None
    assert weasel["examples"]["bad"] and weasel["examples"]["good"]
    # Packs are discovered from the catalog and returned sorted.
    assert payload["packs"] == ["blog", "marketing", "techdocs"]
