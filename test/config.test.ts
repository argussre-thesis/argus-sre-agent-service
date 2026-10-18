import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig } from "../src/config.ts";

test("defaults with only an Anthropic key", () => {
  assert.deepEqual(loadConfig({ ANTHROPIC_API_KEY: "k" }), {
    port: 8090,
    opsUrl: "http://127.0.0.1:8081",
    model: { provider: "anthropic", name: "claude-opus-5-5", effort: "high" },
    maxModelCalls: 30,
  });
});

test("openai needs its key and model, and has no effort", () => {
  assert.throws(() => loadConfig({ MODEL_PROVIDER: "openai", OPENAI_API_KEY: "k" }), /OPENAI_MODEL/);
  assert.deepEqual(loadConfig({ MODEL_PROVIDER: "openai", OPENAI_API_KEY: "k", OPENAI_MODEL: "m" }).model, {
    provider: "openai",
    name: "m",
  });
});

test("bad values are rejected", () => {
  const cases: [name: string, value: string, error: RegExp][] = [
    ["ANTHROPIC_API_KEY", "", /Missing required environment variable ANTHROPIC_API_KEY/],
    ["MODEL_PROVIDER", "gemini", /MODEL_PROVIDER must be one of anthropic, openai/],
    ["MODEL_EFFORT", "fast", /MODEL_EFFORT must be one of low, medium, high, xhigh, max/],
    ["MAX_MODEL_CALLS", "2.5", /MAX_MODEL_CALLS must be a positive whole number/],
    ["PORT", "0", /PORT must be a positive whole number/],
    ["OPS_URL", "127.0.0.1:8081", /OPS_URL must start with http/],
  ];
  for (const [name, value, error] of cases) {
    assert.throws(() => loadConfig({ ANTHROPIC_API_KEY: "k", [name]: value }), error, name);
  }
});
