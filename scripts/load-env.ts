/**
 * Load `.env`, when there is one.
 *
 * The scripts read `process.env`, and the operator's values (a PAT, a bot
 * token, the service's address) live in one file — which is what `.env` is
 * for and why `.gitignore` holds it. A missing file is not an error: the
 * environment is the other place values come from, and this is the one that
 * is convenient.
 */
export function loadEnvFile(path = ".env"): void {
  try {
    process.loadEnvFile(path);
  } catch {
    // No `.env` here; the environment is the configuration.
  }
}
