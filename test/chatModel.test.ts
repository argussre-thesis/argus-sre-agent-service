import assert from "node:assert/strict";
import { test } from "node:test";
import { ChatAnthropic } from "@langchain/anthropic";
import { ChatOpenAI } from "@langchain/openai";
import { chatModel } from "../src/agent/chatModel.ts";

// The constructors only check that a key is set; nothing here calls a model.
process.env.ANTHROPIC_API_KEY ??= "test";
process.env.OPENAI_API_KEY ??= "test";

test("Claude: effort and token limit in the request, no thinking setting", () => {
  // A name LangChain's table doesn't know, so its default would be 4,096 tokens.
  const { name, model } = chatModel({ provider: "anthropic", name: "claude-haiku-5-5", effort: "low" });
  assert.equal(name, "anthropic:claude-haiku-5-5");
  assert.ok(model instanceof ChatAnthropic);
  const { model: sent, max_tokens, output_config, thinking } = model.invocationParams({});
  assert.deepEqual(
    { sent, max_tokens, output_config, thinking },
    { sent: "claude-haiku-5-5", max_tokens: 16_384, output_config: { effort: "low" }, thinking: undefined },
  );
  assert.equal(model.caller["maxRetries"], 2);
  assert.equal(model.clientOptions.timeout, 600_000);
});

test("OpenAI: nothing but the model name, same retries and timeout", () => {
  const { name, model } = chatModel({ provider: "openai", name: "gpt-5" });
  assert.equal(name, "openai:gpt-5");
  assert.ok(model instanceof ChatOpenAI);
  // As sent: the unset options are undefined keys, which JSON drops.
  // The Responses API's shape (Chat Completions has no "text"); nothing else, so OpenAI runs on its defaults.
  assert.deepEqual(JSON.parse(JSON.stringify(model.invocationParams({}))), { model: "gpt-5", stream: false, text: {} });
  assert.equal(model.caller["maxRetries"], 2);
  assert.equal(model.timeout, 600_000);
});
