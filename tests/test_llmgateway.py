"""LLM Gateway (DevPass) provider: registry entry, key, model ids and wire format."""
from types import SimpleNamespace

import pytest

from tradingagents.llm_clients.api_key_env import PROVIDER_API_KEY_ENV
from tradingagents.llm_clients.openai_client import (
    OPENAI_COMPATIBLE_PROVIDERS,
    GatewayChatOpenAI,
    _supports_reasoning_effort,
)
from tradingagents.llm_clients.validators import validate_model


@pytest.mark.unit
def test_registry_entry_and_key():
    spec = OPENAI_COMPATIBLE_PROVIDERS["llmgateway"]
    assert spec.base_url == "https://api.llmgateway.io/v1"
    assert spec.chat_class is GatewayChatOpenAI
    assert spec.key_optional is False
    assert PROVIDER_API_KEY_ENV["llmgateway"] == "LLM_GATEWAY_API_KEY"


@pytest.mark.unit
def test_any_route_is_a_valid_model():
    assert validate_model("llmgateway", "alibaba/deepseek-v3.2:cn-beijing")


@pytest.mark.unit
@pytest.mark.parametrize("model,expected", [
    ("openai/gpt-5.5:us-east", True),
    ("openai/gpt-4o", False),
])
def test_reasoning_effort_reads_the_bare_model_id(model, expected):
    assert _supports_reasoning_effort(model) is expected


@pytest.mark.parametrize("arguments,valid", [('{"answer": 3}', True), ('{"answer": "not-an-integer"}', False)])
def test_gateway_wire_request_and_schema_validation(monkeypatch, arguments, valid):
    from pydantic import BaseModel

    from tradingagents.llm_clients import create_llm_client

    class Answer(BaseModel):
        answer: int

    monkeypatch.setenv("LLM_GATEWAY_API_KEY", "dummy")
    llm = create_llm_client(provider="llmgateway", model="custom-route").get_llm()

    assert str(llm.openai_api_base) == "https://api.llmgateway.io/v1"
    assert llm.openai_api_key.get_secret_value() == "dummy"
    captured = []

    def create(**kwargs):
        captured.append(kwargs)
        payload = {"id": "test", "object": "chat.completion", "created": 0, "model": "custom-route",
                   "choices": [{"index": 0, "finish_reason": "tool_calls", "message": {
                       "role": "assistant", "content": None, "tool_calls": [{"id": "one", "type": "function",
                       "function": {"name": "Answer", "arguments": arguments}}]}}]}
        return SimpleNamespace(parse=lambda: payload)

    monkeypatch.setattr(llm.client.with_raw_response, "create", create)
    chain = llm.with_structured_output(Answer)
    if valid:
        assert chain.invoke("Return answer 3").answer == 3
    else:
        with pytest.raises(ValueError):
            chain.invoke("Return answer 3")
    assert captured[0]["model"] == "custom-route"
    assert captured[0]["tools"][0]["function"]["name"] == "Answer"
    assert captured[0].get("tool_choice") is None
    assert "response_format" not in captured[0]
    assert llm.use_responses_api is False
