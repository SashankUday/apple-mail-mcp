/**
 * Server configuration: account exclusion.
 *
 * An excluded account is invisible to every tool in this server. Two layers
 * enforce that, because they fail in different ways:
 *
 *   1. AppleScript-level filtering, for the tools that enumerate accounts
 *      themselves (list_mailboxes, unscoped search_messages, total
 *      get_unread_count). The generated script skips the account, so its
 *      messages never enter the result set in the first place.
 *
 *   2. A TypeScript guard, for the tools that take an explicit account name.
 *      These never enumerate, so filtering the script would do nothing —
 *      the guard rejects the call before any osascript runs.
 *
 * Layer 1 without layer 2 leaks via a direct request; layer 2 without layer 1
 * leaks via a broad search. Both are required.
 */

const ENV_VAR = "APPLE_MAIL_EXCLUDE_ACCOUNTS";
const CLI_FLAG = "--exclude-accounts";

/**
 * Parse the exclusion list from CLI args and environment.
 *
 * CLI accepts both `--exclude-accounts A,B` and `--exclude-accounts=A,B`, and
 * may be repeated. The environment variable is comma-separated. The two
 * sources are merged rather than one overriding the other: an exclusion is a
 * safety constraint, so the union is the conservative reading.
 */
export function parseExcludedAccounts(
  argv: string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env
): string[] {
  const raw: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === CLI_FLAG) {
      // Guard against a trailing flag with no value, and against swallowing
      // the next flag as if it were a value.
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        raw.push(next);
        i++;
      }
    } else if (arg.startsWith(`${CLI_FLAG}=`)) {
      raw.push(arg.slice(CLI_FLAG.length + 1));
    }
  }

  const fromEnv = env[ENV_VAR];
  if (fromEnv) raw.push(fromEnv);

  const names = raw
    .flatMap((value) => value.split(","))
    .map((name) => name.trim())
    .filter((name) => name.length > 0);

  // De-duplicate case-insensitively, keeping the first spelling seen so error
  // messages echo what the user actually configured.
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const name of names) {
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(name);
  }
  return unique;
}

/** Excluded account names, resolved once at module load. */
export const EXCLUDED_ACCOUNTS: string[] = parseExcludedAccounts();

const EXCLUDED_KEYS = new Set(EXCLUDED_ACCOUNTS.map((name) => name.toLowerCase()));

/**
 * True when this account is excluded.
 *
 * Matching is case-insensitive, which mirrors AppleScript's own string
 * comparison — so the TypeScript guard and the generated script agree on what
 * counts as a match instead of disagreeing on casing.
 */
export function isExcludedAccount(account: string | undefined): boolean {
  if (!account) return false;
  return EXCLUDED_KEYS.has(account.trim().toLowerCase());
}

/** Thrown when a tool is asked to act on an excluded account. */
export class ExcludedAccountError extends Error {
  constructor(account: string) {
    super(
      `Account "${account}" is excluded from this MCP server by configuration ` +
        `(${CLI_FLAG} / ${ENV_VAR}) and cannot be read or modified.`
    );
    this.name = "ExcludedAccountError";
  }
}

/** Reject an explicitly named excluded account before any AppleScript runs. */
export function assertAccountAllowed(account: string | undefined): void {
  if (account && isExcludedAccount(account)) {
    throw new ExcludedAccountError(account.trim());
  }
}

/** Drop excluded accounts from a parsed result set (defence in depth). */
export function filterExcluded<T extends { account?: string }>(rows: T[]): T[] {
  if (EXCLUDED_ACCOUNTS.length === 0) return rows;
  return rows.filter((row) => !isExcludedAccount(row.account));
}
