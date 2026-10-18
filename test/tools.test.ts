import assert from "node:assert/strict";
import { after, test } from "node:test";
import { ToolInputParsingException } from "@langchain/core/tools";
import { toJsonSchema } from "@langchain/core/utils/json_schema";
import { createTools } from "../src/tools.ts";
import { fakeGateway } from "./helpers.ts";

const gw = await fakeGateway();
after(() => gw.close());
const tools = createTools(gw.url);
const context = { tenantId: "t_1", cluster: "prod-eu" };

test("what the model sees: namespace required, nothing else allowed, no tenant or cluster", () => {
  assert.deepEqual(
    tools.map((t) => t.name),
    ["list_pods", "list_deployments"],
  );
  for (const t of tools) {
    // The same conversion ChatAnthropic does before sending the tools.
    const schema = toJsonSchema(t.schema) as { properties: object; required: string[]; additionalProperties: boolean };
    assert.deepEqual(Object.keys(schema.properties), ["namespace", "labelSelector"], t.name);
    assert.deepEqual(schema.required, ["namespace"], t.name);
    assert.equal(schema.additionalProperties, false, t.name);
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
