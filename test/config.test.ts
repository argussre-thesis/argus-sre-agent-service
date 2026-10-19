import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig } from "../src/config.ts";

const DATABASE_URL = "postgresql://user:pass@db.example:5432/agent";

test("defaults with only an Anthropic key", () => {
  const defaults = {
    port: 8090,
    opsUrl: "http://127.0.0.1:8081",
    model: { provider: "anthropic", name: "claude-opus-5-5", effort: "high" },
    maxModelCalls: 30,
  };
  assert.deepEqual(loadConfig({ ANTHROPIC_API_KEY: "k", DATABASE_URL }), defaults);
  // `KEY=` lines in a .env file count as unset.
  const empty = { PORT: "", OPS_URL: "", MODEL_PROVIDER: "", ANTHROPIC_MODEL: "", MODEL_EFFORT: "", MAX_MODEL_CALLS: "" };
  assert.deepEqual(loadConfig({ ANTHROPIC_API_KEY: "k", DATABASE_URL, ...empty }), defaults);
});

test("set values are used", () => {
  const env = {
    ANTHROPIC_API_KEY: "k",
    DATABASE_URL,
    PORT: "9000",
    OPS_URL: "https://gateway.internal:8081",
    ANTHROPIC_MODEL: "claude-haiku-5-5",
    MODEL_EFFORT: "low",
    MAX_MODEL_CALLS: "10",
  };
  assert.deepEqual(loadConfig(env), {
    port: 9000,
    opsUrl: "https://gateway.internal:8081",
    model: { provider: "anthropic", name: "claude-haiku-5-5", effort: "low" },
    maxModelCalls: 10,
  });
});

test("openai needs its key and model, and has no effort", () => {
  assert.throws(() => loadConfig({ MODEL_PROVIDER: "openai", OPENAI_API_KEY: "k", DATABASE_URL }), /OPENAI_MODEL/);
  assert.deepEqual(loadConfig({ MODEL_PROVIDER: "openai", OPENAI_API_KEY: "k", OPENAI_MODEL: "m", DATABASE_URL }).model, {
    provider: "openai",
    name: "m",
  });
});

test("bad values are rejected", () => {
  const cases: [name: string, value: string, error: RegExp][] = [
    ["ANTHROPIC_API_KEY", "", /expected string, received undefined\n.*at ANTHROPIC_API_KEY/],
    ["MODEL_PROVIDER", "gemini", /Expected 'anthropic' \| 'openai'\n.*at MODEL_PROVIDER/],
    ["MODEL_EFFORT", "fast", /expected one of "low"\|"medium"\|"high"\|"xhigh"\|"max"\n.*at MODEL_EFFORT/],
    ["MAX_MODEL_CALLS", "2.5", /expected int\b.*\n.*at MAX_MODEL_CALLS/],
    ["PORT", "0", /Too small.*\n.*at PORT/],
    ["OPS_URL", "127.0.0.1:8081", /Invalid URL\n.*at OPS_URL/],
    ["OPS_URL", "ftp://gateway:8081", /Invalid URL\n.*at OPS_URL/],
    ["DATABASE_URL", "", /expected string, received undefined\n.*at DATABASE_URL/],
    ["DATABASE_URL", "https://console.neon.tech/app/projects", /Invalid URL\n.*at DATABASE_URL/],
  ];
  for (const [name, value, error] of cases) {
    assert.throws(() => loadConfig({ ANTHROPIC_API_KEY: "k", DATABASE_URL, [name]: value }), error, name);
  }
});
