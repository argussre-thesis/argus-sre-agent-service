import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig } from "../src/config.ts";

const DATABASE_URL = "postgresql://user:pass@db.example:5432/agent";
const BACKEND_AGENT_SERVICE_TOKEN = "t".repeat(32);
const AGENT_GATEWAY_TOKEN = "a".repeat(32);
const BACKEND_URL = "https://api.example";
const required = { ANTHROPIC_API_KEY: "k", DATABASE_URL, BACKEND_AGENT_SERVICE_TOKEN, AGENT_GATEWAY_TOKEN, BACKEND_URL };

test("defaults with only an Anthropic key", () => {
  const defaults = {
    host: "127.0.0.1",
    port: 8090,
    gatewayUrl: "http://127.0.0.1:8081",
    agentGatewayToken: AGENT_GATEWAY_TOKEN,
    models: {
      low: { provider: "anthropic", name: "claude-haiku-5-5", effort: "medium" },
      medium: { provider: "anthropic", name: "claude-sonnet-5-5", effort: "high" },
      high: { provider: "anthropic", name: "claude-opus-5-5", effort: "high" },
    },
    maxModelCalls: 30,
    backendAgentServiceToken: BACKEND_AGENT_SERVICE_TOKEN,
    backendUrl: BACKEND_URL,
  };
  assert.deepEqual(loadConfig(required), defaults);
  // `KEY=` lines in a .env file count as unset.
  const empty = { HOST: "", PORT: "", GATEWAY_URL: "", MODEL_PROVIDER: "", LOW_MODEL: "", HIGH_EFFORT: "", MAX_MODEL_CALLS: "" };
  assert.deepEqual(loadConfig({ ...required, ...empty }), defaults);
});

test("set values are used", () => {
  const env = {
    ...required,
    HOST: "0.0.0.0",
    PORT: "9000",
    GATEWAY_URL: "https://gateway.internal:8081",
    LOW_MODEL: "claude-haiku-4-5",
    LOW_EFFORT: "low",
    MEDIUM_MODEL: "claude-opus-5-5",
    MEDIUM_EFFORT: "medium",
    HIGH_MODEL: "claude-fable-5-1",
    HIGH_EFFORT: "max",
    MAX_MODEL_CALLS: "10",
  };
  assert.deepEqual(loadConfig(env), {
    host: "0.0.0.0",
    port: 9000,
    gatewayUrl: "https://gateway.internal:8081",
    agentGatewayToken: AGENT_GATEWAY_TOKEN,
    models: {
      low: { provider: "anthropic", name: "claude-haiku-4-5", effort: "low" },
      medium: { provider: "anthropic", name: "claude-opus-5-5", effort: "medium" },
      high: { provider: "anthropic", name: "claude-fable-5-1", effort: "max" },
    },
    maxModelCalls: 10,
    backendAgentServiceToken: BACKEND_AGENT_SERVICE_TOKEN,
    backendUrl: BACKEND_URL,
  });
});

test("openai needs its key and model; one model for every level; its effort is optional, with OpenAI's values", () => {
  const openai = { MODEL_PROVIDER: "openai", OPENAI_API_KEY: "k", OPENAI_MODEL: "m", DATABASE_URL, BACKEND_AGENT_SERVICE_TOKEN, AGENT_GATEWAY_TOKEN, BACKEND_URL };
  assert.throws(() => loadConfig({ ...openai, OPENAI_MODEL: "" }), /OPENAI_MODEL/);
  const m = { provider: "openai", name: "m" };
  assert.deepEqual(loadConfig(openai).models, { low: m, medium: m, high: m });
  assert.deepEqual(loadConfig({ ...openai, MODEL_EFFORT: "minimal" }).models.high, { ...m, effort: "minimal" });
  assert.throws(() => loadConfig({ ...openai, MODEL_EFFORT: "fast" }), /at MODEL_EFFORT/);
  // "minimal" is OpenAI's, not Claude's.
  assert.throws(() => loadConfig({ ...required, LOW_EFFORT: "minimal" }), /at LOW_EFFORT/);
});

test("bad values are rejected", () => {
  const cases: [name: string, value: string, error: RegExp][] = [
    ["ANTHROPIC_API_KEY", "", /expected string, received undefined\n.*at ANTHROPIC_API_KEY/],
    ["MODEL_PROVIDER", "gemini", /Expected 'anthropic' \| 'openai'\n.*at MODEL_PROVIDER/],
    ["MEDIUM_EFFORT", "fast", /expected one of "low"\|"medium"\|"high"\|"xhigh"\|"max"\n.*at MEDIUM_EFFORT/],
    ["MAX_MODEL_CALLS", "2.5", /expected int\b.*\n.*at MAX_MODEL_CALLS/],
    ["PORT", "0", /Too small.*\n.*at PORT/],
    ["GATEWAY_URL", "127.0.0.1:8081", /Invalid URL\n.*at GATEWAY_URL/],
    ["GATEWAY_URL", "ftp://gateway:8081", /Invalid URL\n.*at GATEWAY_URL/],
    ["DATABASE_URL", "", /expected string, received undefined\n.*at DATABASE_URL/],
    ["DATABASE_URL", "https://console.neon.tech/app/projects", /Invalid URL\n.*at DATABASE_URL/],
    ["BACKEND_AGENT_SERVICE_TOKEN", "", /expected string, received undefined\n.*at BACKEND_AGENT_SERVICE_TOKEN/],
    ["BACKEND_AGENT_SERVICE_TOKEN", "t".repeat(31), /Too small.*\n.*at BACKEND_AGENT_SERVICE_TOKEN/],
    ["AGENT_GATEWAY_TOKEN", "", /expected string, received undefined\n.*at AGENT_GATEWAY_TOKEN/],
    ["AGENT_GATEWAY_TOKEN", "a".repeat(31), /Too small.*\n.*at AGENT_GATEWAY_TOKEN/],
    ["BACKEND_URL", "", /expected string, received undefined\n.*at BACKEND_URL/],
    ["BACKEND_URL", "staging.api.argussre.com", /Invalid URL\n.*at BACKEND_URL/],
  ];
  for (const [name, value, error] of cases) {
    assert.throws(() => loadConfig({ ...required, [name]: value }), error, name);
  }
});
