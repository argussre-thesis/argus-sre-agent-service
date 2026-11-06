import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test, type TestContext } from "node:test";
import { ChatAnthropic } from "@langchain/anthropic";
import { ToolInputParsingException } from "@langchain/core/tools";
import { setTimeout as sleep } from "node:timers/promises";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import { connectGateway, connectMcpServers, connectTools } from "../src/agent/mcp.ts";
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

// The test servers are local, which publicFetch refuses, so these tests use plain fetch unless they're about publicFetch.
async function mcpServers(t: TestContext, inputSchema?: z.ZodObject) {
  const gw = await fakeMcpGateway(inputSchema);
  t.after(() => gw.close());
  return gw;
}
const server = (name: string, url: string) => ({ name, url, token: `${name}-token` });

test("an MCP server's tools get its name as a prefix, are not strict, and use its token", async (t) => {
  const gw = await mcpServers(t);
  const { tools, failed, close } = await connectMcpServers([server("prod-grafana", gw.url)], fetch);
  t.after(close);

  assert.deepEqual(failed, []);
  const [{ name, description, strict }] = asClaudeReceivesThem(tools) as [Sent];
  assert.deepEqual({ name, description, strict }, { name: "prod-grafana_list_pods", description: "List the pods in a namespace.", strict: undefined });
  gw.answer(text('{"pods":[]}'));
  assert.equal(await tools[0]!.invoke(demo), '{"pods":[]}');
  assert.deepEqual(gw.calls, [demo]);
  assert.equal(gw.requests.at(-1)?.method, "tools/call");
  for (const r of gw.requests) assert.equal(r.authorization, "Bearer prod-grafana-token");
});

test("an MCP server with headers sends exactly those on every request, with no Bearer token", async (t) => {
  const gw = await mcpServers(t);
  const headers = { "api-key": "secret-key", authorization: "Token secret-token" };
  const { tools, failed, close } = await connectMcpServers([{ name: "pagerduty", url: gw.url, headers }], fetch);
  t.after(close);

  assert.deepEqual(failed, []);
  gw.answer(text("{}"));
  await tools[0]!.invoke(demo);
  assert.equal(gw.requests.at(-1)?.method, "tools/call");
  for (const r of gw.requests) {
    assert.equal(r.apiKey, "secret-key");
    assert.equal(r.authorization, "Token secret-token");
  }
});

test("an MCP tool's own cluster argument reaches the server", async (t) => {
  const gw = await mcpServers(t, z.strictObject({ cluster: z.string() }));
  const { tools, close } = await connectMcpServers([server("grafana", gw.url)], fetch);
  t.after(close);
  await tools[0]!.invoke({ cluster: "prod-eu" });
  assert.deepEqual(gw.calls, [{ cluster: "prod-eu" }]);
});

test("a server that fails is left out and named, and the others still work", async (t) => {
  const [good, down] = [await mcpServers(t), await mcpServers(t)];
  down.fail(1);
  const { tools, failed, close } = await connectMcpServers(
    [server("down", down.url), server("bad-url", "not a url"), server("good", good.url)],
    fetch,
  );
  t.after(close);

  assert.deepEqual(tools.map((tool) => tool.name), ["good_list_pods"]);
  assert.deepEqual(failed, [
    { name: "down", reason: "Streamable HTTP error: Error POSTing to endpoint: down" },
    { name: "bad-url", reason: "Invalid URL" },
  ]);
});

test("servers connect in parallel, so a slow one doesn't delay the others", async (t) => {
  const [a, b] = [await mcpServers(t), await mcpServers(t)];
  const release = [a.hold(), b.hold()];
  const connecting = connectMcpServers([server("a", a.url), server("b", b.url)], fetch);
  for (let i = 0; i < 100 && !(a.requests.length && b.requests.length); i++) await sleep(10);
  assert.deepEqual([a.requests.length, b.requests.length], [1, 1]);
  release.forEach((r) => r());
  t.after((await connecting).close);
});

test("by default a non-https or private address fails that server, with no request sent", async (t) => {
  const gw = await mcpServers(t);
  const port = new URL(gw.url).port;
  const { tools, failed } = await connectMcpServers([
    server("plain", gw.url),
    server("loopback", `https://127.0.0.1:${port}/`),
    server("metadata", "https://169.254.169.254/"),
    server("local", `https://localhost:${port}/`),
  ]);

  assert.deepEqual(tools, []);
  assert.deepEqual(failed, [
    { name: "plain", reason: "the URL must use https" },
    { name: "loopback", reason: "127.0.0.1 is not a public address" },
    { name: "metadata", reason: "169.254.169.254 is not a public address" },
    { name: "local", reason: "fetch failed: localhost is not a public address" },
  ]);
  assert.deepEqual(gw.requests, []);
});

test("a failure's reason is cut short, since it comes from the server and reaches the model", async (t) => {
  const huge: FetchLike = async () => new Response("x".repeat(100_000), { status: 500 });
  const { failed } = await connectMcpServers([server("huge", "https://mcp.example.com/")], huge);
  assert.equal(failed.length, 1);
  assert.equal(failed[0]!.reason.length, 300);
});

// Answers tools/list itself, so a test can give any list. The rest goes to the fake server.
const listing =
  (tools: object[], nextCursor?: string): FetchLike =>
  async (url, init) => {
    const body = init?.method === "POST" ? JSON.parse(String(init.body)) : undefined;
    if (body?.method !== "tools/list") return fetch(url, init);
    return Response.json({ jsonrpc: "2.0", id: body.id, result: { tools, nextCursor } });
  };
const listedTool = (name: string) => ({ name, inputSchema: { type: "object" } });

test("a tool with an unusable name is left out and counted, and the rest of the server works", async (t) => {
  const gw = await mcpServers(t);
  const list = [listedTool("ok"), listedTool("has space"), listedTool("dotted.name"), listedTool("x".repeat(60)), listedTool("ok")];
  const { tools, failed, close } = await connectMcpServers([server("grafana", gw.url)], listing(list));
  t.after(close);

  assert.deepEqual(tools.map((tool) => tool.name), ["grafana_ok"]);
  assert.deepEqual(failed, [{ name: "grafana", reason: "4 of its tools have names that can't be used" }]);
});

test("a server with more pages of tools keeps the first and says so", async (t) => {
  const gw = await mcpServers(t);
  const { tools, failed, close } = await connectMcpServers([server("grafana", gw.url)], listing([listedTool("ok")], "page-2"));
  t.after(close);
  assert.deepEqual(tools.map((tool) => tool.name), ["grafana_ok"]);
  assert.deepEqual(failed, [{ name: "grafana", reason: "it has more tools than were read" }]);
});

test("a run gets the gateway's tools and the servers' tools, and each call reaches its own", async (t) => {
  const [gw, grafana] = [await mcpServers(t), await mcpServers(t)];
  const { tools, failed, close } = await connectTools(gw.url, TOKEN, "t_1", ["prod-eu"], [server("grafana", grafana.url)], fetch);
  t.after(close);

  assert.deepEqual(tools.map((tool) => tool.name), ["list_pods", "grafana_list_pods"]);
  assert.deepEqual(failed, []);
  await tools[1]!.invoke(demo);
  assert.deepEqual([gw.calls, grafana.calls], [[], [demo]]);
  await tools[0]!.invoke(demo);
  assert.deepEqual([gw.calls, grafana.calls], [[demo], [demo]]);
});

test("with no clusters the gateway isn't contacted, and the servers' tools still arrive", async (t) => {
  const [gw, grafana] = [await mcpServers(t), await mcpServers(t)];
  const { tools, close } = await connectTools(gw.url, TOKEN, "t_1", [], [server("grafana", grafana.url)], fetch);
  t.after(close);
  assert.deepEqual(tools.map((tool) => tool.name), ["grafana_list_pods"]);
  assert.deepEqual(gw.requests, []);

  const none = await connectTools(gw.url, TOKEN, "t_1", [], [], fetch);
  assert.deepEqual(none.tools, []);
  await none.close();
});

test("a server's tool named like a gateway tool is left out and named, and the gateway's stays", async (t) => {
  const [gw, clash] = [await mcpServers(t), await mcpServers(t)];
  const { tools, failed, close } = await connectTools(gw.url, TOKEN, "t_1", ["prod-eu"], [server("list", clash.url)], listing([listedTool("pods"), listedTool("nodes")]));
  t.after(close);

  assert.deepEqual(tools.map((tool) => tool.name), ["list_pods", "list_nodes"]);
  assert.deepEqual(failed, [{ name: "list", reason: "its tool list_pods has the same name as a built-in tool" }]);
  await tools[0]!.invoke(demo);
  assert.deepEqual([gw.calls, clash.calls], [[demo], []]);
});

test("an unreachable gateway fails the run, before any server is contacted", async (t) => {
  const [gw, grafana] = [await mcpServers(t), await mcpServers(t)];
  gw.fail(1);
  await assert.rejects(connectTools(gw.url, TOKEN, "t_1", ["prod-eu"], [server("grafana", grafana.url)], fetch), /cannot reach the gateway/);
  assert.deepEqual(grafana.requests, []);
});

test("during a run, a tool's error and a dead server come back to the model as text", async (t) => {
  const gw = await mcpServers(t);
  const { tools, close } = await connectMcpServers([server("grafana", gw.url)], fetch);
  t.after(close);

  gw.answer({ ...text("no such datasource"), isError: true });
  assert.equal(await tools[0]!.invoke(demo), "Error MCP_TOOL_ERROR: no such datasource");
  await gw.close();
  assert.match(await tools[0]!.invoke(demo), /^Error MCP_SERVER_ERROR: fetch failed/);
});
