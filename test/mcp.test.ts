import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test, type TestContext } from "node:test";
import { ChatAnthropic } from "@langchain/anthropic";
import { ToolInputParsingException } from "@langchain/core/tools";
import { connectGateway } from "../src/agent/mcp.ts";
import * as z from "zod";
import { fakeMcpGateway } from "./helpers.ts";

const TOKEN = "a".repeat(32);
const demo = { namespace: "demo" };

async function connect(t: TestContext, tenantId = "t_1", clusters = ["minikube"], urlSuffix = "") {
  const gw = await fakeMcpGateway();
  t.after(() => gw.close());
  const { tools, close } = await connectGateway(gw.url + urlSuffix, TOKEN, tenantId, clusters);
  t.after(close);
  return { gw, listPods: tools.find((tool) => tool.name === "list_pods")!, tools };
}

const text = (s: string) => ({ content: [{ type: "text" as const, text: s }] });

type Sent = {
  name: string;
  description: string;
  strict?: boolean;
  input_schema: { properties: Record<string, unknown>; required: string[]; additionalProperties: boolean };
};
function asClaudeReceivesThem(tools: Awaited<ReturnType<typeof connect>>["tools"]) {
  process.env.ANTHROPIC_API_KEY ??= "test";
  return new ChatAnthropic({ model: "claude-haiku-5-5" }).invocationParams({ tools }).tools as unknown as Sent[];
}

test("one cluster: the gateway's schema as it is, strict, and every call goes to that cluster", async (t) => {
  const { gw, listPods, tools } = await connect(t, "t_1", ["minikube"]);
  const [{ strict, input_schema: schema }] = asClaudeReceivesThem(tools) as [Sent];
  assert.equal(strict, true);
  assert.deepEqual(Object.keys(schema.properties), ["namespace", "labelSelector"]);
  assert.deepEqual(schema.required, ["namespace"]);
  assert.equal(schema.additionalProperties, false);

  await listPods.invoke(demo);
  assert.deepEqual(gw.calls, [demo]);
  assert.equal(gw.requests.at(-1)?.url, "/mcp/tenants/t_1/clusters/minikube");
});

test("several clusters: the gateway's tools, as Claude receives them: its schema plus a required cluster, nothing else allowed, strict", async (t) => {
  const { tools } = await connect(t, "t_1", ["prod-eu", "prod-us"]);
  const sent = asClaudeReceivesThem(tools);
  assert.equal(sent.length, 1);
  const [{ name, description, strict, input_schema: schema }] = sent as [Sent];
  assert.deepEqual({ name, description, strict }, { name: "list_pods", description: "List the pods in a namespace.", strict: true });
  assert.deepEqual(Object.keys(schema.properties), ["cluster", "namespace", "labelSelector"]);
  assert.deepEqual(schema.properties.cluster, { type: "string", enum: ["prod-eu", "prod-us"] });
  assert.deepEqual(schema.required, ["cluster", "namespace"]);
  assert.equal(schema.additionalProperties, false);
});

test("tools are listed on the first cluster; a call goes to its cluster's URL without the cluster, connecting on first use", async (t) => {
  const { gw, listPods } = await connect(t, "t/1", ["a/b", "c"]);
  gw.answer(text('{"pods":[]}'));
  // Two calls at once to a cluster not connected yet share one connect.
  const both = await Promise.all([
    listPods.invoke({ cluster: "c", namespace: "demo", labelSelector: "app=web" }),
    listPods.invoke({ cluster: "c", namespace: "demo" }),
  ]);
  assert.deepEqual(both, ['{"pods":[]}', '{"pods":[]}']);
  await listPods.invoke({ cluster: "a/b", namespace: "demo" });

  assert.deepEqual(gw.calls, [{ namespace: "demo", labelSelector: "app=web" }, { namespace: "demo" }, { namespace: "demo" }]);
  const [ab, c] = ["/mcp/tenants/t%2F1/clusters/a%2Fb", "/mcp/tenants/t%2F1/clusters/c"];
  assert.deepEqual(
    gw.requests.map((r) => [r.method, r.url]),
    [
      ["initialize", ab],
      ["notifications/initialized", ab],
      ["tools/list", ab],
      ["initialize", c],
      ["notifications/initialized", c],
      ["tools/call", c],
      ["tools/call", c],
      ["tools/call", ab],
    ],
  );
  for (const r of gw.requests) assert.equal(r.authorization, `Bearer ${TOKEN}`);
});

test("a cluster that fails to connect: the call returns why, as text, and the next call connects again", async (t) => {
  const { gw, listPods } = await connect(t, "t_1", ["minikube", "civo"]);
  gw.fail(1);
  assert.equal(await listPods.invoke({ cluster: "civo", namespace: "demo" }), "Error GATEWAY_ERROR: Streamable HTTP error: Error POSTing to endpoint: down");
  assert.equal(await listPods.invoke({ cluster: "civo", namespace: "demo" }), "{}");
  assert.deepEqual(
    gw.requests.slice(3).map((r) => r.method),
    ["initialize", "initialize", "notifications/initialized", "tools/call"],
  );
});

test("a gateway tool with a cluster argument of its own fails the connect", async (t) => {
  const gw = await fakeMcpGateway(z.strictObject({ cluster: z.string() }));
  t.after(() => gw.close());
  await assert.rejects(connectGateway(gw.url, TOKEN, "t_1", ["minikube"]), /^Error: the gateway's list_pods tool has a "cluster" argument of its own$/);
});

test("a trailing slash in the gateway URL", async (t) => {
  const { gw, listPods } = await connect(t, "t_1", ["minikube"], "/");
  await listPods.invoke(demo);
  assert.equal(gw.requests.at(-1)?.url, "/mcp/tenants/t_1/clusters/minikube");
});

test("an error result reaches the model as its text", async (t) => {
  const { gw, listPods } = await connect(t);
  gw.answer({ ...text("Error RUNNER_OFFLINE: no runner is connected for this cluster"), isError: true });
  assert.equal(await listPods.invoke(demo), "Error RUNNER_OFFLINE: no runner is connected for this cluster");
});

test("a result over 20,000 characters is cut, with a note, never inside an emoji", async (t) => {
  const { gw, listPods } = await connect(t);
  const result = (s: string) => {
    gw.answer(text(s));
    return listPods.invoke(demo);
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
    [{ cluster: "minikube", ...demo }, /additionalProperties/],
    [{ ...demo, extra: 1 }, /additionalProperties/],
    [{ namespace: 1 }, /type/],
    [{ ...demo, labelSelector: null }, /type/],
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

test("several clusters: the cluster is required and must be one of them, before any call", async (t) => {
  const { gw, listPods } = await connect(t, "t_1", ["minikube", "civo"]);
  await assert.rejects(listPods.invoke(demo as never), /required property "cluster"/);
  await assert.rejects(listPods.invoke({ cluster: "prod-eu", ...demo } as never), /enum/);
  assert.deepEqual(gw.calls, []);
});

test("an unreachable gateway fails the connect, saying why", async () => {
  const closed = createServer();
  await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
  const { port } = closed.address() as AddressInfo;
  await new Promise((resolve) => closed.close(resolve));
  await assert.rejects(
    connectGateway(`http://127.0.0.1:${port}`, TOKEN, "t_1", ["minikube"]),
    new RegExp(`^Error: cannot reach the gateway: fetch failed: connect ECONNREFUSED 127\\.0\\.0\\.1:${port}$`),
  );
});

test("a gateway gone mid-run: the call returns why, as text", async (t) => {
  const { gw, listPods } = await connect(t);
  await gw.close();
  // RESET when the client reuses its kept-alive socket, REFUSED on a new one.
  assert.match(await listPods.invoke(demo), /^Error GATEWAY_ERROR: fetch failed: (read ECONNRESET|connect ECONNREFUSED)/);
});
