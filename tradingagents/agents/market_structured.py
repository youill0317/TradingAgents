"""Required structured output for the market scan.

``tradingagents.agents.structured`` falls back to free text when a schema
cannot be produced, which suits narrative reports. Market-scan candidates
become inputs to another stage, so they must validate or fail loudly.
"""

from typing import Any, TypeVar

from pydantic import BaseModel

T = TypeVar("T", bound=BaseModel)


class StructuredOutputError(RuntimeError):
    """Raised when a safety-critical structured result cannot be validated."""


def invoke_structured_required(
    structured_llm: Any | None,
    prompt: str,
    schema: type[T],
    agent_name: str,
) -> T:
    """Return a validated structured result, never an unvalidated text fallback.

    This is for outputs that become executable inputs to another stage (for
    example, market-scan ticker candidates).  A prose fallback is useful for a
    narrative report, but must not be allowed to bypass schema and grounding
    checks on actionable fields.
    """
    if structured_llm is None:
        raise StructuredOutputError(
            f"{agent_name}: provider does not support required structured output"
        )
    try:
        # Gateways may not support forced tool_choice. The output schema is
        # still permitted when the analyst is forbidden from using data tools.
        result = structured_llm.invoke(
            prompt + f"\n\nReturn the result using the {schema.__name__} output schema. "
            f"If exposed as a tool, call {schema.__name__} exactly once. "
            "This output tool is allowed; it is not an external data/search tool. "
            "Do not return the result as ordinary prose."
        )
        if result is None:
            raise ValueError("structured output returned no parsed result")
        return schema.model_validate(result)
    except Exception as exc:
        raise StructuredOutputError(
            f"{agent_name}: structured output could not be validated: {exc}"
        ) from exc
