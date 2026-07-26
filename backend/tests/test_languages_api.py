from fastapi.testclient import TestClient


def test_languages_endpoint_lists_all_seven(authed_client: TestClient) -> None:
    data = authed_client.get("/api/languages").json()
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
    # All seven models are dev dependencies, so everything is available here;
    # the not-installed case is covered by the registry unit tests.
    assert all(item["nlp_available"] for item in data)
