import express, { type ErrorRequestHandler } from "express";
import { loadConfig, type Config } from "./config.ts";
import { log } from "./log.ts";

let config: Config;
try {
  config = loadConfig();
} catch (err) {
  log("error", "invalid configuration", { error: (err as Error).message });
  process.exit(1);
}

const app = express();
app.use(express.json({ limit: "1mb" })); 

app.use((_req, res) => {
  res.status(404).json({ error: "not found" });
});

app.use(((err, _req, res, next) => {
  if (res.headersSent) return next(err);
  if (!err.expose) log("error", "request failed", { error: err.stack ?? String(err) });
  res.status(err.status ?? 500).json({ error: err.expose ? err.message : "internal error" });
}) satisfies ErrorRequestHandler);

app.listen(config.port, "127.0.0.1", (err) => {
  if (err) {
    log("error", "cannot listen", { port: config.port, error: err.message });
    process.exit(1);
  }
  log("info", "agent service listening", { url: `http://127.0.0.1:${config.port}`, opsUrl: config.opsUrl, model: config.model });
});
