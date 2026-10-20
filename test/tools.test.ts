import assert from "node:assert/strict";
import { after, test } from "node:test";
import { ChatAnthropic } from "@langchain/anthropic";
import { ToolInputParsingException } from "@langchain/core/tools";
import { createTools } from "../src/agent/tools.ts";
import { fakeGateway } from "./helpers.ts";

const gw = await fakeGateway();
after(() => gw.close());
const tools = createTools(gw.url);
const context = { tenantId: "t_1", cluster: "prod-eu" };

// Each tool's args (the runner's), required first, and one valid call with every arg set.
const expected: Record<string, { properties: string[]; required: string[]; call: Record<string, unknown> }> = {
  list_pods: { properties: ["namespace", "labelSelector"], required: ["namespace"], call: { namespace: "demo", labelSelector: "app=web" } },
  get_pod: { properties: ["namespace", "name"], required: ["namespace", "name"], call: { namespace: "demo", name: "web-1" } },
  get_logs: {
    properties: ["namespace", "pod", "container", "previous", "tailLines", "sinceSeconds"],
    required: ["namespace", "pod"],
    call: { namespace: "demo", pod: "web-1", container: "app", previous: true, tailLines: 50, sinceSeconds: 600 },
  },
  list_events: {
    properties: ["namespace", "involvedObject", "type", "sinceSeconds"],
    required: ["namespace"],
    call: { namespace: "demo", involvedObject: "Pod/web-1", type: "Warning", sinceSeconds: 300 },
  },
  list_deployments: { properties: ["namespace", "labelSelector"], required: ["namespace"], call: { namespace: "demo", labelSelector: "app=web" } },
  list_replicasets: { properties: ["namespace", "labelSelector"], required: ["namespace"], call: { namespace: "demo", labelSelector: "app=web" } },
};

test("what Claude receives: the runner's args, nothing else allowed, no tenant or cluster, strict", () => {
  // The tools as ChatAnthropic puts them in the request; its constructor only checks that a key is set.
  process.env.ANTHROPIC_API_KEY ??= "test";
  type Sent = { name: string; strict?: boolean; input_schema: { properties: object; required: string[]; additionalProperties: boolean } };
  const sent = new ChatAnthropic({ model: "claude-haiku-5-5" }).invocationParams({ tools }).tools as unknown as Sent[];
  assert.deepEqual(
    sent.map((t) => t.name),
    Object.keys(expected),
  );
  for (const { name, strict, input_schema: schema } of sent) {
    assert.deepEqual(Object.keys(schema.properties), expected[name]!.properties, name);
    assert.deepEqual(schema.required, expected[name]!.required, name);
    assert.equal(schema.additionalProperties, false, name);
    assert.equal(strict, true, name);
  }
  // Strict tool schemas don't support numeric constraints.
  assert.doesNotMatch(JSON.stringify(sent), /"minimum"|"maximum"/);
});

test("each tool runs its op on the run's tenant and cluster", async () => {
  gw.answer(200, { ok: true, data: { items: [] } });
  for (const t of tools) {
    const args = expected[t.name]!.call;
    assert.equal(await t.invoke(args, { context }), '{"items":[]}');
    assert.deepEqual(gw.requests.at(-1)?.url, "/internal/tenants/t_1/clusters/prod-eu/ops", t.name);
    assert.deepEqual(gw.requests.at(-1)?.body, { op: t.name, args });
  }
});

test("bad args are rejected before any request", async () => {
  const sent = gw.requests.length;
  const cases: [string, object][] = [];
  for (const [name, { call }] of Object.entries(expected)) {
    cases.push([name, {}], [name, { ...call, extra: 1 }], [name, { ...call, namespace: 1 }], [name, { namespce: "demo" }]);
  }
  cases.push(
    ["list_pods", { namespace: "demo", labelSelector: null }],
    ["get_pod", { namespace: "demo" }],
    ["get_logs", { namespace: "demo", name: "web-1" }],
    ["get_logs", { namespace: "demo", pod: "web-1", previous: "yes" }],
    ["get_logs", { namespace: "demo", pod: "web-1", tailLines: "50" }],
    ["list_events", { namespace: "demo", type: "Error" }],
  );
  for (const [name, args] of cases) {
    const t = tools.find((t) => t.name === name)!;
    await assert.rejects(t.invoke(args as never, { context }), ToolInputParsingException, `${name} ${JSON.stringify(args)}`);
  }
  assert.equal(gw.requests.length, sent);
});
