import { AIMessage, type BaseMessage } from "langchain";

export const usage = (m: BaseMessage, model: string, effort: string | null) => {
  const u = AIMessage.isInstance(m) ? m.usage_metadata : undefined;
  if (!u) return {};
  const cacheRead = u.input_token_details?.cache_read ?? 0;
  const cacheWrite = u.input_token_details?.cache_creation ?? 0;
  return {
    model,
    effort,
    uncachedInputTokens: u.input_tokens - cacheRead - cacheWrite,
    cacheWriteTokens: cacheWrite,
    cacheReadTokens: cacheRead,
    outputTokens: u.output_tokens,
  };
};
