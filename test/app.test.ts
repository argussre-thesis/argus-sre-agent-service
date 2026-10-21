import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
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

// A tenant of its own per test run, so rows left by an earlier run can't get in the way.
const tenant = `t_${randomUUID()}`;
const start = {
  incidentId: "inc_1",
  cluster: "prod-eu",
  title: "Pod is crash looping.",
  alerts: [{ status: "FIRING", startsAt: "2026-10-21T09:00:00Z", labels: { alertname: "KubePodCrashLooping" }, annotations: {} }],
};
const alert = start.alerts[0]!;
const token = "t".repeat(32);
const auth = { authorization: `Bearer ${token}` };
const report = '## Summary\nx\n## Evidence\n- No pods `list_pods {"namespace":"demo"}`';
const reportReply = () => new AIMessage({ content: report, response_metadata: { stop_reason: "end_turn" } });
const toolCallReply = () =>
  new AIMessage({ content: "", tool_calls: [{ name: "list_pods", args: { namespace: "demo" }, id: "call_1" }] });

async function serve(model: ReturnType<typeof fakeModel>) {
  const agent = createSreAgent(model, INVESTIGATION_PROMPT, createTools(gw.url), 30);
  const server = createApp({ agent, model: "fake:model", effort: "low", systemPrompt: INVESTIGATION_PROMPT, internalApiToken: token }).listen(0, "127.0.0.1");
  await once(server, "listening");
  after(() => new Promise((resolve) => server.close(resolve)));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const get = (path: string, tenantId = tenant) => fetch(`${url}/tenants/${tenantId}/investigations${path}`, { headers: auth });
  return {
    async post(body: unknown, headers: Record<string, string> = auth) {
      const res = await fetch(`${url}/tenants/${tenant}/investigations`, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: typeof body === "string" ? body : JSON.stringify(body),
      });
      if (res.status === 202) started.push((await res.clone().json()).data.id);
      return res;
    },
    get,
    url,
    async finished(id: string) {
      for (let i = 0; i < 200; i++) {
        const { data: inv } = await (await get(`/${id}`)).json();
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
    [{}, "VALIDATION_ERROR", /"incidentId"/],
    [{ ...start, incidentId: "" }, "VALIDATION_ERROR", /"incidentId"/],
    [{ ...start, cluster: 7 }, "VALIDATION_ERROR", /"cluster"/],
    [{ ...start, title: "" }, "VALIDATION_ERROR", /"title"/],
    [{ ...start, alerts: [] }, "VALIDATION_ERROR", /"alerts"/],
    [{ ...start, alerts: "down" }, "VALIDATION_ERROR", /"alerts"/],
    [{ ...start, alerts: [[]] }, "VALIDATION_ERROR", /"alerts"/],
    // An alert has the backend's fields and values.
    [{ ...start, alerts: [{ ...alert, status: "firing" }] }, "VALIDATION_ERROR", /"alerts"/],
    [{ ...start, alerts: [{ ...alert, startsAt: "yesterday" }] }, "VALIDATION_ERROR", /"alerts"/],
    [{ ...start, alerts: [{ ...alert, labels: { severity: 1 } }] }, "VALIDATION_ERROR", /"alerts"/],
    [{ ...start, alerts: [{ ...alert, annotations: undefined }] }, "VALIDATION_ERROR", /"alerts"/],
    [{ ...start, alerts: [{ ...alert, fingerprint: "abc" }] }, "VALIDATION_ERROR", /"alerts"/],
    [{ ...start, tenantId: "t_2" }, "VALIDATION_ERROR", /Unrecognized key: \\"tenantId\\"/],
    ['{"incidentId":', "INVALID_REQUEST_BODY", /JSON/],
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

test("a start answers 202 at once, the run goes on in the background, and the report and transcript are read", async () => {
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
  const { data: running } = await (await api.get(`/${id}`)).json();
  assert.deepEqual(running, {
    id,
    tenantId: tenant,
    cluster: "prod-eu",
    incidentId: "inc_1",
    model: "fake:model",
    effort: "low",
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
  assert.equal(gw.requests.at(-1)?.url, `/internal/tenants/${tenant}/clusters/prod-eu/ops`);
  assert.match(
    model.calls[0]!.messages[1]!.text,
    /^Current time: \d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z\nIncident in cluster "prod-eu", titled "Pod is crash looping.": 1 alert\(s\), 1 firing, 0 resolved\.\n.*\nKubePodCrashLooping: 1 firing/s,
  );
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
  // The transcript endpoint serves the stored messages as they are.
  const transcript = await (await api.get(`/${id}/messages`)).json();
  assert.deepEqual(
    transcript.data.messages.map((m: { seq: number; data: unknown }) => [m.seq, m.data]),
    row.messages.map((m) => [m.seq, m.data]),
  );
});

test("a run that fails is failed with its error, and the service keeps serving", async () => {
  const model = fakeModel().respond(new AIMessage({ content: "## Summary\nThe pods", response_metadata: { stop_reason: "max_tokens" } }));
  const api = await serve(model);

  const { id } = (await (await api.post({ ...start, incidentId: "inc_failed" })).json()).data;
  const failed = await api.finished(id);
  assert.equal(failed.status, "failed");
  assert.equal(failed.error, "run ended without a report (stop reason: max_tokens)");
  assert.equal(failed.report, null);
  assert.ok(failed.finishedAt);
  assert.equal((await api.get(`/${id}`)).status, 200);
});

test("one running investigation per incident: a second start is a 409 until it ends", async () => {
  const release = gw.hold();
  const model = fakeModel().respond(toolCallReply()).respond(reportReply()).respond(reportReply());
  const api = await serve(model);
  const body = { ...start, incidentId: "inc_busy" };

  // Two at once: the lock lets only one through.
  const [a, b] = await Promise.all([api.post(body), api.post(body)]);
  assert.deepEqual([a.status, b.status].sort(), [202, 409]);
  const { id } = (await (a.status === 202 ? a : b).json()).data;
  const busy = await (await api.post(body)).json();
  assert.deepEqual(busy, {
    success: false,
    error: { code: "INVESTIGATION_RUNNING", message: "This incident already has a running investigation", details: { id } },
  });

  release();
  await api.finished(id);
  const again = await api.post(body);
  assert.equal(again.status, 202);
  await api.finished((await again.json()).data.id);
});

test("an incident's investigations are listed newest first, and every read is scoped by tenant", async () => {
  const model = fakeModel().respond(reportReply()).respond(reportReply()).respond(reportReply());
  const api = await serve(model);
  const ids: string[] = [];
  for (const incidentId of ["inc_list", "inc_list", "inc_other"]) {
    const { id } = (await (await api.post({ ...start, incidentId })).json()).data;
    await api.finished(id);
    ids.push(id);
  }

  const { data } = await (await api.get("?incidentId=inc_list")).json();
  assert.deepEqual(
    data.investigations.map((i: { id: string }) => i.id),
    [ids[1], ids[0]],
  );
  assert.equal("systemPrompt" in data.investigations[0], false);

  const missing = await api.get("");
  assert.equal(missing.status, 400);
  assert.equal((await missing.json()).error.code, "QUERY_VALIDATION_ERROR");

  // Another tenant sees none of it.
  const other = `t_${randomUUID()}`;
  assert.deepEqual((await (await api.get("?incidentId=inc_list", other)).json()).data, { investigations: [] });
  for (const path of [`/${ids[0]}`, `/${ids[0]}/messages`]) {
    const res = await api.get(path, other);
    assert.equal(res.status, 404, path);
    assert.equal((await res.json()).error.code, "INVESTIGATION_NOT_FOUND");
  }
});

test("an unknown investigation or route is a JSON 404", async () => {
  const api = await serve(fakeModel());
  const cases: [string, string, string][] = [
    [`${api.url}/tenants/${tenant}/investigations/nope`, "INVESTIGATION_NOT_FOUND", "Investigation not found"],
    [`${api.url}/tenants/${tenant}/investigations/nope/messages`, "INVESTIGATION_NOT_FOUND", "Investigation not found"],
    [`${api.url}/investigations/nope`, "ROUTE_NOT_FOUND", "Route not found"],
  ];
  for (const [url, code, message] of cases) {
    const res = await fetch(url, { headers: auth });
    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), { success: false, error: { code, message, details: null } });
  }
});

test("without the internal token every route is a 401, and nothing starts", async () => {
  const model = fakeModel();
  const api = await serve(model);
  const unauthorized = { success: false, error: { code: "INVALID_INTERNAL_TOKEN", message: "Missing or invalid internal API token", details: null } };
  const headers: Record<string, string>[] = [{}, { authorization: token }, { authorization: `Bearer ${"x".repeat(32)}` }, { authorization: `Bearer ${token}x` }];
  for (const h of headers) {
    const res = await api.post(start, h);
    assert.equal(res.status, 401, JSON.stringify(h));
    assert.deepEqual(await res.json(), unauthorized);
  }
  for (const path of [`/tenants/${tenant}/investigations?incidentId=inc_1`, "/nope"]) {
    const res = await fetch(`${api.url}${path}`);
    assert.equal(res.status, 401, path);
  }
  // Checked before the body is parsed.
  assert.equal((await api.post("{broken", {})).status, 401);
  assert.equal(model.callCount, 0);
});
