import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test, type TestContext } from "node:test";
import { ChatAnthropic } from "@langchain/anthropic";
import { ToolInputParsingException } from "@langchain/core/tools";
import { connectGateway } from "../src/agent/mcp.ts";
import { fakeMcpGateway } from "./helpers.ts";

const TOKEN = "a".repeat(32);
const ctx = { tenantId: "t_1", cluster: "minikube" };

async function connect(t: TestContext, ctxOverride = ctx, urlSuffix = "") {
  const gw = await fakeMcpGateway();
  t.after(() => gw.close());
  const { tools, close } = await connectGateway(gw.url + urlSuffix, TOKEN, ctxOverride);
  t.after(close);
  return { gw, listPods: tools.find((tool) => tool.name === "list_pods")!, tools };
}

const text = (s: string) => ({ content: [{ type: "text" as const, text: s }] });

test("the gateway's tools, as Claude receives them: its schema, nothing else allowed, strict", async (t) => {
  const { tools } = await connect(t);
  process.env.ANTHROPIC_API_KEY ??= "test";
  type Sent = { name: string; description: string; strict?: boolean; input_schema: { properties: object; required: string[]; additionalProperties: boolean } };
  const sent = new ChatAnthropic({ model: "claude-haiku-5-5" }).invocationParams({ tools }).tools as unknown as Sent[];
  assert.equal(sent.length, 1);
  const [{ name, description, strict, input_schema: schema }] = sent as [Sent];
  assert.deepEqual({ name, description, strict }, { name: "list_pods", description: "List the pods in a namespace.", strict: true });
  assert.deepEqual(Object.keys(schema.properties), ["namespace", "labelSelector"]);
  assert.deepEqual(schema.required, ["namespace"]);
  assert.equal(schema.additionalProperties, false);
});

test("every request goes to the run's tenant and cluster with the token; a call returns the gateway's text", async (t) => {
  const { gw, listPods } = await connect(t, { tenantId: "t/1", cluster: "a/b" });
  gw.answer(text('{"pods":[]}'));
  assert.equal(await listPods.invoke({ namespace: "demo", labelSelector: "app=web" }), '{"pods":[]}');
  assert.deepEqual(gw.calls, [{ namespace: "demo", labelSelector: "app=web" }]);
  assert.deepEqual(
    gw.requests.map((r) => r.method),
    ["initialize", "notifications/initialized", "tools/list", "tools/call"],
  );
  for (const r of gw.requests) {
    assert.equal(r.url, "/mcp/tenants/t%2F1/clusters/a%2Fb");
    assert.equal(r.authorization, `Bearer ${TOKEN}`);
  }
});

test("a trailing slash in the gateway URL", async (t) => {
  const { gw, listPods } = await connect(t, ctx, "/");
  await listPods.invoke({ namespace: "demo" });
  assert.equal(gw.requests.at(-1)?.url, "/mcp/tenants/t_1/clusters/minikube");
});

test("an error result reaches the model as its text", async (t) => {
  const { gw, listPods } = await connect(t);
  gw.answer({ ...text("Error RUNNER_OFFLINE: no runner is connected for this cluster"), isError: true });
  assert.equal(await listPods.invoke({ namespace: "demo" }), "Error RUNNER_OFFLINE: no runner is connected for this cluster");
});

test("a result over 20,000 characters is cut, with a note, never inside an emoji", async (t) => {
  const { gw, listPods } = await connect(t);
  const result = (s: string) => {
    gw.answer(text(s));
    return listPods.invoke({ namespace: "demo" });
  };
  const note = (total: string, kept: string) =>
    `\n[Cut: this result is ${total} characters, only the first ${kept} are shown. Narrow the query to see the rest.]`;
  const x = (n: number) => "x".repeat(n);

  assert.equal(await result(x(20_000)), x(20_000));
  assert.equal(await result(x(20_001)), `${x(20_000)}${note("20,001", "20,000")}`);
  // The emoji's first half would be the last character kept.
  assert.equal(await result(`${x(19_999)}😀`), `${x(19_999)}${note("20,001", "19,999")}`);
});

test("bad args are rejected with the reason, before any call", async (t) => {
  const { gw, listPods } = await connect(t);
  const cases: [object, RegExp][] = [
    [{}, /required/],
    [{ namespace: "demo", extra: 1 }, /additionalProperties/],
    [{ namespace: 1 }, /type/],
    [{ namespace: "demo", labelSelector: null }, /type/],
  ];
  for (const [args, details] of cases) {
    await assert.rejects(listPods.invoke(args as never), (err: Error) => {
      assert.ok(err instanceof ToolInputParsingException, JSON.stringify(args));
      assert.match(err.message, /Details: .*/, JSON.stringify(args));
      assert.match(err.message, details, JSON.stringify(args));
      return true;
    });
  }
  assert.deepEqual(gw.calls, []);
});

test("an unreachable gateway fails the connect, saying why", async () => {
  const closed = createServer();
  await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
  const { port } = closed.address() as AddressInfo;
  await new Promise((resolve) => closed.close(resolve));
  await assert.rejects(
    connectGateway(`http://127.0.0.1:${port}`, TOKEN, ctx),
    new RegExp(`^Error: cannot reach the gateway: fetch failed: connect ECONNREFUSED 127\\.0\\.0\\.1:${port}$`),
  );
});

test("a gateway gone mid-run: the call returns why, as text", async (t) => {
  const { gw, listPods } = await connect(t);
  await gw.close();
  // RESET when the client reuses its kept-alive socket, REFUSED on a new one.
  assert.match(await listPods.invoke({ namespace: "demo" }), /^Error GATEWAY_ERROR: fetch failed: (read ECONNRESET|connect ECONNREFUSED)/);
});
