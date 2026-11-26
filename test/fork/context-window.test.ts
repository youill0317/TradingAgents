// Copyright 2026 TradingAgents fork contributors
// SPDX-License-Identifier: Apache-2.0
// Added in this fork of TradingAgents 1.0.0.
/**
 * Why a model's context window must be known (docs/models.md, "An OpenAI-compatible server"): every setup offers
 * the built-in agents and skills, and the app's estimate of the main agent's first request is more than the
 * 32,768 tokens assumed for a server that reports no window, so a question ends before anything is sent. A
 * window the server lists (vLLM's `max_model_len`) or the provider's `contextWindow` setting lets it through.
 * Against a chat server on 127.0.0.1 only.
 */
import { describe, expect, test } from "bun:test";
import type { ModelRoute } from "../../src/contracts/index.js";
import { MODEL } from "../../src/contracts/limits.js";
import { createEngine, resolveContextWindow } from "../../src/engine/factory.js";

const chunk = (fields: Record<string, unknown>) =>
  `data: ${JSON.stringify({ id: "s", object: "chat.completion.chunk", created: 0, model: "stub", ...fields })}\n\n`;

/** One question to a chat server whose model list is `listed`, with `settings` in the provider's block. */
async function ask(listed: Record<string, unknown>, settings: { contextWindow?: number } = {}) {
  const requests: string[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (request.method === "GET") return Response.json({ object: "list", data: [listed] });
      requests.push(await request.text());
      const usage = { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 };
      return new Response(
        `${chunk({ choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: null }] })}${chunk({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage })}data: [DONE]\n\n`,
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  });
  try {
    const model = {
      provider: "openai-compatible",
      model: "stub",
      baseURL: `http://127.0.0.1:${server.port}/v1`,
      thinking: "none",
      sampling: { thinking: {}, plain: {} },
      ...settings,
    } as ModelRoute;
    const context = await resolveContextWindow(model);
    const engine = createEngine({ model, version: "1.0.0", publicData: {}, contextWindow: context.window });
    const turn = engine.ask("Say ok.");
    for await (const _ of turn.events) {
      // The events are not this test's business.
    }
    return { context, outcome: await turn.outcome, requests };
  } finally {
    await server.stop(true);
  }
}

describe("the context window a session needs", () => {
  test("a server that reports no window: 32,768 tokens assumed, and the first question ends unsent", async () => {
    const { context, outcome, requests } = await ask({ id: "stub", object: "model" });
    expect(context.window).toBe(MODEL.fallbackContextWindow);
    expect(context.notice).toBe(
      "The model's context window is unknown, so 32,768 tokens is assumed; set providers.openai-compatible.contextWindow in the config to use more.",
    );
    expect(outcome.status).toBe("failed");
    expect(outcome.error?.kind).toBe("context");
    expect(requests).toEqual([]);
  });

  test("a window the server lists, or the provider's contextWindow setting, lets the question through", async () => {
    const listed = await ask({ id: "stub", object: "model", max_model_len: 65_536 });
    expect(listed.context).toEqual({ window: 65_536 });
    expect(listed.outcome.status).toBe("completed");
    expect(listed.requests).toHaveLength(1);
    const set = await ask({ id: "stub", object: "model" }, { contextWindow: 65_536 });
    expect(set.context).toEqual({ window: 65_536 });
    expect(set.outcome.status).toBe("completed");
    // The request offers the built-in agents and skills.
    expect(set.requests[0]).toContain("run_agent");
    expect(set.requests[0]).toContain("use_skill");
  });
});
