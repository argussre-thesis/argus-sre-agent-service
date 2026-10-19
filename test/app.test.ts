import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { after, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { mapStoredMessagesToChatMessages, type StoredMessage } from "@langchain/core/messages";
import { AIMessage, fakeModel } from "langchain";
import { createSreAgent } from "../src/agent/agent.ts";
import { createApp } from "../src/app/app.ts";
import { prisma } from "../src/app/lib/prisma.ts";
import { INVESTIGATION_PROMPT } from "../src/agent/prompts.ts";
import { createTools } from "../src/agent/tools.ts";
import { fakeGateway } from "./helpers.ts";

const gw = await fakeGateway();
after(() => gw.close());

// shortcut: no test database, these tests use DATABASE_URL's (.env) and delete only what they started; a test database for CI.
const started: string[] = [];
after(async () => {
  await prisma.investigation.deleteMany({ where: { id: { in: started } } });
  await prisma.$disconnect();
});

const start = { tenantId: "t_1", cluster: "prod-eu", incidentId: "inc_1", alert: { labels: { alertname: "KubePodCrashLooping" } } };
const report = '## Summary\nx\n## Evidence\n- No pods `list_pods {"namespace":"demo"}`';

async function serve(model: ReturnType<typeof fakeModel>) {
  const agent = createSreAgent(model, INVESTIGATION_PROMPT, createTools(gw.url), 30);
  const server = createApp({ agent, model: "fake:model", systemPrompt: INVESTIGATION_PROMPT }).listen(0, "127.0.0.1");
  await once(server, "listening");
  after(() => new Promise((resolve) => server.close(resolve)));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    async post(body: unknown) {
      const res = await fetch(`${url}/investigations`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: typeof body === "string" ? body : JSON.stringify(body),
      });
      if (res.status === 202) started.push((await res.clone().json()).data.id);
      return res;
    },
    get: (path: string) => fetch(`${url}${path}`),
    async finished(id: string) {
      for (let i = 0; i < 200; i++) {
        const { data: inv } = await (await fetch(`${url}/investigations/${id}`)).json();
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
  // The reason is matched in the error as JSON: the field's name in fieldErrors, or the message.
  const cases: [unknown, string, RegExp][] = [
    [{}, "VALIDATION_ERROR", /"tenantId"/],
    [{ ...start, tenantId: "" }, "VALIDATION_ERROR", /"tenantId"/],
    [{ ...start, cluster: 7 }, "VALIDATION_ERROR", /"cluster"/],
    [{ ...start, incidentId: "" }, "VALIDATION_ERROR", /"incidentId"/],
    [{ ...start, alert: [] }, "VALIDATION_ERROR", /"alert"/],
    [{ ...start, alert: "down" }, "VALIDATION_ERROR", /"alert"/],
    [{ ...start, namespace: "demo" }, "VALIDATION_ERROR", /Unrecognized key: \\"namespace\\"/],
    ['{"tenantId":', "INVALID_REQUEST_BODY", /JSON/],
  ];
  for (const [body, code, reason] of cases) {
    const res = await api.post(body);
    assert.equal(res.status, 400, JSON.stringify(body));
    const { success, error } = await res.json();
    assert.deepEqual([success, error.code], [false, code], JSON.stringify(body));
    assert.match(JSON.stringify(error), reason);
  }
  assert.equal(model.callCount, 0);
});

test("a start answers 202 at once, the run goes on in the background, and the report is polled", async () => {
  const release = gw.hold();
  // Usage as LangChain gives it (input_tokens include the cached ones), from a real run.
  const usage = (input: number, cacheRead: number, cacheWrite: number, output: number) => ({
    input_tokens: input,
    output_tokens: output,
    total_tokens: input + output,
    input_token_details: { cache_read: cacheRead, cache_creation: cacheWrite },
  });
  const model = fakeModel()
    .respond(
      new AIMessage({
        content: "",
        tool_calls: [{ name: "list_pods", args: { namespace: "demo" }, id: "call_1" }],
        usage_metadata: usage(1561, 0, 0, 100),
      }),
    )
    .respond(
      new AIMessage({ content: report, response_metadata: { stop_reason: "end_turn" }, usage_metadata: usage(5081, 3588, 1489, 2011) }),
    );
  const api = await serve(model);

  const res = await api.post(start);
  assert.equal(res.status, 202);
  const started = await res.json();
  const { id } = started.data;
  assert.deepEqual(started, { success: true, message: "Investigation started", data: { id } });
  const { data: running } = await (await api.get(`/investigations/${id}`)).json();
  assert.deepEqual(running, {
    id,
    tenantId: "t_1",
    cluster: "prod-eu",
    incidentId: "inc_1",
    model: "fake:model",
    status: "running",
    report: null,
    error: null,
    startedAt: running.startedAt,
    finishedAt: null,
  });

  release();
  const done = await api.finished(id);
  assert.deepEqual(done, { ...running, status: "done", report, finishedAt: done.finishedAt });
  assert.ok(done.startedAt <= done.finishedAt);
  assert.equal(gw.requests.at(-1)?.url, "/internal/tenants/t_1/clusters/prod-eu/ops");
  assert.match(model.calls[0]!.messages[1]!.text, /^Current time: \d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z\nAlert from cluster "prod-eu":\n.*KubePodCrashLooping/s);
  // Stored with the prompt it ran with, and every message in order, loadable as LangChain messages again.
  const row = await prisma.investigation.findUniqueOrThrow({ where: { id }, include: { messages: { orderBy: { seq: "asc" } } } });
  assert.equal(row.systemPrompt, INVESTIGATION_PROMPT);
  const messages = mapStoredMessagesToChatMessages(row.messages.map((m) => m.data as unknown as StoredMessage));
  assert.deepEqual(
    messages.map((m) => m.type),
    ["human", "ai", "tool", "ai"],
  );
  assert.equal(messages.at(-1)!.text, report);
  // Tokens on the AI messages only, in four parts that don't overlap.
  assert.deepEqual(
    row.messages.map((m) => [m.model, m.uncachedInputTokens, m.cacheWriteTokens, m.cacheReadTokens, m.outputTokens]),
    [
      [null, null, null, null, null],
      ["fake:model", 1561, 0, 0, 100],
      [null, null, null, null, null],
      ["fake:model", 4, 1489, 3588, 2011],
    ],
  );
});

test("a run that fails is failed with its error, and the service keeps serving", async () => {
  const model = fakeModel().respond(new AIMessage({ content: "## Summary\nThe pods", response_metadata: { stop_reason: "max_tokens" } }));
  const api = await serve(model);

  const { id } = (await (await api.post(start)).json()).data;
  const failed = await api.finished(id);
  assert.equal(failed.status, "failed");
  assert.equal(failed.error, "run ended without a report (stop reason: max_tokens)");
  assert.equal(failed.report, null);
  assert.ok(failed.finishedAt);
  assert.equal((await api.get(`/investigations/${id}`)).status, 200);
});

test("an unknown investigation or route is a JSON 404", async () => {
  const api = await serve(fakeModel());
  const cases: [string, string, string][] = [
    ["/investigations/nope", "INVESTIGATION_NOT_FOUND", "Investigation not found"],
    ["/nope", "ROUTE_NOT_FOUND", "Route not found"],
  ];
  for (const [path, code, message] of cases) {
    const res = await api.get(path);
    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), { success: false, error: { code, message, details: null } });
  }
});
