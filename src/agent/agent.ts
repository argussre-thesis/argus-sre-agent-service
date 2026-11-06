import { AIMessage, type BaseMessage } from "langchain";
import { log } from "../log.ts";

type StreamingAgent = {
  stream(input: { messages: BaseMessage[] }, options: { streamMode: "values" }): Promise<AsyncIterable<{ messages: BaseMessage[] }>>;
};

const FINISHED = ["end_turn", "stop", "completed"];
function stopReason(m: AIMessage): string | undefined {
  const meta = m.response_metadata as { stop_reason?: string; finish_reason?: string; status?: string };
  return meta.stop_reason ?? meta.finish_reason ?? meta.status;
}

export function finished(m: AIMessage): boolean {
  const reason = stopReason(m);
  return reason === undefined || FINISHED.includes(reason);
}

// Runs the agent until it answers and returns the answer. `onStep` gets each step's new messages, in order.
// Throws when the run ends any other way: call limit, max_tokens, refusal, API error.
export async function runAgent(
  agent: StreamingAgent,
  messages: BaseMessage[],
  tenantId: string,
  clusters: string[],
  onStep: (added: BaseMessage[]) => Promise<void>,
): Promise<string> {
  let all = messages;
  for await (const state of await agent.stream({ messages }, { streamMode: "values" })) {
    if (state.messages.length === all.length) continue;
    const added = state.messages.slice(all.length);
    all = state.messages;
    for (const m of added) if (AIMessage.isInstance(m)) logStep(m, tenantId, clusters);
    await onStep(added);
  }
  const last = all.at(-1);
  if (!AIMessage.isInstance(last) || !finished(last)) {
    throw new Error(`run ended without a report (stop reason: ${(AIMessage.isInstance(last) && stopReason(last)) || "none"})`);
  }
  return last.text;
}

function logStep(m: AIMessage, tenantId: string, clusters: string[]): void {
  const u = m.usage_metadata;
  log("info", "model step", {
    tenantId,
    clusters,
    stopReason: stopReason(m),
    toolCalls: m.tool_calls?.map(({ name, args }) => ({ name, args })),
    tokens: u && {
      input: u.input_tokens,
      cacheRead: u.input_token_details?.cache_read ?? 0,
      cacheWrite: u.input_token_details?.cache_creation ?? 0,
      output: u.output_tokens,
    },
  });
}
