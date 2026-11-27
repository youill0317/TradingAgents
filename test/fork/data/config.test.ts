// Copyright 2026 TradingAgents fork contributors
// SPDX-License-Identifier: Apache-2.0
// Added in this fork of TradingAgents 1.0.0.
/** The public-data settings: the environment first, then credentials.json's "data"; the start's notes; the cache's place. */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { cacheDirOf, PUBLIC_DATA_VARS, publicDataConfig, secretsOf } from "../../../src/fork/data/config.js";
import { redact } from "../../../src/fork/data/redact.js";

let home: string;
let paths: { home: string; credentials: string };

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "fork-config-"));
  paths = { home, credentials: join(home, "credentials.json") };
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

async function credentials(json: unknown) {
  await writeFile(paths.credentials, typeof json === "string" ? json : JSON.stringify(json));
  await chmod(paths.credentials, 0o600);
}

const UA = "Jane Doe jane@example.com";

describe("where each setting is read from", () => {
  test("the environment, trimmed; every variable", async () => {
    const env = Object.fromEntries(
      Object.values(PUBLIC_DATA_VARS).map((name) => [name, ` ${name.toLowerCase()}-value-0123 `]),
    );
    const { config } = await publicDataConfig({ ...env, SEC_USER_AGENT: ` ${UA} ` }, paths);
    expect(config).toEqual({
      secUserAgent: UA,
      fredKey: "fred_api_key-value-0123",
      dartKey: "dart_api_key-value-0123",
      ecosKey: "ecos_api_key-value-0123",
      kosisKey: "kosis_api_key-value-0123",
      dataGoKrKey: "data_go_kr_api_key-value-0123",
      cacheDir: join(homedir(), ".cache", "tradingagents", "fork-data"),
    });
  });

  test("credentials.json's data object when the environment has none; the environment first", async () => {
    await credentials({
      openai: "sk-unrelated-0123456789",
      data: { FRED_API_KEY: "stored-fred-0123", SEC_USER_AGENT: UA, DART_API_KEY: "stored-dart" },
    });
    const { config, notes } = await publicDataConfig(
      { DART_API_KEY: "env-dart-0123", FRED_API_KEY: "  " },
      paths,
    );
    expect(config.fredKey).toBe("stored-fred-0123");
    expect(config.dartKey).toBe("env-dart-0123");
    expect(config.secUserAgent).toBe(UA);
    expect(notes).toEqual([]);
  });

  test("no credentials file, or one that is not the user's own, adds nothing and says nothing here", async () => {
    expect((await publicDataConfig({ SEC_USER_AGENT: UA }, paths)).notes).toEqual([]);
    await credentials({ data: { FRED_API_KEY: "stored-fred-0123" } });
    await chmod(paths.credentials, 0o644);
    const { config, notes } = await publicDataConfig({ SEC_USER_AGENT: UA }, paths);
    expect(config.fredKey).toBeUndefined();
    expect(notes).toEqual([]);
  });

  test("a data object that cannot be used is said, naming the field and never the value", async () => {
    await credentials({
      data: {
        FRED_API_KEY: 12345,
        KOSIS_API_KEY: "multi\nline",
        FRED_KEY: "typo-value-0123",
        SEC_USER_AGENT: UA,
      },
    });
    const { config, notes } = await publicDataConfig({}, paths);
    expect(config.fredKey).toBeUndefined();
    expect(config.kosisKey).toBeUndefined();
    expect(notes).toEqual([
      expect.stringContaining(
        `${paths.credentials}: data.FRED_KEY is not a setting this app reads (it reads SEC_USER_AGENT, FRED_API_KEY,`,
      ),
      `${paths.credentials}: data.FRED_API_KEY is not text, so it is not used`,
      `${paths.credentials}: data.KOSIS_API_KEY spans more than one line, so it is not used`,
    ]);
    expect(notes.join("\n")).not.toContain("typo-value-0123");
    await credentials({ data: ["not", "an", "object"] });
    expect((await publicDataConfig({ SEC_USER_AGENT: UA }, paths)).notes).toEqual([
      `${paths.credentials}: "data" is not an object, so the data keys in it are not used`,
    ]);
    await credentials("not json at all");
    expect((await publicDataConfig({ SEC_USER_AGENT: UA }, paths)).notes).toEqual([]);
  });
});

describe("SEC_USER_AGENT's notes", () => {
  test("unset: what it is for, how to set it, and that it is SEC's rule, not a secret", async () => {
    const { config, notes } = await publicDataConfig({}, paths);
    expect(config.secUserAgent).toBeUndefined();
    expect(notes).toHaveLength(1);
    const [note] = notes as [string];
    for (const words of [
      "SEC_USER_AGENT is not set, so nothing is read from SEC EDGAR",
      "filings, financial statements, insider trades, sector screens",
      'SEC_USER_AGENT="Your Name you@example.com"',
      "SEC's fair-access rule",
      "it is not a secret",
    ]) {
      expect(note).toContain(words);
    }
  });

  test("no email: kept, and said", async () => {
    const { config, notes } = await publicDataConfig({ SEC_USER_AGENT: "Jane Doe" }, paths);
    expect(config.secUserAgent).toBe("Jane Doe");
    expect(notes).toEqual([
      'SEC_USER_AGENT holds no email address: SEC\'s fair-access rule asks for a name and an email, such as "Your Name you@example.com", and SEC may refuse requests that do not give one.',
    ]);
    expect(notes[0]).not.toContain("Jane");
  });

  test("characters a header cannot carry: not used, and said as that, not as unset", async () => {
    const { config, notes } = await publicDataConfig({ SEC_USER_AGENT: "홍길동 hong@example.com" }, paths);
    expect(config.secUserAgent).toBeUndefined();
    expect(notes).toEqual([
      "SEC_USER_AGENT in the environment holds characters other than plain ASCII letters, digits and punctuation, which a User-Agent cannot carry, so it is not used",
      'SEC_USER_AGENT has no value that can be used, so nothing is read from SEC EDGAR: write it as your name and email, such as SEC_USER_AGENT="Your Name you@example.com".',
    ]);
    expect(notes.join("\n")).not.toContain("hong@example.com");
  });

  test("on more than one line: not used, and said as that, not as unset", async () => {
    const { config, notes } = await publicDataConfig({ SEC_USER_AGENT: "Jane Doe\njane@example.com" }, paths);
    expect(config.secUserAgent).toBeUndefined();
    expect(notes[0]).toBe("SEC_USER_AGENT in the environment spans more than one line, so it is not used");
    expect(notes[1]).toStartWith("SEC_USER_AGENT has no value that can be used");
    expect(notes.join("\n")).not.toContain("is not set");
    expect(notes.join("\n")).not.toContain("jane@example.com");
  });

  test("an environment value that cannot be used gives way to credentials.json's, and says so", async () => {
    await credentials({ data: { SEC_USER_AGENT: UA, FRED_API_KEY: "stored-fred-0123" } });
    const { config, notes } = await publicDataConfig(
      { SEC_USER_AGENT: "Jöhn Doe john@example.com", FRED_API_KEY: "two\nlines" },
      paths,
    );
    expect(config.secUserAgent).toBe(UA);
    expect(config.fredKey).toBe("stored-fred-0123");
    expect(notes).toEqual([
      `SEC_USER_AGENT in the environment holds characters other than plain ASCII letters, digits and punctuation, which a User-Agent cannot carry, so it is not used; the one under "data" in ${paths.credentials} is used instead`,
      `FRED_API_KEY in the environment spans more than one line, so it is not used; the one under "data" in ${paths.credentials} is used instead`,
    ]);
    expect(notes.join("\n")).not.toContain("john@example.com");
    expect(notes.join("\n")).not.toContain("stored-fred-0123");
    // Stored in characters a header cannot carry, with nothing else set: said for the file, then that SEC is not read.
    await credentials({ data: { SEC_USER_AGENT: "Jöhn Doe john@example.com" } });
    const stored = await publicDataConfig({}, paths);
    expect(stored.config.secUserAgent).toBeUndefined();
    expect(stored.notes).toEqual([
      `${paths.credentials}: data.SEC_USER_AGENT holds characters other than plain ASCII letters, digits and punctuation, which a User-Agent cannot carry, so it is not used`,
      expect.stringContaining("SEC_USER_AGENT has no value that can be used"),
    ]);
  });

  test("a good one says nothing", async () => {
    for (const agent of [
      UA,
      "Sample Company Name AdminContact@sample-company.com",
      "A B (a.b+sec@example.co.uk)",
    ]) {
      expect((await publicDataConfig({ SEC_USER_AGENT: agent }, paths)).notes).toEqual([]);
    }
  });
});

describe("where the cache is", () => {
  test("<home>/cache/fork-data when TRADINGAGENTS_HOME names the home", () => {
    expect(cacheDirOf({ TRADINGAGENTS_HOME: "/data/ta", XDG_CACHE_HOME: "/xdg" }, { home: "/data/ta" })).toBe(
      "/data/ta/cache/fork-data",
    );
  });

  test("under XDG_CACHE_HOME when it is absolute, else ~/.cache", () => {
    expect(cacheDirOf({ XDG_CACHE_HOME: "/xdg" }, { home: "/x" })).toBe("/xdg/tradingagents/fork-data");
    expect(cacheDirOf({ XDG_CACHE_HOME: "relative" }, { home: "/x" })).toBe(
      join(homedir(), ".cache", "tradingagents", "fork-data"),
    );
    expect(cacheDirOf({}, { home: "/x" })).toBe(join(homedir(), ".cache", "tradingagents", "fork-data"));
  });
});

test("the secrets to keep out of what is said: every key and SEC's User-Agent, not the cache's place", () => {
  expect(
    secretsOf({
      secUserAgent: UA,
      fredKey: "f-0123",
      cacheDir: "/tmp/c",
    }).sort(),
  ).toEqual(["f-0123", UA].sort());
});

test("data.go.kr's key in either spelling it is handed out in: both are secrets, and neither is said", () => {
  // Invented, in data.go.kr's form: its "Decoding" spelling, and the same key percent-encoded ("Encoding").
  const decoded = "Fk3a9Q+Zr7Lw2/Xp5Tn8Vb1=Hc6Jd4Mg0Ks+Ye3Ru9Wq/Ai2Ov7Sl5Nf8Bh1Gx4==";
  const encoded = encodeURIComponent(decoded);
  expect(secretsOf({ dataGoKrKey: encoded })).toEqual([encoded, decoded]);
  expect(secretsOf({ dataGoKrKey: decoded })).toEqual([decoded]);
  // A value whose escapes cannot be decoded is listed as it is.
  expect(secretsOf({ dataGoKrKey: "abc%E0%A4%A" })).toEqual(["abc%E0%A4%A"]);
  for (const configured of [encoded, decoded]) {
    const said = `asked ?serviceKey=${encoded}; the answer echoed ${decoded}`;
    const scrubbed = redact(said, secretsOf({ dataGoKrKey: configured }));
    expect(scrubbed).not.toContain(decoded);
    expect(scrubbed).not.toContain(encoded);
  }
});
