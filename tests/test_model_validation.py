import unittest
import warnings

import pytest

from tradingagents.llm_clients.base_client import BaseLLMClient
from tradingagents.llm_clients.model_catalog import get_known_models
from tradingagents.llm_clients.validators import validate_model


class DummyLLMClient(BaseLLMClient):
    def __init__(self, provider: str, model: str):
        self.provider = provider
        super().__init__(model)

    def get_llm(self):
        self.warn_if_unknown_model()
        return object()

    def validate_model(self) -> bool:
        return validate_model(self.provider, self.model)


@pytest.mark.unit
class ModelValidationTests(unittest.TestCase):
    def test_cli_catalog_models_are_all_validator_approved(self):
        for provider, models in get_known_models().items():
            if provider in ("ollama", "openrouter"):
                continue

            for model in models:
                with self.subTest(provider=provider, model=model):
                    self.assertTrue(validate_model(provider, model))

    def test_unknown_model_emits_warning_for_strict_provider(self):
        client = DummyLLMClient("openai", "not-a-real-openai-model")

        with warnings.catch_warnings(record=True) as caught:
            warnings.simplefilter("always")
            client.get_llm()

        self.assertEqual(len(caught), 1)
        self.assertIn("not-a-real-openai-model", str(caught[0].message))
        self.assertIn("openai", str(caught[0].message))

    def test_llmgateway_offers_defaults_and_still_accepts_any_model(self):
        """DevPass users get a shortlist; the gateway's other models still work."""
        from tradingagents.llm_clients.model_catalog import get_model_options

        for mode in ("quick", "deep"):
            values = [value for _, value in get_model_options("llmgateway", mode)]
            with self.subTest(mode=mode):
                self.assertIn("gpt-5.6-luna", values)
                self.assertNotIn("claude-opus-5", values)
                # DevPass rejects a vendor-prefixed ID with 403, so the
                # shortlist must stay bare.
                self.assertTrue(all("/" not in v for v in values), values)
                # Custom stays last so it doesn't push the defaults off-screen.
                self.assertEqual(values[-1], "custom")

        # A shortlist, not a whitelist: anything the account can route to works.
        self.assertTrue(validate_model("llmgateway", "some-other-model"))
        with warnings.catch_warnings(record=True) as caught:
            warnings.simplefilter("always")
            DummyLLMClient("llmgateway", "some-other-model").get_llm()
        self.assertEqual(caught, [])

    def test_openrouter_and_ollama_accept_custom_models_without_warning(self):
        for provider in ("openrouter", "ollama"):
            client = DummyLLMClient(provider, "custom-model-name")

            with self.subTest(provider=provider):
                with warnings.catch_warnings(record=True) as caught:
                    warnings.simplefilter("always")
                    client.get_llm()

                self.assertEqual(caught, [])
