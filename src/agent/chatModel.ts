import { ChatAnthropic } from "@langchain/anthropic";
import { ChatOpenAI } from "@langchain/openai";
import type { ModelConfig } from "../config.ts";

// LangChain's default is 6; 2 is the Anthropic SDK's own default.
const MAX_RETRIES = 2;
// The SDKs' default, made explicit: a step that runs to MAX_TOKENS takes minutes, and a timed-out step is paid for and retried.
const TIMEOUT_MS = 10 * 60_000;
// Thinking counts toward it. LangChain picks 16k for model names it knows, 4k for ones it doesn't.
const MAX_TOKENS = 16_384;

// The only place a provider is imported: `name` is recorded with each conversation.
export function chatModel(m: ModelConfig) {
  const name = `${m.provider}:${m.name}`;
  if (m.provider === "anthropic") {
    const model = new ChatAnthropic({
      model: m.name,
      maxTokens: MAX_TOKENS,
      outputConfig: { effort: m.effort },
      maxRetries: MAX_RETRIES,
      clientOptions: { timeout: TIMEOUT_MS },
    });
    return { name, model };
  }

  const model = new ChatOpenAI({ model: m.name, useResponsesApi: true, maxRetries: MAX_RETRIES, timeout: TIMEOUT_MS });
  return { name, model };
}
