// Runs the broken-workload scenarios through the running service (npm run dev), one at a time, and prints each report.
// Needs the dev gateway and the runner in minikube. Costs tokens. `npm run eval -- oom crashloop` runs only those.
import { setTimeout } from "node:timers/promises";
import { scenarios } from "./scenarios.ts";

const url = process.env.AGENT_URL ?? "http://127.0.0.1:8090";
const names = process.argv.slice(2);
const unknown = names.filter((n) => !scenarios.some((s) => s.name === n));
if (unknown.length > 0) {
  console.error(`unknown scenario: ${unknown.join(", ")} (known: ${scenarios.map((s) => s.name).join(", ")})`);
  process.exit(1);
}

for (const s of scenarios.filter((s) => names.length === 0 || names.includes(s.name))) {
  const res = await fetch(`${url}/tenants/t_dev/investigations`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    // incidentId marks eval runs in the database.
    body: JSON.stringify({
      incidentId: `eval-${s.name}`,
      cluster: "minikube",
      title: (s.alert.annotations as { summary: string }).summary,
      alerts: [{ ...s.alert, startsAt: new Date().toISOString() }],
    }),
  });
  const started = await res.json();
  if (!res.ok) throw new Error(`POST /investigations: ${res.status} ${JSON.stringify(started)}`);

  let inv;
  do {
    await setTimeout(2000);
    inv = (await (await fetch(`${url}/tenants/t_dev/investigations/${started.data.id}`)).json()).data;
  } while (inv.status === "running");

  const secs = (Date.parse(inv.finishedAt) - Date.parse(inv.startedAt)) / 1000;
  console.log(`\n=== ${s.name}: ${inv.status} in ${secs.toFixed(1)}s (${inv.id}, ${inv.model})`);
  console.log(`Expected: ${s.rootCause}\n\n${inv.report ?? `Error: ${inv.error}`}`);
}
