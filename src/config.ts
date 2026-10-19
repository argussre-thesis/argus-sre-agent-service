import * as z from "zod";

export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof EFFORTS)[number];

// OpenAI has no effort setting here: it runs on its defaults.
export type ModelConfig = { provider: "anthropic"; name: string; effort: Effort } | { provider: "openai"; name: string };

export interface Config {
  port: number;
  opsUrl: string;
  model: ModelConfig;
  maxModelCalls: number;
}

const common = z.object({
  PORT: z.coerce.number().int().positive().default(8090),
  OPS_URL: z.url({ protocol: /^https?$/ }).default("http://127.0.0.1:8081"),
  MAX_MODEL_CALLS: z.coerce.number().int().positive().default(30),
});

const envSchema = z.discriminatedUnion("MODEL_PROVIDER", [
  common.extend({
    MODEL_PROVIDER: z.literal("anthropic"),
    ANTHROPIC_API_KEY: z.string(),
    ANTHROPIC_MODEL: z.string().default("claude-opus-5-5"),
    MODEL_EFFORT: z.enum(EFFORTS).default("high"),
  }),
  common.extend({
    MODEL_PROVIDER: z.literal("openai"),
    OPENAI_API_KEY: z.string(),
    OPENAI_MODEL: z.string(),
  }),
]);

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const set = Object.fromEntries(Object.entries(env).filter(([, value]) => value !== ""));
  const parsed = envSchema.safeParse({ MODEL_PROVIDER: "anthropic", ...set });
  if (!parsed.success) throw new Error(z.prettifyError(parsed.error));

  const e = parsed.data;
  return {
    port: e.PORT,
    opsUrl: e.OPS_URL,
    model:
      e.MODEL_PROVIDER === "anthropic"
        ? { provider: "anthropic", name: e.ANTHROPIC_MODEL, effort: e.MODEL_EFFORT }
        : { provider: "openai", name: e.OPENAI_MODEL },
    maxModelCalls: e.MAX_MODEL_CALLS,
  };
}
