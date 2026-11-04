import assert from "node:assert/strict";
import { after, test } from "node:test";
import { AIMessage, type BaseMessage, fakeModel, HumanMessage, SystemMessage, ToolMessage } from "langchain";
import { runWithGateway } from "../src/agent/agent.ts";
import { INVESTIGATION_PROMPT } from "../src/agent/prompts.ts";
import { fakeMcpGateway } from "./helpers.ts";

const gw = await fakeMcpGateway();
after(() => gw.close());
const demo = { namespace: "demo" };
const agentGatewayToken = "a".repeat(32);

const answer = (text: string, stop_reason = "end_turn") => new AIMessage({ content: text, response_metadata: { stop_reason } });
const report = (evidence: string) => `## Summary\nx\n## Evidence\n${evidence}`;
const demoPods = '`list_pods {"namespace":"demo"}`';
// Not respondWithTools: its reply text joins every earlier message, which outgrows a string within 30 calls.
const listPods = (args: Record<string, unknown>, id: string = crypto.randomUUID()) =>
  new AIMessage({ content: "", tool_calls: [{ name: "list_pods", args, id }] });

async function run(model: ReturnType<typeof fakeModel>, maxModelCalls = 30) {
  const steps: BaseMessage[][] = [];
  const messages = [new HumanMessage("api pods crash-looping in demo")];
  const report = await runWithGateway(model, INVESTIGATION_PROMPT, maxModelCalls, gw.url, agentGatewayToken, messages, "t_1", ["prod-eu"], async (added) => {
    steps.push(added);
  });
  return { report, steps };
}

test("a tool call runs on the run's cluster, its result goes back, the report is returned", async () => {
  gw.answer({ content: [{ type: "text", text: '{"items":[]}' }] });
  const model = fakeModel()
    .respond(listPods(demo, "call_1"))
    .respond(answer(report(`- No pods ${demoPods}`)));
  const { report: text, steps } = await run(model);

  assert.equal(text, report(`- No pods ${demoPods}`));
  assert.equal(gw.requests.at(-1)?.url, "/mcp/tenants/t_1/clusters/prod-eu");
  assert.equal(gw.requests.at(-1)?.authorization, `Bearer ${agentGatewayToken}`);
  assert.deepEqual(gw.calls.at(-1), { namespace: "demo" });
  const [system, alert] = model.calls[0]!.messages;
  assert.ok(SystemMessage.isInstance(system) && system.text === INVESTIGATION_PROMPT);
  assert.ok(HumanMessage.isInstance(alert));
  const result = model.calls[1]!.messages.at(-1);
  assert.ok(ToolMessage.isInstance(result));
  assert.deepEqual([result.tool_call_id, result.content], ["call_1", '{"items":[]}']);
  assert.deepEqual(
    steps.map((added) => added.map((m) => m.type)),
    [["ai"], ["tool"], ["ai"]],
  );
});

test("a mistyped arg goes back to the model as an error, without a stack trace, and the run goes on", async () => {
  const sent = gw.calls.length;
  const model = fakeModel()
    .respond(listPods({ namespce: "demo" }))
    .respond(answer(report("None.")));
  assert.equal((await run(model)).report, report("None."));

  const error = model.calls[1]!.messages.at(-1);
  assert.ok(ToolMessage.isInstance(error));
  assert.equal(error.status, "error");
  assert.match(
    error.text,
    /^Error BAD_ARGS: Received tool input did not match expected schema\nDetails: .*required property "namespace".*Property "namespce" does not match/s,
  );
  assert.doesNotMatch(error.text, /\n\s+at /);
  assert.equal(gw.calls.length, sent);
});

test("the call limit fails the run, before LangGraph's own step limit does", async () => {
  const model = fakeModel();
  for (let i = 0; i < 31; i++) model.respond(listPods(demo));
  await assert.rejects(run(model, 30), /Model call limits exceeded: run level call limit reached with 30 model calls/);
  assert.equal(model.callCount, 30);
});

test("a reply that isn't a normal end fails the run", async () => {
  for (const reason of ["max_tokens", "refusal"]) {
    const model = fakeModel().respond(answer("## Summary\nThe pods", reason));
    await assert.rejects(run(model), new RegExp(`run ended without a report \\(stop reason: ${reason}\\)`));
  }
});

const wrong = report('- api-1 was OOMKilled `list_pods {"namespace":"prod"}`');
const fixed = report(`- api-1 was OOMKilled ${demoPods}`);

test("a report citing a call that never ran gets one chance to fix it", async () => {
  const model = fakeModel().respond(listPods(demo)).respond(answer(wrong)).respond(answer(fixed));
  const { report: text, steps } = await run(model);

  assert.equal(text, fixed);
  const fix = model.calls[2]!.messages.at(-1);
  assert.ok(HumanMessage.isInstance(fix));
  assert.ok(
    fix.text.startsWith(
      "Your report's citations don't match your tool calls:\n" + '- `list_pods {"namespace":"prod"}` matches no tool call you made\n',
    ),
  );
  assert.deepEqual(
    steps.map((added) => added.map((m) => m.type)),
    [["ai"], ["tool"], ["ai"], ["human"], ["ai"]],
  );
});

test("the fix's model call counts toward the call limit", async () => {
  // Calls: list_pods, wrong report, the fix gathering evidence, then a 4th that limit 3 must block.
  const model = fakeModel()
    .respond(listPods(demo))
    .respond(answer(wrong))
    .respond(listPods(demo))
    .respond(answer(fixed));
  await assert.rejects(run(model, 3), /run level call limit reached with 3 model calls/);
  assert.equal(model.callCount, 3);
});

test("a report whose citations are still wrong after the fix fails the run", async () => {
  const model = fakeModel()
    .respond(answer(report("- api-1 was OOMKilled")))
    .respond(answer(report("- api-1 was OOMKilled")));
  await assert.rejects(run(model), /citations still don't match its tool calls: no tool call cited in: "api-1 was OOMKilled"/);
  assert.equal(model.callCount, 2);
});
