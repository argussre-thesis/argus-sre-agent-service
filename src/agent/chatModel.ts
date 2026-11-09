import { ChatAnthropic } from "@langchain/anthropic";
import { ChatOpenAI } from "@langchain/openai";
import type { ModelConfig } from "../config.ts";

const MAX_RETRIES = 2;
const TIMEOUT_MS = 10 * 60_000;
// Thinking counts toward it. LangChain picks 16k for model names it knows, 4k for ones it doesn't.
const MAX_TOKENS = 16_384;

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
    return { name, model, effort: m.effort };
  }

  const model = new ChatOpenAI({
    model: m.name,
    useResponsesApi: true,
    ...(m.effort && { reasoning: { effort: m.effort } }),
    maxRetries: MAX_RETRIES,
    timeout: TIMEOUT_MS,
  });

  const params = model.invocationParams({});
  return { name, model, effort: "reasoning" in params ? (params.reasoning?.effort ?? null) : null };
}
