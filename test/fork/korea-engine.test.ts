// Copyright 2026 TradingAgents fork contributors
// SPDX-License-Identifier: Apache-2.0
// Added in this fork of TradingAgents 1.0.0.
/**
 * One question to an engine set up with Korea's keys, end to end and offline: createEngine builds the fork's
 * providers from `publicData` (DART_API_KEY, ECOS_API_KEY, KOSIS_API_KEY and DATA_GO_KR_API_KEY, no
 * SEC_USER_AGENT) over a fetch that answers the sources from fixtures (data/korea-routes.test.ts) and passes
 * the model's requests to a scripted model on 127.0.0.1. The model finds Samsung Electronics by its
 * Korean name with find_instrument, then reads, for the key it was given, the statements, the filings, and the
 * section of the first filing listed; then it answers. Every call succeeds, from OpenDART; no key is in any
 * request the model receives, and each key reaches only its own source.
 */
// The network guard, also when this file is run from elsewhere than the repository's root.
import "./net-guard.js";
import { expect, test } from "bun:test";
import type { Event, ModelRoute } from "../../src/contracts/index.js";
import { createEngine } from "../../src/engine/factory.js";
import { fixtureFetch, TEST_DAY } from "./data/harness.js";
import { DART_KEY, KOREA_KEYS, KOREA_ROUTES, KOREA_SECRETS, withKorea } from "./data/korea-routes.test.js";

/** A streamed chunk of a chat completion, as an OpenAI-compatible server sends it. */
const chunk = (fields: Record<string, unknown>) =>
  `data: ${JSON.stringify({ id: "s", object: "chat.completion.chunk", created: 0, model: "stub", ...fields })}\n\n`;

const USAGE = { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 };

/** A streamed answer calling `name` with `args`. */
function toolCall(step: number, name: string, args: Record<string, unknown>): string {
  const call = {
    index: 0,
    id: `call_${step}`,
    type: "function",
    function: { name, arguments: JSON.stringify(args) },
  };
  return `${chunk({ choices: [{ index: 0, delta: { role: "assistant", tool_calls: [call] }, finish_reason: null }] })}${chunk({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: USAGE })}data: [DONE]\n\n`;
}

/** A streamed answer in words. */
function words(text: string): string {
  return `${chunk({ choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] })}${chunk({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: USAGE })}data: [DONE]\n\n`;
}

type Message = { role: string; content?: unknown };

/** What a tool message says, whether its content is text or parts of text. */
function said(message: Message | undefined): string {
  const content = message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((part) => (part as { text?: string }).text ?? JSON.stringify(part)).join("\n");
  }
  return JSON.stringify(content ?? "");
}

/**
 * The script: what the model does at each step, from the tool results it has read so far (the messages of
 * role tool): find the company by its Korean name, read the key's statements, filings, and the first filing's
 * section, then answer.
 */
function next(messages: readonly Message[]): string {
  const results = messages.filter((message) => message.role === "tool").map(said);
  const key = /XKRX:\d{6}/.exec(results[0] ?? "")?.[0];
  switch (results.length) {
    case 0:
      return toolCall(1, "find_instrument", { query: "삼성전자" });
    case 1:
      return toolCall(2, "statements", {
        symbol: key,
        statement: "income_statement",
        period_type: "annual",
        periods: 1,
      });
    case 2:
      return toolCall(3, "filings", { symbol: key, forms: ["10-K"], limit: 2 });
    case 3: {
      const accession = /\b\d{14}\b/.exec(results[2] ?? "")?.[0];
      return toolCall(4, "filing_section", { symbol: key, accession, section: "business" });
    }
    default:
      return words("Samsung Electronics' statements, filings and business section were read.");
  }
}

test("a question with Korea's keys: find the company by its Korean name, read its statements, filings and a filing's section", async () => {
  // What the model received, whole: each request's address, headers and body.
  const received: string[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const body = await request.text();
      received.push([request.method, request.url, JSON.stringify([...request.headers]), body].join("\n"));
      if (request.method === "GET") {
        return Response.json({
          object: "list",
          data: [{ id: "stub", object: "model", max_model_len: 131_072 }],
        });
      }
      const { messages } = JSON.parse(body) as { messages: Message[] };
      return new Response(next(messages), { headers: { "content-type": "text/event-stream" } });
    },
  });
  // The sources from fixtures; the model's requests to the stub.
  const data = withKorea(fixtureFetch(KOREA_ROUTES));
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const address = input instanceof Request ? input.url : String(input);
    return new URL(address).hostname === "127.0.0.1" ? globalThis.fetch(input, init) : data(input, init);
  }) as typeof globalThis.fetch;
  try {
    const model: ModelRoute = {
      provider: "openai-compatible",
      model: "stub",
      baseURL: `http://127.0.0.1:${server.port}/v1`,
      thinking: "none",
      sampling: { thinking: {}, plain: {} },
    };
    const engine = createEngine({
      model,
      version: "1.0.0",
      fetch,
      publicData: KOREA_KEYS,
      contextWindow: 131_072,
      today: new Date(TEST_DAY),
    });
    const turn = engine.ask("삼성전자의 재무제표와 최근 사업보고서를 읽어 줘.");
    const events: Event[] = [];
    for await (const envelope of turn.events) events.push(envelope.event);
    const outcome = await turn.outcome;
    expect(outcome.status).toBe("completed");

    // Each call the model made, and how it ended.
    const called = events.flatMap((event) => (event.type === "tool.called" ? [event] : []));
    const ended = new Map(
      events.flatMap((event) =>
        event.type === "tool.completed" || event.type === "tool.failed" ? [[event.call, event] as const] : [],
      ),
    );
    expect(called.map((event) => event.name)).toEqual([
      "find_instrument",
      "statements",
      "filings",
      "filing_section",
    ]);
    const ends = called.map((event) => ended.get(event.call));
    expect(ends.map((end) => end?.type)).toEqual(Array(4).fill("tool.completed"));
    expect(ends.map((end) => (end?.type === "tool.completed" ? end.source : undefined))).toEqual([
      "Instrument search",
      "SEC EDGAR / OpenDART",
      "SEC EDGAR / OpenDART",
      "SEC EDGAR / OpenDART",
    ]);
    // The key find_instrument gave is the one each later call read, and the section is the first filing's.
    const args = called.map((event) => event.args as Record<string, unknown>);
    expect(args.slice(1).map((one) => one.symbol)).toEqual(["XKRX:005930", "XKRX:005930", "XKRX:005930"]);
    expect(args[3]?.accession).toBe("20260310000812");

    // The model was asked five times: four calls, then the answer; every source request had its fixture.
    expect(received.filter((request) => request.startsWith("POST"))).toHaveLength(5);
    expect(data.unmatched).toEqual([]);

    // No key, in any spelling, in anything the model received.
    for (const request of received) for (const secret of KOREA_SECRETS) expect(request).not.toContain(secret);
    // Each key reached only its own source: here OpenDART's, in its query.
    for (const { url, headers } of data.requests) {
      const sent = `${url}\n${JSON.stringify([...headers])}`;
      const held = KOREA_SECRETS.filter((secret) => sent.includes(secret));
      expect(held).toEqual(new URL(url).hostname === "opendart.fss.or.kr" ? [DART_KEY] : []);
    }
    expect(data.requests.some((request) => new URL(request.url).hostname === "opendart.fss.or.kr")).toBe(
      true,
    );
  } finally {
    await server.stop(true);
  }
});
