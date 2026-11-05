import assert from "node:assert/strict";
import { after, test } from "node:test";
import { AIMessage, fakeModel, HumanMessage, SystemMessage, ToolMessage } from "langchain";
import { runConversationTurn } from "../src/agent/conversationAgent.ts";
import { CONVERSATION_PROMPT, conversationMessage } from "../src/agent/prompts.ts";
import { fakeMcpGateway } from "./helpers.ts";

const gw = await fakeMcpGateway();
after(() => gw.close());

const reply = (text: string) => new AIMessage({ content: text, response_metadata: { stop_reason: "end_turn" } });
const listPods = (args: Record<string, unknown>) => new AIMessage({ content: "", tool_calls: [{ name: "list_pods", args, id: "call_1" }] });

const turn = (model: ReturnType<typeof fakeModel>, clusters: string[], gatewayUrl = gw.url, mcpServers: { name: string; url: string; token: string }[] = []) =>
  runConversationTurn(model, CONVERSATION_PROMPT, 10, gatewayUrl, "a".repeat(32), [new HumanMessage("how is it?")], "t_1", clusters, mcpServers);

test("an MCP server that can't be used doesn't fail the turn, with or without clusters", async () => {
  const blocked = [{ name: "grafana", url: "https://127.0.0.1/", token: "x" }];
  for (const clusters of [["prod-eu"], []]) {
    const model = fakeModel().respond(reply("Answered anyway."));
    assert.equal(await turn(model, clusters, gw.url, blocked), "Answered anyway.");
  }
});

test("a plain answer with no report structure ends the turn: no citation check", async () => {
  const model = fakeModel().respond(reply("All pods look healthy."));
  assert.equal(await turn(model, ["prod-eu"]), "All pods look healthy.");
  assert.equal(model.callCount, 1);
  const system = model.calls[0]!.messages[0];
  assert.ok(SystemMessage.isInstance(system) && system.text === CONVERSATION_PROMPT);
});

test("with several clusters, a call goes to the cluster the model picked, without the argument", async () => {
  const model = fakeModel().respond(listPods({ cluster: "prod-us", namespace: "demo" })).respond(reply("None there."));
  await turn(model, ["prod-eu", "prod-us"]);
  assert.equal(gw.requests.at(-1)?.url, "/mcp/tenants/t_1/clusters/prod-us");
  assert.deepEqual(gw.calls.at(-1), { namespace: "demo" });
  assert.ok(ToolMessage.isInstance(model.calls[1]!.messages.at(-1)));
});

test("with one cluster, the model sends no cluster and the call goes to that one", async () => {
  const model = fakeModel().respond(listPods({ namespace: "demo" })).respond(reply("None there."));
  await turn(model, ["prod-eu"]);
  assert.equal(gw.requests.at(-1)?.url, "/mcp/tenants/t_1/clusters/prod-eu");
  assert.deepEqual(gw.calls.at(-1), { namespace: "demo" });
});

test("with no clusters, the gateway isn't contacted and the model still answers", async () => {
  const model = fakeModel().respond(reply("No cluster is connected, but in general: check the events."));
  // Nothing listens here, so a connect attempt would fail the turn.
  assert.equal(await turn(model, [], "http://127.0.0.1:1"), "No cluster is connected, but in general: check the events.");
});

const now = new Date("2026-11-04T10:00:00.000Z");

test("outside an incident the message is the time, the clusters and the text", () => {
  assert.equal(conversationMessage("hi", ["a", "b"], undefined, undefined, now).text, "Current time: 2026-11-04T10:00:00.000Z\n\nClusters: a, b\n\nhi");
  assert.equal(conversationMessage("hi", [], undefined, undefined, now).text, "Current time: 2026-11-04T10:00:00.000Z\n\nClusters: none\n\nhi");
});

test("in an incident's thread it also has the alerts and what became of the investigation, before the text", () => {
  const incident = {
    cluster: "prod-eu",
    title: "Pod is crash looping.",
    alerts: [{ status: "FIRING" as const, startsAt: "2026-10-21T09:00:00Z", labels: { alertname: "KubePodCrashLooping" }, annotations: {} }],
  };
  const text = (run: Parameters<typeof conversationMessage>[3]) => conversationMessage("why?", ["prod-eu"], incident, run, now).text;
  const end = "\n\nClusters: prod-eu\n\nwhy?";
  assert.match(text(undefined), /^Current time: 2026-11-04T10:00:00\.000Z\nIncident in cluster "prod-eu".*KubePodCrashLooping.*No investigation has finished for this incident/s);
  assert.ok(text({ status: "done", report: "## Summary\nOOM", error: null }).endsWith(`The investigation's report:\n## Summary\nOOM${end}`));
  assert.ok(text({ status: "failed", report: null, error: "call limit" }).endsWith(`The investigation failed, so there is no report: call limit${end}`));
});
