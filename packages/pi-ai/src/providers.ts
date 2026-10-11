import { AnthropicClient, type AnthropicClientOptions } from "./anthropic.js";
import { OpenAiCodexClient, type OpenAiCodexClientOptions } from "./codex.js";
import { OpenAiClient, type OpenAiClientOptions } from "./openai.js";
import type { ModelClient } from "./types.js";

/**
 * The only thing outside this package needs to know is a name. Keys, logins,
 * URLs, and request bodies stay behind it.
 */
export const providerNames = ["anthropic", "openai", "openai-codex"] as const;
export type ProviderName = (typeof providerNames)[number];

export interface CreateClientOptions
  extends Omit<AnthropicClientOptions, "fetch">,
    Omit<OpenAiClientOptions, "fetch">,
    Omit<OpenAiCodexClientOptions, "fetch"> {
  fetch?: typeof fetch;
}

export class UnknownProviderError extends Error {
  constructor(name: string) {
    super(`unknown provider: ${name}. Known providers: ${providerNames.join(", ")}`);
    this.name = "UnknownProviderError";
  }
}

export function isProviderName(name: string): name is ProviderName {
  return (providerNames as readonly string[]).includes(name);
}

export function defaultProvider(): ProviderName {
  const fromEnv = process.env.MYA_PROVIDER || process.env.PI_PROVIDER;
  return fromEnv && isProviderName(fromEnv) ? fromEnv : "anthropic";
}

export function createModelClient(name: string = defaultProvider(), options: CreateClientOptions = {}): ModelClient {
  switch (name) {
    case "anthropic":
      return new AnthropicClient(options);
    case "openai":
      return new OpenAiClient(options);
    case "openai-codex":
      return new OpenAiCodexClient(options);
    default:
      throw new UnknownProviderError(name);
  }
}
