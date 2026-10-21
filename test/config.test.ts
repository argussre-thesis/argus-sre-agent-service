import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig } from "../src/config.ts";

const DATABASE_URL = "postgresql://user:pass@db.example:5432/agent";
const INTERNAL_API_TOKEN = "t".repeat(32);
const required = { ANTHROPIC_API_KEY: "k", DATABASE_URL, INTERNAL_API_TOKEN };

test("defaults with only an Anthropic key", () => {
  const defaults = {
    port: 8090,
    opsUrl: "http://127.0.0.1:8081",
    model: { provider: "anthropic", name: "claude-opus-5-5", effort: "high" },
    maxModelCalls: 30,
    internalApiToken: INTERNAL_API_TOKEN,
  };
  assert.deepEqual(loadConfig(required), defaults);
  // `KEY=` lines in a .env file count as unset.
  const empty = { PORT: "", OPS_URL: "", MODEL_PROVIDER: "", ANTHROPIC_MODEL: "", MODEL_EFFORT: "", MAX_MODEL_CALLS: "" };
  assert.deepEqual(loadConfig({ ...required, ...empty }), defaults);
});

test("set values are used", () => {
  const env = {
    ...required,
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
    internalApiToken: INTERNAL_API_TOKEN,
  });
});

test("openai needs its key and model; its effort is optional, with OpenAI's values", () => {
  const openai = { MODEL_PROVIDER: "openai", OPENAI_API_KEY: "k", OPENAI_MODEL: "m", DATABASE_URL, INTERNAL_API_TOKEN };
  assert.throws(() => loadConfig({ ...openai, OPENAI_MODEL: "" }), /OPENAI_MODEL/);
  assert.deepEqual(loadConfig(openai).model, { provider: "openai", name: "m" });
  assert.deepEqual(loadConfig({ ...openai, MODEL_EFFORT: "minimal" }).model, { provider: "openai", name: "m", effort: "minimal" });
  assert.throws(() => loadConfig({ ...openai, MODEL_EFFORT: "fast" }), /at MODEL_EFFORT/);
  // "minimal" is OpenAI's, not Claude's.
  assert.throws(() => loadConfig({ ...required, MODEL_EFFORT: "minimal" }), /at MODEL_EFFORT/);
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
    ["INTERNAL_API_TOKEN", "", /expected string, received undefined\n.*at INTERNAL_API_TOKEN/],
    ["INTERNAL_API_TOKEN", "t".repeat(31), /Too small.*\n.*at INTERNAL_API_TOKEN/],
  ];
  for (const [name, value, error] of cases) {
    assert.throws(() => loadConfig({ ...required, [name]: value }), error, name);
  }
});
