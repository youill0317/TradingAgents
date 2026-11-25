// Copyright 2026 TradingAgents fork contributors
// SPDX-License-Identifier: Apache-2.0
// Added in this fork of TradingAgents 1.0.0.
/**
 * What a session's start says about the public-data settings, run from source against a local chat server
 * (no other network): SEC_USER_AGENT unset or without an email is said once, and a good one says nothing.
 */
import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** One -p question with `env` (and no other environment): what the run printed on stderr. */
async function start(env: Record<string, string>): Promise<string> {
  const chunk = (fields: Record<string, unknown>) =>
    `data: ${JSON.stringify({ id: "s", object: "chat.completion.chunk", created: 0, model: "stub", ...fields })}\n\n`;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (request.method === "GET")
        return Response.json({ object: "list", data: [{ id: "stub", object: "model" }] });
      await request.text();
      const usage = { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 };
      return new Response(
        `${chunk({ choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: null }] })}${chunk({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage })}data: [DONE]\n\n`,
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  });
  const home = await mkdtemp(join(tmpdir(), "fork-data-start-"));
  try {
    const run = Bun.spawn(
      [process.execPath, join(import.meta.dir, "../../../src/cli/main.tsx"), "-p", "hi"],
      {
        cwd: home,
        env: {
          PATH: process.env.PATH ?? "",
          HOME: home,
          TRADINGAGENTS_HOME: join(home, "home"),
          TRADINGAGENTS_BASE_URL: `http://127.0.0.1:${server.port}/v1`,
          TRADINGAGENTS_MODEL: "stub",
          TRADINGAGENTS_NO_UPDATE_CHECK: "1",
          ...env,
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [stdout, stderr, code] = await Promise.all([
      new Response(run.stdout).text(),
      new Response(run.stderr).text(),
      run.exited,
    ]);
    expect({ code, stdout }).toEqual({ code: 0, stdout: "ok\n" });
    return stderr;
  } finally {
    await server.stop(true);
    await rm(home, { recursive: true, force: true });
  }
}

describe("a session's start, run from source", () => {
  test("without SEC_USER_AGENT it says what to set, once", async () => {
    const stderr = await start({});
    const notes = stderr.split("\n").filter((line) => line.includes("SEC_USER_AGENT"));
    expect(notes).toHaveLength(1);
    expect(notes[0]).toStartWith("warning: SEC_USER_AGENT is not set, so SEC filings");
    expect(notes[0]).toContain('SEC_USER_AGENT="Your Name you@example.com"');
  }, 60_000);

  test("with one that has no email, it says so", async () => {
    const stderr = await start({ SEC_USER_AGENT: "Jane Doe" });
    expect(stderr).toContain("warning: SEC_USER_AGENT holds no email address");
    expect(stderr).not.toContain("Jane Doe");
  }, 60_000);

  test("with a good one, nothing about it", async () => {
    const stderr = await start({ SEC_USER_AGENT: "Jane Doe jane@example.com" });
    expect(stderr).not.toContain("SEC_USER_AGENT");
    expect(stderr).not.toContain("jane@example.com");
  }, 60_000);
});
