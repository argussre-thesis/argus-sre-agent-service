import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { after, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { AIMessage, fakeModel } from "langchain";
import { createApp } from "../src/app/app.ts";
import { prisma } from "../src/app/lib/prisma.ts";
import { CONVERSATION_PROMPT, INVESTIGATION_PROMPT } from "../src/agent/prompts.ts";
import { fakeMcpGateway } from "./helpers.ts";

const gw = await fakeMcpGateway();
after(() => gw.close());

// Fake backend: records every "ended" call and answers as the backend does.
const ended: { method?: string; url?: string; authorization?: string; contentType?: string; body: Record<string, unknown> }[] = [];
const backend = createServer(async (req, res) => {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  ended.push({ method: req.method, url: req.url, authorization: req.headers.authorization, contentType: req.headers["content-type"], body: JSON.parse(raw) });
  res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ success: true, data: { posted: true } }));
}).listen(0, "127.0.0.1");
await once(backend, "listening");
after(() => new Promise((resolve) => backend.close(resolve)));
const backendUrl = `http://127.0.0.1:${(backend.address() as AddressInfo).port}`;

const callsFor = (externalId: string) => ended.filter((c) => c.body.externalId === externalId);
async function endedCalls(externalId: string, count = 1) {
  for (let i = 0; i < 200; i++) {
    if (callsFor(externalId).length >= count) return callsFor(externalId);
    await sleep(10);
  }
  throw new Error(`the backend got ${callsFor(externalId).length} of ${count} calls for ${externalId}`);
}

// Tenants of their own per test run. Only the investigations are in the database: DATABASE_URL's, deleting only these tenants' rows.
const tenant = `t_${randomUUID()}`;
const otherTenant = `t_${randomUUID()}`;
after(async () => {
  await prisma.investigation.deleteMany({ where: { tenantId: { in: [tenant, otherTenant] } } });
  await prisma.$disconnect();
});

const token = "t".repeat(32);
const auth = { authorization: `Bearer ${token}` };
const thread = () => `C1:${randomUUID()}`;
const incident = (incidentId: string) => ({
  incidentId,
  cluster: "prod-eu",
  title: "Pod is crash looping.",
  alerts: [{ status: "FIRING", startsAt: "2026-10-21T09:00:00Z", labels: { alertname: "KubePodCrashLooping" }, annotations: {} }],
});
const investigation = async (incidentId: string, status: "running" | "done" | "failed", report: string | null, error: string | null, tenantId = tenant) => {
  await prisma.investigation.create({ data: { tenantId, cluster: "prod-eu", incidentId, model: "fake:model", systemPrompt: "x", status, report, error } });
  // startedAt orders the runs, so the next one must get a later time.
  await sleep(5);
};

const reply = (text: string) => new AIMessage({ content: text, response_metadata: { stop_reason: "end_turn" } });
const toolCall = () => new AIMessage({ content: "", tool_calls: [{ name: "list_pods", args: { namespace: "demo" }, id: "call_1" }] });

async function serve(model: ReturnType<typeof fakeModel>, backendAt = backendUrl) {
  const server = createApp({
    chatModel: model,
    model: "fake:model",
    effort: "low",
    systemPrompt: INVESTIGATION_PROMPT,
    conversationPrompt: CONVERSATION_PROMPT,
    maxModelCalls: 30,
    gatewayUrl: gw.url,
    agentGatewayToken: "a".repeat(32),
    backendUrl: backendAt,
    backendAgentServiceToken: token,
  }).listen(0, "127.0.0.1");
  await once(server, "listening");
  after(() => new Promise((resolve) => server.close(resolve)));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const send = (body: unknown, headers: Record<string, string> = auth) =>
    fetch(`${url}/api/v1/tenants/${tenant}/conversations/messages`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  return {
    send,
    // Sends a message and waits for its reply to reach the backend. Returns the one message the model got.
    async turn(body: { externalId: string; text: string; incident?: ReturnType<typeof incident> }) {
      const before = callsFor(body.externalId).length;
      const calls = model.callCount;
      assert.equal((await send(body)).status, 202);
      await endedCalls(body.externalId, before + 1);
      const [system, ...rest] = model.calls[calls]!.messages;
      assert.equal(system!.text, CONVERSATION_PROMPT);
      assert.equal(rest.length, 1);
      return rest[0]!.text;
    },
  };
}

test("a bad body is a 400 with the reason, and starts nothing", async () => {
  const model = fakeModel();
  const api = await serve(model);
  const good = { externalId: thread(), text: "how is it?" };
  const cases: [unknown, RegExp][] = [
    [{}, /"externalId"/],
    [{ ...good, externalId: "" }, /"externalId"/],
    [{ ...good, text: "" }, /"text"/],
    [{ ...good, clusters: "prod-eu" }, /"clusters"/],
    [{ ...good, clusters: [""] }, /"clusters"/],
    [{ ...good, incident: { ...incident("inc"), alerts: [] } }, /"incident"/],
    [{ ...good, tenantId: "t_2" }, /Unrecognized key: \\"tenantId\\"/],
  ];
  for (const [body, why] of cases) {
    const res = await api.send(body);
    assert.equal(res.status, 400, JSON.stringify(body));
    const { error } = await res.json();
    assert.equal(error.code, "VALIDATION_ERROR");
    assert.match(JSON.stringify(error), why);
  }
  assert.equal(model.callCount, 0);
});

test("it answers 202 at once, and the reply reaches the backend when the turn ends", async () => {
  const release = gw.hold();
  const model = fakeModel().respond(toolCall()).respond(reply("Healthy."));
  const api = await serve(model);
  const externalId = thread();

  const res = await api.send({ externalId, text: "how is it?", clusters: ["prod-eu"] });
  assert.equal(res.status, 202);
  assert.deepEqual(await res.json(), { success: true, message: "Message accepted", data: null });
  assert.equal(callsFor(externalId).length, 0);

  release();
  assert.deepEqual(await endedCalls(externalId), [
    {
      method: "POST",
      url: "/internal/v1/conversations/ended",
      authorization: `Bearer ${token}`,
      contentType: "application/json",
      body: { tenantId: tenant, externalId, status: "done", reply: "Healthy.", error: null },
    },
  ]);
  assert.equal(gw.requests.at(-1)?.url, `/mcp/tenants/${tenant}/clusters/prod-eu`);
});

test("outside an incident with no clusters: only the time, the clusters and the text, and no gateway", async () => {
  const api = await serve(fakeModel().respond(reply("No cluster is connected.")));
  const requests = gw.requests.length;
  const message = await api.turn({ externalId: thread(), text: "what can you do?" });
  assert.match(message, /^Current time: \S+Z\n\nClusters: none\n\nwhat can you do\?$/);
  assert.equal(gw.requests.length, requests);
});

test("in an incident's thread each turn has the alerts and the newest report, so a rerun's report is seen, and nothing carries over", async () => {
  const api = await serve(fakeModel().respond(reply("a")).respond(reply("b")));
  const incidentId = `inc_${randomUUID()}`;
  const body = { externalId: thread(), text: "why?", incident: incident(incidentId) };
  await investigation(incidentId, "done", "## Summary\nFirst run", null);

  const first = await api.turn(body);
  assert.match(first, /^Current time: .*Incident in cluster "prod-eu".*KubePodCrashLooping.*The investigation's report:\n## Summary\nFirst run\n\nClusters: none\n\nwhy\?$/s);

  await investigation(incidentId, "done", "## Summary\nThe rerun", null);
  const second = await api.turn({ ...body, text: "and now?" });
  assert.match(second, /The investigation's report:\n## Summary\nThe rerun\n\nClusters: none\n\nand now\?$/);
  assert.doesNotMatch(second, /First run|why\?/);
});

test("which report a turn gets: the newest finished one, never a running run or another tenant's", async () => {
  const cases: [string, ["running" | "done" | "failed", string | null, string | null][], string][] = [
    ["never ran", [], "No investigation has finished"],
    ["only running", [["running", null, null]], "No investigation has finished"],
    ["failed", [["failed", null, "call limit"]], "The investigation failed, so there is no report: call limit"],
    ["failed, rerun running", [["failed", null, "call limit"], ["running", null, null]], "The investigation failed, so there is no report: call limit"],
    ["report, then a failure", [["done", "OOM", null], ["failed", null, "call limit"]], "The investigation's report:\nOOM"],
    ["report, rerun running", [["done", "OOM", null], ["running", null, null]], "The investigation's report:\nOOM"],
  ];
  const model = fakeModel();
  for (let i = 0; i <= cases.length; i++) model.respond(reply("x"));
  const api = await serve(model);

  for (const [name, runs, expected] of cases) {
    const incidentId = `inc_${randomUUID()}`;
    for (const [status, report, error] of runs) await investigation(incidentId, status, report, error);
    const message = await api.turn({ externalId: thread(), text: "why?", incident: incident(incidentId) });
    assert.ok(message.includes(expected), name);
  }

  const theirs = `inc_${randomUUID()}`;
  await investigation(theirs, "done", "Their report", null, otherTenant);
  const message = await api.turn({ externalId: thread(), text: "why?", incident: incident(theirs) });
  assert.doesNotMatch(message, /Their report/);
  assert.match(message, /No investigation has finished/);
});

test("a turn that fails tells the backend why", async () => {
  const api = await serve(fakeModel().respond(new AIMessage({ content: "The pods", response_metadata: { stop_reason: "max_tokens" } })));
  const externalId = thread();
  assert.equal((await api.send({ externalId, text: "how is it?" })).status, 202);
  const [call] = await endedCalls(externalId);
  assert.deepEqual(call!.body, {
    tenantId: tenant,
    externalId,
    status: "failed",
    reply: null,
    error: "run ended without a report (stop reason: max_tokens)",
  });
});

test("known drawback: two messages at once in a thread both run and both answer", async () => {
  const model = fakeModel().respond(reply("a")).respond(reply("b"));
  const api = await serve(model);
  const body = { externalId: thread(), text: "how is it?" };
  const both = await Promise.all([api.send(body), api.send(body)]);
  assert.deepEqual(both.map((r) => r.status), [202, 202]);
  assert.equal((await endedCalls(body.externalId, 2)).length, 2);
  assert.equal(model.callCount, 2);
});

test("a backend that can't be reached loses the reply, and the service keeps serving", async () => {
  const model = fakeModel().respond(reply("a")).respond(reply("b"));
  const api = await serve(model, "http://127.0.0.1:1");
  assert.equal((await api.send({ externalId: thread(), text: "one" })).status, 202);
  for (let i = 0; i < 200 && model.callCount === 0; i++) await sleep(10);
  await sleep(50);
  assert.equal((await api.send({ externalId: thread(), text: "two" })).status, 202);
});

test("without the internal token nothing starts", async () => {
  const model = fakeModel();
  const api = await serve(model);
  assert.equal((await api.send({ externalId: thread(), text: "hi" }, { authorization: "Bearer wrong" })).status, 401);
  assert.equal(model.callCount, 0);
});
