"""Live DevPass authentication, tool roundtrip and typed-output check.

Set LLM_GATEWAY_API_KEY and run:
    python scripts/smoke_llmgateway.py --model YOUR_CANONICAL_MODEL_ID
Makes four small API calls; no financial data or external tools are used.
Missing credentials exit with code 2, never a passing validation result.
"""
import argparse
import os

from dotenv import load_dotenv
from langchain_core.messages import HumanMessage, ToolMessage
from langchain_core.tools import tool
from pydantic import BaseModel

from tradingagents.llm_clients import create_llm_client


class Answer(BaseModel):
    answer: int


@tool
def add_numbers(a: int, b: int) -> int:
    """Add two integers locally."""
    return a + b


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model", required=True, help="Model ID enabled for your DevPass account")
    args = parser.parse_args()
    load_dotenv()
    if not os.environ.get("LLM_GATEWAY_API_KEY"):
        print("NOT RUN: LLM_GATEWAY_API_KEY is not configured.")
        return 2
    if "/" in args.model:
        parser.error("DevPass requires a canonical model ID without a provider prefix")
    try:
        llm = create_llm_client(provider="llmgateway", model=args.model).get_llm()
        llm.root_client.models.list()
        print("PASS: authenticated model catalog request")
        prompt = HumanMessage(content="Call add_numbers with a=1 and b=2 exactly once. After its result, reply with the number only.")
        model = llm.bind_tools([add_numbers])
        call = model.invoke([prompt])
        if len(call.tool_calls) != 1 or call.tool_calls[0]["name"] != "add_numbers":
            raise ValueError("Expected one add_numbers tool call")
        tc = call.tool_calls[0]
        value = add_numbers.invoke(tc["args"])
        if value != 3:
            raise ValueError("Incorrect tool arguments")
        reply = model.invoke([prompt, call, ToolMessage(content=str(value), tool_call_id=tc["id"])])
        if reply.tool_calls or reply.content.strip() != "3":
            raise ValueError("Tool result was not consumed correctly")
        print("PASS: tool call and result roundtrip")
        answer = llm.with_structured_output(Answer).invoke("Return answer=3 using the Answer tool.")
        if not isinstance(answer, Answer) or answer.answer != 3:
            raise ValueError("Typed response validation failed")
        print("PASS: structured output parsed and validated")
        return 0
    except Exception as exc:
        # Never print provider exceptions that could include credentials/URLs.
        print(f"FAIL: {type(exc).__name__}; check account access and model support.")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
