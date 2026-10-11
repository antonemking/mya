/**
 * An environment for spawning the CLI that ignores the developer's own
 * settings, logins, and MYA_* variables. Empty strings count as unset.
 */
export function isolatedEnv(home, extra = {}) {
  return {
    ...process.env,
    MYA_HOME: home,
    MYA_SETTINGS_FILE: "",
    MYA_AUTH_FILE: "",
    MYA_PROVIDER: "",
    PI_PROVIDER: "",
    MYA_MODEL: "",
    PI_MODEL: "",
    MYA_NO_BROWSER: "1",
    ...extra,
  };
}
