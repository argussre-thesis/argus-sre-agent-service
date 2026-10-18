import { createSreAgent } from "./agent.ts";
import { createApp } from "./app.ts";
import { loadConfig, type Config } from "./config.ts";
import { log } from "./log.ts";
import { chatModel } from "./model.ts";
import { INVESTIGATION_PROMPT } from "./prompts.ts";
import { createTools } from "./tools.ts";

let config: Config;
try {
  config = loadConfig();
} catch (err) {
  log("error", "invalid configuration", { error: (err as Error).message });
  process.exit(1);
}

const { name, model } = chatModel(config.model);
const agent = createSreAgent(model, INVESTIGATION_PROMPT, createTools(config.opsUrl), config.maxModelCalls);

createApp({ agent, model: name }).listen(config.port, "127.0.0.1", (err) => {
  if (err) {
    log("error", "cannot listen", { port: config.port, error: err.message });
    process.exit(1);
  }
  log("info", "agent service listening", { url: `http://127.0.0.1:${config.port}`, opsUrl: config.opsUrl, model: config.model });
});
