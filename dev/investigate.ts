// One real investigation from the command line, before the HTTP API (step 5): each step as it happens, then the report.
// Needs the dev gateway (`npm run dev:gateway` in argus-sre-runner/) and the runner in minikube. Costs tokens.
import { AIMessage, HumanMessage, ToolMessage } from "langchain";
import { createSreAgent, runAgent } from "../src/agent/agent.ts";
import { loadConfig } from "../src/config.ts";
import { chatModel } from "../src/agent/chatModel.ts";
import { incidentMessage, INVESTIGATION_PROMPT } from "../src/agent/prompts.ts";
import { createTools } from "../src/agent/tools.ts";

// Shaped like an Alertmanager webhook alert from kube-prometheus' KubePodCrashLooping rule.
const alert = {
  status: "firing",
  labels: { alertname: "KubePodCrashLooping", severity: "warning", namespace: "demo", pod: "crashloop-68784d8c77-sbnvd", container: "app" },
  annotations: {
    summary: "Pod is crash looping.",
    description: 'Pod demo/crashloop-68784d8c77-sbnvd (app) is in waiting state (reason: "CrashLoopBackOff").',
  },
  startsAt: "2026-10-18T16:00:00Z",
};

const config = loadConfig();
const { name, model } = chatModel(config.model);
const agent = createSreAgent(model, INVESTIGATION_PROMPT, createTools(config.opsUrl), config.maxModelCalls);
console.log(`${name}${"effort" in config.model ? `, effort ${config.model.effort}` : ""}, at most ${config.maxModelCalls} model calls\n`);

const totals = { calls: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
const started = Date.now();
const report = await runAgent(
  agent,
  [incidentMessage({ cluster: "minikube", title: alert.annotations.summary, alerts: [alert] })],
  { tenantId: "t_dev", cluster: "minikube" },
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
