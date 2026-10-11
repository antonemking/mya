import { loginOpenAiCodex, type AuthInteraction, type CodexLoginOptions } from "./openai-codex.js";
import { CredentialStore, type OAuthCredential } from "./store.js";

/**
 * Providers that sign in with a subscription instead of an API key. The CLI
 * passes a name and an interaction; everything else stays in this package.
 */
export const oauthProviders = ["openai-codex"] as const;
export type OAuthProviderName = (typeof oauthProviders)[number];

export type LoginMethod = "browser" | "device";

export interface LoginOptions {
  method?: LoginMethod;
  store?: CredentialStore;
  /** Test hooks. */
  authBaseUrl?: string;
  callbackPort?: number;
  fetch?: typeof fetch;
}

export function isOAuthProvider(name: string): name is OAuthProviderName {
  return (oauthProviders as readonly string[]).includes(name);
}

export async function login(
  provider: string,
  interaction: AuthInteraction,
  options: LoginOptions = {},
): Promise<OAuthCredential> {
  if (!isOAuthProvider(provider)) {
    throw new Error(`${provider} does not use a subscription login. Known: ${oauthProviders.join(", ")}`);
  }
  const codexOptions: CodexLoginOptions = {
    ...(options.method ? { method: options.method } : {}),
    ...(options.authBaseUrl ? { authBaseUrl: options.authBaseUrl } : {}),
    ...(options.callbackPort ? { callbackPort: options.callbackPort } : {}),
    ...(options.fetch ? { fetch: options.fetch } : {}),
  };
  const credential = await loginOpenAiCodex(interaction, codexOptions);
  (options.store ?? new CredentialStore()).set(provider, credential);
  return credential;
}

export function logout(provider: string, store: CredentialStore = new CredentialStore()): boolean {
  return store.delete(provider);
}

export interface AuthStatus {
  provider: string;
  accountId?: string;
  email?: string;
  expires: number;
}

/** What is signed in, without the secrets. */
export function authStatus(store: CredentialStore = new CredentialStore()): AuthStatus[] {
  return store.list().map(({ provider, credential }) => ({
    provider,
    ...(credential.accountId ? { accountId: credential.accountId } : {}),
    ...(credential.email ? { email: credential.email } : {}),
    expires: credential.expires,
  }));
}

export { CredentialStore, defaultAuthFile, myaHome } from "./store.js";
export type { Credential, OAuthCredential } from "./store.js";
export type { AuthInteraction } from "./openai-codex.js";
export { decodeJwt, parseManualInput, refreshOpenAiCodex } from "./openai-codex.js";
