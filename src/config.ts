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

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const required = (name: string): string => {
    const value = env[name];
    if (!value) throw new Error(`Missing required environment variable ${name}`);
    return value;
  };

  const httpUrl = (name: string, value: string): string => {
    const protocol = URL.parse(value)?.protocol;
    if (protocol !== "http:" && protocol !== "https:") {
      throw new Error(`${name} must start with http:// or https://, got "${value}"`);
    }
    return value;
  };

  const positiveInt = (name: string, fallback: number): number => {
    const value = env[name];
    if (!value) return fallback;
    const n = Number(value);
    if (!Number.isInteger(n) || n < 1) throw new Error(`${name} must be a positive whole number, got "${value}"`);
    return n;
  };

  const oneOf = <T extends string>(name: string, allowed: readonly T[], fallback: T): T => {
    const value = env[name] || fallback;
    if (!allowed.includes(value as T)) throw new Error(`${name} must be one of ${allowed.join(", ")}, got "${value}"`);
    return value as T;
  };

  const provider = oneOf("MODEL_PROVIDER", ["anthropic", "openai"], "anthropic");
  let model: ModelConfig;
  if (provider === "anthropic") {
    required("ANTHROPIC_API_KEY"); // only checked: ChatAnthropic reads it from the environment itself
    model = { provider, name: env.ANTHROPIC_MODEL || "claude-opus-5-5", effort: oneOf("MODEL_EFFORT", EFFORTS, "high") };
  } else {
    required("OPENAI_API_KEY");
    model = { provider, name: required("OPENAI_MODEL") };
  }

  return {
    port: positiveInt("PORT", 8090),
    opsUrl: httpUrl("OPS_URL", env.OPS_URL || "http://127.0.0.1:8081"),
    model,
    maxModelCalls: positiveInt("MAX_MODEL_CALLS", 30),
  };
}
