// Continues a stored investigation with one more question, as step 8's chat will: its stored system prompt and messages,
// the same model and tools, plus the question. Saves nothing. Needs the gateway. Costs tokens.
// npm run continue -- <investigation id> "<question>" [--edit-prompt]
import { ChatAnthropic } from "@langchain/anthropic";
import { mapStoredMessagesToChatMessages, type StoredMessage } from "@langchain/core/messages";
import { AIMessage, HumanMessage, ToolMessage } from "langchain";
import { runWithGateway } from "../src/agent/sreAgent.ts";
import { chatModel } from "../src/agent/chatModel.ts";
import { prisma } from "../src/app/lib/prisma.ts";
import { loadConfig } from "../src/config.ts";

const [id, question, flag] = process.argv.slice(2);
if (!id || !question) throw new Error('usage: npm run continue -- <investigation id> "<question>" [--edit-prompt]');

const config = loadConfig();
const inv = await prisma.investigation.findUniqueOrThrow({ where: { id }, include: { messages: { orderBy: { seq: "asc" } } } });
const { name, model } = chatModel(config.model);
if (name !== inv.model) throw new Error(`the investigation ran on ${inv.model}, the config says ${name}`);
if (!(model instanceof ChatAnthropic)) throw new Error("the thinking check is Claude's");

// Claude checks that each thinking block comes back in the conversation that produced it (system prompt, tools, every
// message before it). Opted in here with "error": a mismatch is a 400, not a silently dropped block.
model.betas = ["thinking-binding-controls-2026-08-01" as never];
model.invocationKwargs = { thinking: { type: "adaptive", block_binding: { prefix_mismatch_behavior: "error" } } };

// The control: a changed system prompt must be refused.
const systemPrompt = flag === "--edit-prompt" ? `${inv.systemPrompt}\nToday is Monday.` : inv.systemPrompt;

const history = mapStoredMessagesToChatMessages(inv.messages.map((m) => m.data as unknown as StoredMessage));
const thinking = history
  .filter(AIMessage.isInstance)
  .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
  .filter((block) => block.type === "thinking").length;
console.log(`${inv.id} (${inv.status}): ${history.length} stored messages, ${thinking} thinking blocks, ${name}\n`);

try {
  const messages = [...history, new HumanMessage(question)];
  // shortcut: only the investigation's own cluster (the list isn't stored); pass more names if a continuation needs them.
  const answer = await runWithGateway(model, systemPrompt, config.maxModelCalls, config.gatewayUrl, config.agentGatewayToken, messages, inv.tenantId, [inv.cluster], [], async (added) => {
    for (const m of added) {
      if (ToolMessage.isInstance(m)) console.log(`  -> ${m.name}: ${m.status === "error" ? m.text : `${m.text.length} chars`}`);
      const u = AIMessage.isInstance(m) ? m.usage_metadata : undefined;
      if (u) console.log(`  model call: ${u.input_tokens} in (cache read ${u.input_token_details?.cache_read ?? 0}), ${u.output_tokens} out`);
    }
  });
  console.log(`\n${answer}`);
} finally {
  await prisma.$disconnect();
}
