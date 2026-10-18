import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { callOp } from "../src/ops.ts";

// Fake gateway: records the last request and answers with what the test set.
let reply = { status: 200, body: "" };
let last: { method?: string; url?: string; contentType?: string; body?: unknown } = {};
const gateway = createServer(async (req, res) => {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  last = { method: req.method, url: req.url, contentType: req.headers["content-type"], body: JSON.parse(raw) };
  res.writeHead(reply.status, { "content-type": "application/json" }).end(reply.body);
});
let opsUrl = "";
before(async () => {
  await new Promise<void>((resolve) => gateway.listen(0, "127.0.0.1", resolve));
  opsUrl = `http://127.0.0.1:${(gateway.address() as AddressInfo).port}`;
});
after(() => gateway.close());

const ctx = { tenantId: "t_1", cluster: "minikube" };
const answer = (status: number, body: unknown) => {
  reply = { status, body: typeof body === "string" ? body : JSON.stringify(body) };
};

test("sends the op to the context's tenant and cluster", async () => {
  answer(200, { ok: true, data: { pods: [] } });
  const text = await callOp(opsUrl, { tenantId: "t 1", cluster: "a/b" }, "list_pods", { namespace: "demo" });
  assert.equal(text, '{"pods":[]}');
  assert.deepEqual(last, {
    method: "POST",
    url: "/internal/tenants/t%201/clusters/a%2Fb/ops",
    contentType: "application/json",
    body: { op: "list_pods", args: { namespace: "demo" } },
  });
});

test("every reply becomes text for the model", async () => {
  const cases: [status: number, body: unknown, expected: string | RegExp][] = [
    [200, { ok: true, data: { pods: [{ name: "api-1" }] } }, '{"pods":[{"name":"api-1"}]}'],
    [200, { ok: true }, "null"],
    [200, { ok: false, error: { code: "NOT_FOUND", message: "pod not found" } }, "Error NOT_FOUND: pod not found"],
    [503, { ok: false, error: { code: "RUNNER_OFFLINE", message: "no runner" } }, "Error RUNNER_OFFLINE: no runner"],
    [200, { ok: false }, /^Error GATEWAY_ERROR: unexpected gateway response \(HTTP 200\)$/],
    [200, "null", /^Error GATEWAY_ERROR: unexpected gateway response \(HTTP 200\)$/],
    [404, "<html>Cannot POST</html>", /^Error GATEWAY_ERROR: .*not valid JSON/],
  ];
  for (const [status, body, expected] of cases) {
    answer(status, body);
    const text = await callOp(opsUrl, ctx, "ping", {});
    if (typeof expected === "string") assert.equal(text, expected, JSON.stringify(body));
    else assert.match(text, expected, JSON.stringify(body));
  }
});

test("a trailing slash in OPS_URL", async () => {
  answer(200, { ok: true, data: 1 });
  assert.equal(await callOp(`${opsUrl}/`, ctx, "ping", {}), "1");
  assert.equal(last.url, "/internal/tenants/t_1/clusters/minikube/ops");
});

test("an unreachable gateway says why", async () => {
  const closed = createServer();
  await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
  const { port } = closed.address() as AddressInfo;
  await new Promise((resolve) => closed.close(resolve));
  const text = await callOp(`http://127.0.0.1:${port}`, ctx, "ping", {});
  assert.match(text, new RegExp(`^Error GATEWAY_ERROR: fetch failed: connect ECONNREFUSED 127\\.0\\.0\\.1:${port}$`));
});
