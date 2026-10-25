import * as z from "zod";

export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof EFFORTS)[number];
export const OPENAI_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type OpenAIEffort = (typeof OPENAI_EFFORTS)[number];

// Optional for OpenAI: only its reasoning models take an effort, and which values depends on the model.
export type ModelConfig =
  | { provider: "anthropic"; name: string; effort: Effort }
  | { provider: "openai"; name: string; effort?: OpenAIEffort };

export interface Config {
  host: string;
  port: number;
  gatewayUrl: string;
  agentGatewayToken: string;
  model: ModelConfig;
  maxModelCalls: number;
  internalApiToken: string;
}

const common = z.object({
  HOST: z.string().default("127.0.0.1"),
  PORT: z.coerce.number().int().positive().default(8090),
  GATEWAY_URL: z.url({ protocol: /^https?$/ }).default("http://127.0.0.1:8081"),
  AGENT_GATEWAY_TOKEN: z.string().min(32),
  MAX_MODEL_CALLS: z.coerce.number().int().positive().default(30),
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
  INTERNAL_API_TOKEN: z.string().min(32),
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
    MODEL_EFFORT: z.enum(OPENAI_EFFORTS).optional(),
  }),
]);

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const set = Object.fromEntries(Object.entries(env).filter(([, value]) => value !== ""));
  const parsed = envSchema.safeParse({ MODEL_PROVIDER: "anthropic", ...set });
  if (!parsed.success) throw new Error(z.prettifyError(parsed.error));

  const e = parsed.data;
  return {
    host: e.HOST,
    port: e.PORT,
    gatewayUrl: e.GATEWAY_URL,
    agentGatewayToken: e.AGENT_GATEWAY_TOKEN,
    model:
      e.MODEL_PROVIDER === "anthropic"
        ? { provider: "anthropic", name: e.ANTHROPIC_MODEL, effort: e.MODEL_EFFORT }
        : { provider: "openai", name: e.OPENAI_MODEL, ...(e.MODEL_EFFORT && { effort: e.MODEL_EFFORT }) },
    maxModelCalls: e.MAX_MODEL_CALLS,
    internalApiToken: e.INTERNAL_API_TOKEN,
  };
}
