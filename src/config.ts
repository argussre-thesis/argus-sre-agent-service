import * as z from "zod";

export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof EFFORTS)[number];
export const OPENAI_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type OpenAIEffort = (typeof OPENAI_EFFORTS)[number];
export const LEVELS = ["low", "medium", "high"] as const;
export type Level = (typeof LEVELS)[number];

// Optional for OpenAI: only its reasoning models take an effort, and which values depends on the model.
export type ModelConfig =
  | { provider: "anthropic"; name: string; effort: Effort }
  | { provider: "openai"; name: string; effort?: OpenAIEffort };

export interface Config {
  host: string;
  port: number;
  gatewayUrl: string;
  agentGatewayToken: string;
  models: Record<Level, ModelConfig>;
  maxModelCalls: number;
  backendAgentServiceToken: string;
  backendUrl: string;
}

const common = z.object({
  HOST: z.string().default("127.0.0.1"),
  PORT: z.coerce.number().int().positive().default(8090),
  GATEWAY_URL: z.url({ protocol: /^https?$/ }).default("http://127.0.0.1:8081"),
  AGENT_GATEWAY_TOKEN: z.string().min(32),
  MAX_MODEL_CALLS: z.coerce.number().int().positive().default(30),
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
  BACKEND_AGENT_SERVICE_TOKEN: z.string().min(32),
  BACKEND_URL: z.url({ protocol: /^https?$/ }),
});

const envSchema = z.discriminatedUnion("MODEL_PROVIDER", [
  common.extend({
    MODEL_PROVIDER: z.literal("anthropic"),
    ANTHROPIC_API_KEY: z.string(),
    LOW_MODEL: z.string().default("claude-haiku-5-5"),
    LOW_EFFORT: z.enum(EFFORTS).default("medium"),
    MEDIUM_MODEL: z.string().default("claude-sonnet-5-5"),
    MEDIUM_EFFORT: z.enum(EFFORTS).default("high"),
    HIGH_MODEL: z.string().default("claude-opus-5-5"),
    HIGH_EFFORT: z.enum(EFFORTS).default("high"),
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
  let models: Record<Level, ModelConfig>;
  if (e.MODEL_PROVIDER === "anthropic") {
    models = {
      low: { provider: "anthropic", name: e.LOW_MODEL, effort: e.LOW_EFFORT },
      medium: { provider: "anthropic", name: e.MEDIUM_MODEL, effort: e.MEDIUM_EFFORT },
      high: { provider: "anthropic", name: e.HIGH_MODEL, effort: e.HIGH_EFFORT },
    };
  } else {
    const openai: ModelConfig = { provider: "openai", name: e.OPENAI_MODEL, ...(e.MODEL_EFFORT && { effort: e.MODEL_EFFORT }) };
    models = { low: openai, medium: openai, high: openai };
  }
  return {
    host: e.HOST,
    port: e.PORT,
    gatewayUrl: e.GATEWAY_URL,
    agentGatewayToken: e.AGENT_GATEWAY_TOKEN,
    models,
    maxModelCalls: e.MAX_MODEL_CALLS,
    backendAgentServiceToken: e.BACKEND_AGENT_SERVICE_TOKEN,
    backendUrl: e.BACKEND_URL,
  };
}
