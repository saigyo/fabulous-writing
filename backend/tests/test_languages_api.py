from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.core.config import Settings
from app.main import create_app

RULES_DIR = Path(__file__).parent.parent / "rules"


@pytest.fixture
def client(tmp_path: Path):
    settings = Settings(db_path=tmp_path / "test.db", rules_dir=RULES_DIR)
    with TestClient(create_app(settings)) as client:
        yield client


def test_languages_endpoint_lists_all_seven(client: TestClient) -> None:
    data = client.get("/api/languages").json()
    assert [item["code"] for item in data] == ["en", "de", "fr", "es", "it", "ja", "zh"]
    by_code = {item["code"]: item for item in data}
    assert by_code["en"] == {
        "code": "en",
        "name": "English",
        "nlp_available": True,
        "model": "en_core_web_sm",
    }
    assert by_code["ja"]["nlp_available"] is True  # ginza is a dev dependency
    assert by_code["ja"]["model"] == "ja_ginza"
    assert by_code["fr"]["nlp_available"] is False  # model not installed in dev
