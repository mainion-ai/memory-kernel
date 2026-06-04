/**
 * Shared CLI utility helpers.
 *
 * Extracted from per-command copies so every command that needs a JSON-aware
 * error path (`--json`) gets the same behaviour. Keep this module small — it
 * should hold tiny, framework-agnostic helpers only.
 */

/**
 * JSON-aware error exit.
 *
 * Emits a structured `{ "error": message }` payload on stdout when `--json` is
 * active, otherwise writes a `✗ message` line to stderr. Always exits with
 * code 1 so callers can `await exitWithError(...)`-style without expecting
 * a return.
 */
export function exitWithError(message: string, json?: boolean): never {
  if (json) {
    console.log(JSON.stringify({ error: message }, null, 2));
  } else {
    console.error(`✗ ${message}`);
  }
  process.exit(1);
}
