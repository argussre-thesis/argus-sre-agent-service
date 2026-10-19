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

test("what Claude receives: namespace required, nothing else allowed, no tenant or cluster, strict", () => {
  // The tools as ChatAnthropic puts them in the request; its constructor only checks that a key is set.
  process.env.ANTHROPIC_API_KEY ??= "test";
  type Sent = { name: string; strict?: boolean; input_schema: { properties: object; required: string[]; additionalProperties: boolean } };
  const sent = new ChatAnthropic({ model: "claude-haiku-5-5" }).invocationParams({ tools }).tools as unknown as Sent[];
  assert.deepEqual(
    sent.map((t) => t.name),
    ["list_pods", "list_deployments"],
  );
  for (const { name, strict, input_schema: schema } of sent) {
    assert.deepEqual(Object.keys(schema.properties), ["namespace", "labelSelector"], name);
    assert.deepEqual(schema.required, ["namespace"], name);
    assert.equal(schema.additionalProperties, false, name);
    assert.equal(strict, true, name);
  }
});

test("each tool runs its op on the run's tenant and cluster", async () => {
  gw.answer(200, { ok: true, data: { items: [] } });
  for (const t of tools) {
    assert.equal(await t.invoke({ namespace: "demo", labelSelector: "app=web" }, { context }), '{"items":[]}');
    assert.deepEqual(gw.requests.at(-1)?.url, "/internal/tenants/t_1/clusters/prod-eu/ops", t.name);
    assert.deepEqual(gw.requests.at(-1)?.body, { op: t.name, args: { namespace: "demo", labelSelector: "app=web" } });
  }
});

test("bad args are rejected before any request", async () => {
  const sent = gw.requests.length;
  const cases = [
    { namespce: "demo" },
    { namespace: "demo", extra: 1 },
    { namespace: "demo", labelSelector: null },
    { namespace: 1 },
    {},
  ];
  for (const args of cases) {
    for (const t of tools) {
      await assert.rejects(t.invoke(args as never, { context }), ToolInputParsingException, `${t.name} ${JSON.stringify(args)}`);
    }
  }
  assert.equal(gw.requests.length, sent);
});
