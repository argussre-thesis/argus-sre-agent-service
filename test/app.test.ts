import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { after, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { AIMessage, fakeModel } from "langchain";
import { createSreAgent } from "../src/agent.ts";
import { createApp } from "../src/app.ts";
import { getInvestigation } from "../src/investigations.ts";
import { INVESTIGATION_PROMPT } from "../src/prompts.ts";
import { createTools } from "../src/tools.ts";
import { fakeGateway } from "./helpers.ts";

const gw = await fakeGateway();
after(() => gw.close());

const start = { tenantId: "t_1", cluster: "prod-eu", incidentId: "inc_1", alert: { labels: { alertname: "KubePodCrashLooping" } } };
const report = '## Summary\nx\n## Evidence\n- No pods `list_pods {"namespace":"demo"}`';

async function serve(model: ReturnType<typeof fakeModel>) {
  const agent = createSreAgent(model, INVESTIGATION_PROMPT, createTools(gw.url), 30);
  const server = createApp({ agent, model: "fake:model" }).listen(0, "127.0.0.1");
  await once(server, "listening");
  after(() => new Promise((resolve) => server.close(resolve)));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    post: (body: unknown) =>
      fetch(`${url}/investigations`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: typeof body === "string" ? body : JSON.stringify(body),
      }),
    get: (path: string) => fetch(`${url}${path}`),
    async finished(id: string) {
      for (let i = 0; i < 200; i++) {
        const inv = await (await fetch(`${url}/investigations/${id}`)).json();
        if (inv.status !== "running") return inv;
        await sleep(10);
      }
      throw new Error(`investigation ${id} still running`);
    },
  };
}

test("a bad body is a 400 with the reason, and starts nothing", async () => {
  const model = fakeModel();
  const api = await serve(model);
  const cases: [unknown, RegExp][] = [
    [{}, /tenantId/],
    [{ ...start, tenantId: "" }, /tenantId/],
    [{ ...start, cluster: 7 }, /cluster/],
    [{ ...start, incidentId: "" }, /incidentId/],
    [{ ...start, alert: [] }, /alert/],
    [{ ...start, alert: "down" }, /alert/],
    [{ ...start, namespace: "demo" }, /Unrecognized key: "namespace"/],
    ['{"tenantId":', /JSON/],
  ];
  for (const [body, reason] of cases) {
    const res = await api.post(body);
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.match((await res.json()).error, reason);
  }
  assert.equal(model.callCount, 0);
});

test("a start answers 202 at once, the run goes on in the background, and the report is polled", async () => {
  const release = gw.hold();
  const model = fakeModel()
    .respond(new AIMessage({ content: "", tool_calls: [{ name: "list_pods", args: { namespace: "demo" }, id: "call_1" }] }))
    .respond(new AIMessage({ content: report, response_metadata: { stop_reason: "end_turn" } }));
  const api = await serve(model);

  const res = await api.post(start);
  assert.equal(res.status, 202);
  const { id } = await res.json();
  const running = await (await api.get(`/investigations/${id}`)).json();
  assert.deepEqual(running, {
    id,
    tenantId: "t_1",
    cluster: "prod-eu",
    incidentId: "inc_1",
    model: "fake:model",
    status: "running",
    startedAt: running.startedAt,
  });

  release();
  const done = await api.finished(id);
  assert.deepEqual(done, { ...running, status: "done", report, finishedAt: done.finishedAt });
  assert.ok(done.startedAt <= done.finishedAt);
  assert.equal(gw.requests.at(-1)?.url, "/internal/tenants/t_1/clusters/prod-eu/ops");
  assert.match(model.calls[0]!.messages[1]!.text, /^Alert from cluster "prod-eu":\n.*KubePodCrashLooping/s);
  assert.deepEqual(
    getInvestigation(id)!.messages.map((m) => m.type),
    ["human", "ai", "tool", "ai"],
  );
});

test("a run that fails is failed with its error, and the service keeps serving", async () => {
  const model = fakeModel().respond(new AIMessage({ content: "## Summary\nThe pods", response_metadata: { stop_reason: "max_tokens" } }));
  const api = await serve(model);

  const { id } = await (await api.post(start)).json();
  const failed = await api.finished(id);
  assert.equal(failed.status, "failed");
  assert.equal(failed.error, "run ended without a report (stop reason: max_tokens)");
  assert.equal(failed.report, undefined);
  assert.ok(failed.finishedAt);
  assert.equal((await api.get(`/investigations/${id}`)).status, 200);
});

test("an unknown investigation or route is a JSON 404", async () => {
  const api = await serve(fakeModel());
  const cases: [string, string][] = [
    ["/investigations/nope", "investigation not found"],
    ["/nope", "not found"],
  ];
  for (const [path, error] of cases) {
    const res = await api.get(path);
    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), { error });
  }
});
