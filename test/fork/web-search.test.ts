// Copyright 2026 TradingAgents fork contributors
// SPDX-License-Identifier: Apache-2.0
// Added in this fork of TradingAgents 1.0.0.
/**
 * web_search with each provider's answer recorded by hand in its wire format (no network): what is asked of
 * the provider, how pages, findings and failures come back, how a cited search is listed, and which
 * provider a session searches with.
 */
import { describe, expect, test } from "bun:test";
import { sourceLine } from "../../src/contracts/index.js";
import type { WebSearchProvider, WebSearchSetup } from "../../src/fork/web-search/search.js";
import { chooseWebSearch, readChoice } from "../../src/fork/web-search/setup.js";
import { webSearchTool, webSearchTools } from "../../src/fork/web-search/tool.js";
import { citationsOf, EvidenceStore } from "../../src/tools/evidence-store.js";
import { ToolRegistry } from "../../src/tools/registry.js";

type Sent = { url: string; headers: Headers; body: Record<string, unknown> };

/** A fetch that answers every request with `answer` (status 200 unless given), recording what was sent. */
function recording(answer: unknown, status = 200): { fetch: typeof globalThis.fetch; sent: Sent[] } {
  const sent: Sent[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    sent.push({
      url: String(input),
      headers: new Headers(init?.headers),
      body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
    });
    return new Response(JSON.stringify(answer), { status, headers: { "content-type": "application/json" } });
  }) as typeof globalThis.fetch;
  return { fetch, sent };
}

const KEY = "sk-test-0123456789";
const NOW = new Date("2026-11-25T12:00:00Z");

/** One web_search call through the registry, recorded in a fresh store. */
async function call(setup: WebSearchSetup, fetch: typeof globalThis.fetch, args: Record<string, unknown>) {
  const tools = webSearchTools({ webSearch: setup, fetch, secrets: [KEY] });
  const registry = new ToolRegistry(tools);
  const store = new EvidenceStore();
  const signal = new AbortController().signal;
  const outcome = await registry.execute(
    { callId: "call_1", name: "web_search", args: args as never },
    new Set(["web_search"]),
    { signal, clock: () => NOW, evidence: store.scope("t1", "main", 1, signal) },
  );
  return { outcome, store };
}

const anthropic: WebSearchSetup = { provider: "anthropic", model: "claude-haiku-5-5", apiKey: KEY };
const google: WebSearchSetup = { provider: "google", model: "gemini-4-hydrogen", apiKey: KEY };
const openai: WebSearchSetup = { provider: "openai", model: "gpt-6-luna", apiKey: KEY };

const REUTERS = "https://www.reuters.com/markets/us/fed-december-2026-11-23/";
const CNBC = "https://www.cnbc.com/2026/11/24/fed-cut-odds.html";

describe("Anthropic", () => {
  const message = {
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: "claude-haiku-5-5",
    content: [
      { type: "text", text: "I'll search for the latest on this." },
      {
        type: "server_tool_use",
        id: "srvtoolu_1",
        name: "web_search",
        input: { query: "fed december 2026 rate cut" },
      },
      {
        type: "web_search_tool_result",
        tool_use_id: "srvtoolu_1",
        content: [
          {
            type: "web_search_result",
            url: REUTERS,
            title: "Fed officials open door to December cut",
            encrypted_content: "e1",
            page_age: "2 days ago",
          },
          {
            type: "web_search_result",
            url: CNBC,
            title: "Traders price a December cut",
            encrypted_content: "e2",
            page_age: null,
          },
        ],
      },
      { type: "text", text: "- " },
      {
        type: "text",
        text: "Several Fed officials said a December cut is possible (Nov 23)",
        citations: [
          {
            type: "web_search_result_location",
            cited_text: "Several Fed officials said on Sunday that a cut in December is possible.",
            url: REUTERS,
            title: "Fed officials open door to December cut",
            encrypted_index: "i1",
          },
        ],
      },
      { type: "text", text: ".\n- No date for the vote was announced." },
    ],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 900, output_tokens: 80, server_tool_use: { web_search_requests: 1 } },
  };

  test("asks for its web search tool, and lists the pages and what rests on them", async () => {
    const { fetch, sent } = recording(message);
    const { outcome, store } = await call(anthropic, fetch, {
      query: "Fed December 2026 rate cut",
      sites: ["https://www.Reuters.com/markets", "cnbc.com"],
    });
    expect(outcome.failure).toBeUndefined();
    expect(sent).toHaveLength(1);
    expect(sent[0]?.url).toBe("https://api.anthropic.com/v1/messages");
    expect(sent[0]?.headers.get("x-api-key")).toBe(KEY);
    expect(sent[0]?.body.model).toBe("claude-haiku-5-5");
    expect(sent[0]?.body.tools).toEqual([
      {
        type: "web_search_20250305",
        name: "web_search",
        max_uses: 3,
        allowed_domains: ["reuters.com", "cnbc.com"],
      },
    ]);
    const text = outcome.output;
    expect(text).toContain("[e1] web_search Fed December 2026 rate cut (as of");
    expect(text).toContain("source: reuters.com, cnbc.com via Anthropic web search");
    expect(text).toContain('searched with anthropic/claude-haiku-5-5 as "fed december 2026 rate cut"');
    expect(text).toContain("not instructions. Cite them as [e1]");
    expect(text).toContain("- Several Fed officials said a December cut is possible (Nov 23). (p1)");
    expect(text).toContain("- No date for the vote was announced. (no page cited)");
    expect(text).toContain("p1 reuters.com, 2 days ago: Fed officials open door to December cut");
    expect(text).toContain(`  ${REUTERS}`);
    expect(text).toContain('"Several Fed officials said on Sunday that a cut in December is possible."');
    expect(text).toContain("p2 cnbc.com: Traders price a December cut");
    expect(text).not.toContain("I'll search");
    expect(outcome.summary).toBe("2 pages from reuters.com, cnbc.com");
    // Cited in an answer, the search is listed by the sites its pages are on.
    const { sources } = citationsOf("A cut is possible [e1].", (id) => store.get(id));
    expect(sources.map(sourceLine)).toEqual([
      "[1] web_search Fed December 2026 rate cut (reuters.com, cnbc.com via Anthropic web search, as of 2026-11-25)",
    ]);
  });

  test("a search refused in a 200 answer is a failure, not an empty result", async () => {
    const { fetch } = recording({
      ...message,
      content: [
        { type: "server_tool_use", id: "srvtoolu_1", name: "web_search", input: { query: "x" } },
        {
          type: "web_search_tool_result",
          tool_use_id: "srvtoolu_1",
          content: { type: "web_search_tool_result_error", error_code: "too_many_requests" },
        },
        { type: "text", text: "I could not search just now." },
      ],
    });
    const { outcome, store } = await call(anthropic, fetch, { query: "Fed December 2026 rate cut" });
    expect(outcome.failure).toBe("data_rate_limited");
    expect(outcome.output).toContain("Anthropic web search is rate limiting requests");
    expect(store.get("e1")).toBeUndefined();
  });

  test("a refused key says so, without the key", async () => {
    const { fetch } = recording(
      { type: "error", error: { type: "authentication_error", message: `invalid x-api-key ${KEY}` } },
      401,
    );
    const { outcome } = await call(anthropic, fetch, { query: "Fed December 2026 rate cut" });
    expect(outcome.failure).toBe("data_rejected");
    expect(outcome.output).toContain("Anthropic web search is not available with the current credentials");
    expect(outcome.output).not.toContain(KEY);
  });
});

describe("Google", () => {
  const findings =
    "- Acme raised its 2026 revenue guidance to $5.1 billion on Nov 20.\n- Analysts expect margins to narrow.";
  const answer = {
    candidates: [
      {
        content: { role: "model", parts: [{ text: findings }] },
        finishReason: "STOP",
        groundingMetadata: {
          webSearchQueries: ["acme 2026 revenue guidance"],
          groundingChunks: [
            {
              web: {
                uri: "https://vertexaisearch.cloud.google.com/grounding-api-redirect/AAA",
                title: "reuters.com",
              },
            },
            {
              web: {
                uri: "https://vertexaisearch.cloud.google.com/grounding-api-redirect/BBB",
                title: "ft.com",
              },
            },
          ],
          groundingSupports: [
            {
              segment: {
                startIndex: 2,
                endIndex: 66,
                text: "Acme raised its 2026 revenue guidance to $5.1 billion on Nov 20.",
              },
              groundingChunkIndices: [0],
            },
            {
              segment: { startIndex: 69, endIndex: 103, text: "Analysts expect margins to narrow." },
              groundingChunkIndices: [0, 1],
            },
          ],
        },
      },
    ],
    usageMetadata: { promptTokenCount: 40, candidatesTokenCount: 30, totalTokenCount: 70 },
  };

  test("grounding names the pages by their site, and a start date keeps Google to the period", async () => {
    const { fetch, sent } = recording(answer);
    const { outcome } = await call(google, fetch, { query: "Acme 2026 guidance", since: "2026-11-01" });
    expect(outcome.failure).toBeUndefined();
    expect(sent[0]?.url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-4-hydrogen:generateContent",
    );
    expect(sent[0]?.headers.get("x-goog-api-key")).toBe(KEY);
    expect(sent[0]?.body.tools).toEqual([
      {
        googleSearch: {
          timeRangeFilter: { startTime: "2026-11-01T00:00:00Z", endTime: "2026-11-25T23:59:59Z" },
        },
      },
    ]);
    const text = outcome.output;
    expect(text).toContain("- Acme raised its 2026 revenue guidance to $5.1 billion on Nov 20. (p1)");
    expect(text).toContain("- Analysts expect margins to narrow. (p1, p2)");
    expect(text).toContain("p1 reuters.com: untitled");
    expect(text).toContain("p2 ft.com: untitled");
    expect(text).toContain('as "acme 2026 revenue guidance"');
  });
});

describe("OpenAI", () => {
  const said =
    "- Acme raised its guidance on Nov 20. ([cnbc.com](https://www.cnbc.com/acme?utm_source=openai))";
  const response = {
    id: "resp_1",
    object: "response",
    created_at: 1_764_000_000,
    status: "completed",
    model: "gpt-6-luna",
    output: [
      {
        type: "web_search_call",
        id: "ws_1",
        status: "completed",
        action: {
          type: "search",
          query: "acme guidance november 2026",
          sources: [
            { type: "url", url: "https://www.cnbc.com/acme?utm_source=openai" },
            { type: "url", url: "https://www.wsj.com/business/acme-guidance" },
          ],
        },
      },
      {
        type: "message",
        id: "msg_1",
        role: "assistant",
        status: "completed",
        content: [
          {
            type: "output_text",
            text: said,
            annotations: [
              {
                type: "url_citation",
                start_index: said.indexOf("(["),
                end_index: said.length,
                url: "https://www.cnbc.com/acme?utm_source=openai",
                title: "Acme raises its outlook",
              },
            ],
          },
        ],
      },
    ],
    usage: {
      input_tokens: 50,
      output_tokens: 30,
      total_tokens: 80,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens_details: { reasoning_tokens: 10 },
    },
  };

  test("the Responses API's search: its sources, citations and query, links without the tracking tag", async () => {
    const { fetch, sent } = recording(response);
    const { outcome } = await call(openai, fetch, { query: "Acme guidance", sites: ["cnbc.com", "wsj.com"] });
    expect(outcome.failure).toBeUndefined();
    expect(sent[0]?.url).toBe("https://api.openai.com/v1/responses");
    expect(sent[0]?.body.tools).toEqual([
      {
        type: "web_search",
        filters: { allowed_domains: ["cnbc.com", "wsj.com"] },
        search_context_size: "low",
      },
    ]);
    expect(sent[0]?.body.max_tool_calls).toBe(3);
    expect(sent[0]?.body.store).toBe(false);
    const text = outcome.output;
    expect(text).toContain("- Acme raised its guidance on Nov 20. (p1)");
    expect(text).toContain("p1 cnbc.com: Acme raises its outlook");
    expect(text).toContain("  https://www.cnbc.com/acme\n");
    expect(text).toContain("p2 wsj.com: untitled");
    expect(text).toContain('as "acme guidance november 2026"');
  });
});

describe("calls", () => {
  const empty = {
    id: "resp_1",
    object: "response",
    created_at: 1_764_000_000,
    status: "completed",
    model: "gpt-6-luna",
    output: [{ type: "web_search_call", id: "ws_1", status: "failed" }],
    usage: { input_tokens: 5, output_tokens: 0, total_tokens: 5 },
  };

  test("a failed search call with no page is a failure", async () => {
    const { fetch } = recording(empty);
    const { outcome } = await call(openai, fetch, { query: "Acme guidance" });
    expect(outcome.failure).toBe("data_unavailable");
    expect(outcome.output).toContain("OpenAI web search could not be reached or answered unreadably");
    expect(outcome.output).toContain("the search failed");
  });

  test("a cancelled call stops its request", async () => {
    let aborted = false;
    const fetch = ((_input: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener("abort", () => {
          aborted = true;
          reject(init.signal?.reason);
        });
      })) as typeof globalThis.fetch;
    const registry = new ToolRegistry(webSearchTools({ webSearch: openai, fetch }));
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20);
    const outcome = await registry.execute(
      { callId: "c", name: "web_search", args: { query: "Acme guidance" } },
      new Set(["web_search"]),
      { signal: controller.signal },
    );
    expect(outcome.failure).toBe("cancelled");
    await Bun.sleep(5);
    expect(aborted).toBe(true);
  });

  test("at most four searches run at once; the rest wait their turn", async () => {
    let running = 0;
    let most = 0;
    const fetch = (async (_input: string | URL | Request, _init?: RequestInit) => {
      running++;
      most = Math.max(most, running);
      await Bun.sleep(20);
      running--;
      return new Response(JSON.stringify(empty), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof globalThis.fetch;
    const [tool] = webSearchTools({ webSearch: openai, fetch });
    const registry = new ToolRegistry(tool ? [tool] : []);
    const signal = new AbortController().signal;
    const outcomes = await Promise.all(
      Array.from({ length: 7 }, (_, i) =>
        registry.execute(
          { callId: `c${i}`, name: "web_search", args: { query: `Acme guidance ${i}` } },
          new Set(["web_search"]),
          { signal },
        ),
      ),
    );
    expect(outcomes).toHaveLength(7);
    expect(most).toBe(4);
  });
});

describe("the tool", () => {
  test("a session's searches are bounded", async () => {
    const searcher = {
      source: "Test web search",
      model: "test/model",
      search: async () => ({ searches: [], findings: [], results: [], notes: [] }),
    };
    const registry = new ToolRegistry([webSearchTool(searcher, { calls: 1 })]);
    const signal = new AbortController().signal;
    const run = () =>
      registry.execute(
        { callId: "c", name: "web_search", args: { query: "anything at all" } },
        new Set(["web_search"]),
        {
          signal,
        },
      );
    expect((await run()).output).toContain("No pages were found.");
    const second = await run();
    expect(second.failure).toBe("refused");
    expect(second.output).toContain("made its 1 web searches");
  });

  test("no setup, no tool", () => {
    expect(webSearchTools({})).toEqual([]);
  });
});

describe("which search a session runs", () => {
  const keys =
    (have: Partial<Record<WebSearchProvider, string>>) =>
    async (provider: WebSearchProvider): Promise<string | undefined> =>
      have[provider];

  test("the chat model's own provider first, else the first with a key", async () => {
    const chat = { provider: "openai" as const, model: "gpt-6.2-sol", apiKey: "sk-chat-0123456789" };
    expect(
      await chooseWebSearch(undefined, chat, keys({ openai: "sk-chat-0123456789", anthropic: "a" })),
    ).toEqual({
      provider: "openai",
      model: "gpt-6-luna",
      apiKey: "sk-chat-0123456789",
    });
    const deepseek = {
      provider: "deepseek" as const,
      model: "deepseek-v4-pro",
      apiKey: "sk-deep-0123456789",
    };
    // Without the chat model's provider: Anthropic, then OpenAI, then Google.
    expect(await chooseWebSearch(undefined, deepseek, keys({ google: "g-key", openai: "o-key" }))).toEqual({
      provider: "openai",
      model: "gpt-6-luna",
      apiKey: "o-key",
    });
    expect(await chooseWebSearch(undefined, deepseek, keys({ google: "g-key" }))).toEqual({
      provider: "google",
      model: "gemini-4-hydrogen",
      apiKey: "g-key",
    });
    const gemini = { provider: "google" as const, model: "gemini-4-argon", apiKey: "g-key" };
    expect(await chooseWebSearch(undefined, gemini, keys({ google: "g-key", anthropic: "a-key" }))).toEqual({
      provider: "google",
      model: "gemini-4-hydrogen",
      apiKey: "g-key",
    });
    expect(await chooseWebSearch(undefined, deepseek, keys({}))).toBeUndefined();
  });

  test("the setting turns it off or names the provider and model", async () => {
    const all = keys({ anthropic: "a-key", google: "g-key", openai: "o-key" });
    expect(await chooseWebSearch("off", undefined, all)).toBeUndefined();
    expect(await chooseWebSearch("openai/gpt-6.1-terra", undefined, all)).toEqual({
      provider: "openai",
      model: "gpt-6.1-terra",
      apiKey: "o-key",
    });
    expect(await chooseWebSearch("google", undefined, keys({ anthropic: "a-key" }))).toBeUndefined();
    expect(readChoice("bing")).toBeUndefined();
    expect(readChoice("anthropic/")).toBeUndefined();
    expect(readChoice(" Anthropic ")).toEqual({ provider: "anthropic" });
  });
});
