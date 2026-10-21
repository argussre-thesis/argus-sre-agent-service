import { createSreAgent } from "./agent/agent.ts";
import { createApp } from "./app/app.ts";
import { failInterruptedInvestigationsService } from "./app/model/investigationModel.ts";
import { loadConfig, type Config } from "./config.ts";
import { log } from "./log.ts";
import { chatModel } from "./agent/chatModel.ts";
import { INVESTIGATION_PROMPT } from "./agent/prompts.ts";
import { createTools } from "./agent/tools.ts";

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

const { name, model } = chatModel(config.model);
const agent = createSreAgent(model, INVESTIGATION_PROMPT, createTools(config.opsUrl), config.maxModelCalls);

createApp({ agent, model: name, systemPrompt: INVESTIGATION_PROMPT, internalApiToken: config.internalApiToken }).listen(config.port, "127.0.0.1", (err) => {
  if (err) {
    log("error", "cannot listen", { port: config.port, error: err.message });
    process.exit(1);
  }
  log("info", "agent service listening", { url: `http://127.0.0.1:${config.port}`, opsUrl: config.opsUrl, model: config.model });
});
