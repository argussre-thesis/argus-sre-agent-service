import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { after, test } from "node:test";
import { callOp } from "../src/ops.ts";
import { fakeGateway } from "./helpers.ts";

const gw = await fakeGateway();
after(() => gw.close());
const ctx = { tenantId: "t_1", cluster: "minikube" };

test("sends the op to the context's tenant and cluster", async () => {
  gw.answer(200, { ok: true, data: { pods: [] } });
  const text = await callOp(gw.url, { tenantId: "t 1", cluster: "a/b" }, "list_pods", { namespace: "demo" });
  assert.equal(text, '{"pods":[]}');
  assert.deepEqual(gw.requests.at(-1), {
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
    gw.answer(status, body);
    const text = await callOp(gw.url, ctx, "ping", {});
    if (typeof expected === "string") assert.equal(text, expected, JSON.stringify(body));
    else assert.match(text, expected, JSON.stringify(body));
  }
});

test("a trailing slash in OPS_URL", async () => {
  gw.answer(200, { ok: true, data: 1 });
  assert.equal(await callOp(`${gw.url}/`, ctx, "ping", {}), "1");
  assert.equal(gw.requests.at(-1)?.url, "/internal/tenants/t_1/clusters/minikube/ops");
});

test("an unreachable gateway says why", async () => {
  const closed = createServer();
  await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
  const { port } = closed.address() as AddressInfo;
  await new Promise((resolve) => closed.close(resolve));
  const text = await callOp(`http://127.0.0.1:${port}`, ctx, "ping", {});
  assert.match(text, new RegExp(`^Error GATEWAY_ERROR: fetch failed: connect ECONNREFUSED 127\\.0\\.0\\.1:${port}$`));
});
