import { createApp } from "./app/app.ts";
import { failInterruptedInvestigationsService } from "./app/model/investigationModel.ts";
import { loadConfig, type Config } from "./config.ts";
import { log } from "./log.ts";
import { chatModel } from "./agent/chatModel.ts";
import { INVESTIGATION_PROMPT } from "./agent/prompts.ts";

let config: Config;
try {
  config = loadConfig();
} catch (err) {
  log("error", "invalid configuration", { error: (err as Error).message });
  process.exit(1);
}

// Also checks the database at startup: without it nothing can be saved.
try {
  const count = await failInterruptedInvestigationsService();
  if (count > 0) log("warn", "interrupted investigations marked failed", { count });
} catch (err) {
  log("error", "cannot reach the database", { error: (err as Error).message });
  process.exit(1);
}

const { name, model, effort } = chatModel(config.model);
if (config.model.effort && !effort) log("warn", "MODEL_EFFORT ignored: this model takes no effort", { model: name });

createApp({
  chatModel: model,
  model: name,
  effort,
  systemPrompt: INVESTIGATION_PROMPT,
  maxModelCalls: config.maxModelCalls,
  gatewayUrl: config.gatewayUrl,
  agentGatewayToken: config.agentGatewayToken,
  backendUrl: config.backendUrl,
  backendAgentServiceToken: config.backendAgentServiceToken,
}).listen(config.port, config.host, (err) => {
  if (err) {
    log("error", "cannot listen", { host: config.host, port: config.port, error: err.message });
    process.exit(1);
  }
  log("info", "agent service listening", { url: `http://${config.host}:${config.port}`, gatewayUrl: config.gatewayUrl, backendUrl: config.backendUrl, model: config.model });
});

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    log("info", "shutting down", { signal });
    process.exit(0);
  });
}
