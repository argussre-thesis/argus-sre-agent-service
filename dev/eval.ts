// Runs the broken-workload scenarios through the running service (npm run dev), one at a time, and prints each report.
// Needs the gateway and the runner in minikube. Costs tokens. `npm run eval -- oom crashloop` runs only those.
import { setTimeout } from "node:timers/promises";
import { scenarios } from "./scenarios.ts";

const url = process.env.AGENT_URL ?? "http://127.0.0.1:8090";
const authorization = `Bearer ${process.env.BACKEND_AGENT_SERVICE_TOKEN}`;
// The gateway answers any tenant but the runner token's org with RUNNER_OFFLINE.
const tenant = process.env.DEV_TENANT_ID;
if (!tenant) throw new Error("set DEV_TENANT_ID in .env: the org id (org_…) of the minikube runner's token");
const names = process.argv.slice(2);
const unknown = names.filter((n) => !scenarios.some((s) => s.name === n));
if (unknown.length > 0) {
  console.error(`unknown scenario: ${unknown.join(", ")} (known: ${scenarios.map((s) => s.name).join(", ")})`);
  process.exit(1);
}

for (const s of scenarios.filter((s) => names.length === 0 || names.includes(s.name))) {
  const res = await fetch(`${url}/api/v1/tenants/${tenant}/investigations`, {
    method: "POST",
    headers: { authorization, "content-type": "application/json" },
    // incidentId marks eval runs in the database.
    body: JSON.stringify({
      incidentId: `eval-${s.name}`,
      cluster: "minikube",
      title: s.alert.annotations.summary!,
      alerts: [{ status: "FIRING", startsAt: new Date().toISOString(), ...s.alert }],
    }),
  });
  const started = await res.json();
  if (!res.ok) throw new Error(`POST /investigations: ${res.status} ${JSON.stringify(started)}`);

  let inv;
  do {
    await setTimeout(2000);
    inv = (await (await fetch(`${url}/api/v1/tenants/${tenant}/investigations/${started.data.id}`, { headers: { authorization } })).json()).data;
  } while (inv.status === "running");

  const secs = (Date.parse(inv.finishedAt) - Date.parse(inv.startedAt)) / 1000;
  console.log(`\n=== ${s.name}: ${inv.status} in ${secs.toFixed(1)}s (${inv.id}, ${inv.model})`);
  console.log(`Expected: ${s.rootCause}\n\n${inv.report ?? `Error: ${inv.error}`}`);
}
