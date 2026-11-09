// One real investigation from the command line, before the HTTP API (step 5): each step as it happens, then the report.
// Needs the gateway (`npm run dev` in argus-sre-gateway/) and the runner in minikube. Costs tokens.
import { AIMessage, HumanMessage, ToolMessage } from "langchain";
import { runWithGateway } from "../src/agent/sreAgent.ts";
import { LEVELS, loadConfig, type Level } from "../src/config.ts";
import { chatModel } from "../src/agent/chatModel.ts";
import { incidentMessage, INVESTIGATION_PROMPT } from "../src/agent/prompts.ts";

const alert = {
  status: "FIRING" as const,
  labels: { alertname: "KubePodCrashLooping", severity: "warning", namespace: "demo", pod: "crashloop-68784d8c77-sbnvd", container: "app" },
  annotations: {
    summary: "Pod is crash looping.",
    description: 'Pod demo/crashloop-68784d8c77-sbnvd (app) is in waiting state (reason: "CrashLoopBackOff").',
  },
  startsAt: "2026-10-18T16:00:00Z",
};

const config = loadConfig();
// The gateway answers any tenant but the runner token's org with RUNNER_OFFLINE.
const tenantId = process.env.DEV_TENANT_ID;
if (!tenantId) throw new Error("set DEV_TENANT_ID in .env: the org id (org_…) of the minikube runner's token");
const level = (process.env.DEV_LEVEL || "low") as Level;
if (!LEVELS.includes(level)) throw new Error(`DEV_LEVEL must be one of ${LEVELS.join(", ")}`);
const { name, model, effort } = chatModel(config.models[level]);
console.log(`${level}: ${name}${effort ? `, effort ${effort}` : ""}, at most ${config.maxModelCalls} model calls\n`);

const totals = { calls: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
const started = Date.now();
const report = await runWithGateway(
  model,
  INVESTIGATION_PROMPT,
  config.maxModelCalls,
  config.gatewayUrl,
  config.agentGatewayToken,
  [incidentMessage({ cluster: "minikube", title: alert.annotations.summary, alerts: [alert] })],
  tenantId,
  ["minikube"],
  [],
  async (added) => {
    for (const m of added) {
      if (ToolMessage.isInstance(m)) console.log(`  -> ${m.name}: ${m.status === "error" ? m.text : `${m.text.length} chars`}`);
      if (HumanMessage.isInstance(m)) console.log(`  citation fix requested:\n${m.text}`);
      const u = AIMessage.isInstance(m) ? m.usage_metadata : undefined;
      if (!u) continue;
      totals.calls++;
      totals.input += u.input_tokens;
      totals.cacheRead += u.input_token_details?.cache_read ?? 0;
      totals.cacheWrite += u.input_token_details?.cache_creation ?? 0;
      totals.output += u.output_tokens;
    }
  },
);
console.log(`\n${((Date.now() - started) / 1000).toFixed(1)}s, tokens:`, totals, `\n\n${report}`);
