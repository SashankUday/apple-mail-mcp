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

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const ENV_VAR = "APPLE_MAIL_EXCLUDE_ACCOUNTS";
const CLI_FLAG = "--exclude-accounts";

/**
 * The per-user config file, `~/.config/apple-mail-mcp/config.json`.
 *
 * It lives outside the repository, so account names are never committed, and
 * the server reads it on every launch, so an exclusion holds whichever client
 * starts the server and whatever flags that client passes.
 */
export function configFilePath(home: string = homedir()): string {
  return join(home, ".config", "apple-mail-mcp", "config.json");
}

/** Settings read from the config file. */
export interface FileConfig {
  excludeAccounts: string[];
  defaultAccount?: string;
  nativeDraftAccounts: string[];
}

const CONFIG_KEYS = new Set(["excludeAccounts", "defaultAccount", "nativeDraftAccounts"]);

/**
 * Read the config file:
 * `{"excludeAccounts": ["Name", ...], "defaultAccount": "Name",
 * "nativeDraftAccounts": ["Name", ...]}`.
 *
 * `excludeAccounts` is required (it may be empty). Optional: `defaultAccount`,
 * the account used when a draft or email names no sender, and
 * `nativeDraftAccounts`, the accounts whose drafts go through Mail's own
 * composer (see createDraft). A missing
 * file means no settings. A file that exists but cannot be read or
 * understood, including one with a misspelled key, throws, which stops the
 * server from starting: running without the exclusions the user wrote down
 * would be the unsafe failure.
 */
export function readConfigFile(path: string = configFilePath()): FileConfig {
  const refuse = (problem: string) =>
    new Error(`${path} ${problem}; refusing to start without its account exclusions.`);
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { excludeAccounts: [], nativeDraftAccounts: [] };
    throw refuse(`cannot be read (${(err as Error).message})`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw refuse("is not valid JSON");
  }
  const shape = 'must look like {"excludeAccounts": ["Account name"], "defaultAccount": "Account name", "nativeDraftAccounts": ["Account name"]}';
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw refuse(shape);
  const config = parsed as Record<string, unknown>;
  const unknownKeys = Object.keys(config).filter((key) => !CONFIG_KEYS.has(key));
  if (unknownKeys.length > 0) throw refuse(`has unknown setting ${unknownKeys.map((k) => `"${k}"`).join(", ")}; it ${shape}`);
  const { excludeAccounts, defaultAccount, nativeDraftAccounts = [] } = config;
  const isNameList = (value: unknown): value is string[] =>
    Array.isArray(value) && value.every((name) => typeof name === "string");
  if (!isNameList(excludeAccounts) || !isNameList(nativeDraftAccounts)) throw refuse(shape);
  if (defaultAccount !== undefined && (typeof defaultAccount !== "string" || !defaultAccount.trim())) throw refuse(shape);
  return { excludeAccounts, defaultAccount: defaultAccount?.trim(), nativeDraftAccounts };
}

/** Exclusions from the config file; see readConfigFile. */
export function readConfigExclusions(path: string = configFilePath()): string[] {
  return readConfigFile(path).excludeAccounts;
}

/**
 * Parse the exclusion list from the config file, CLI args and environment.
 *
 * CLI accepts both `--exclude-accounts A,B` and `--exclude-accounts=A,B`, and
 * may be repeated. The environment variable is comma-separated. All sources
 * are merged rather than one overriding another: an exclusion is a safety
 * constraint, so the union is the conservative reading.
 */
export function parseExcludedAccounts(
  argv: string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
  configPath: string = configFilePath()
): string[] {
  const raw: string[] = [...readConfigExclusions(configPath)];

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

const FILE_CONFIG = readConfigFile();

/** Account used when a draft or email names no sender, from the config file. */
export const DEFAULT_ACCOUNT: string | undefined = FILE_CONFIG.defaultAccount;

/**
 * Accounts whose drafts use Mail's native composer: the config file's
 * `nativeDraftAccounts` merged with APPLE_MAIL_NATIVE_DRAFT_ACCOUNTS. None by
 * default, because that composer always uses Mail's own sending account, so
 * listing any other account would save its drafts in the wrong place.
 */
export const NATIVE_DRAFT_ACCOUNTS: string[] = [
  ...FILE_CONFIG.nativeDraftAccounts,
  ...(process.env.APPLE_MAIL_NATIVE_DRAFT_ACCOUNTS || "").split(","),
]
  .map((name) => name.trim())
  .filter(Boolean);

const EXCLUDED_KEYS = new Set(EXCLUDED_ACCOUNTS.map((name) => name.toLowerCase()));

if (DEFAULT_ACCOUNT && EXCLUDED_KEYS.has(DEFAULT_ACCOUNT.toLowerCase())) {
  throw new Error(`The default account "${DEFAULT_ACCOUNT}" is also excluded; refusing to start until the config is consistent.`);
}

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
        `(~/.config/apple-mail-mcp/config.json / ${CLI_FLAG} / ${ENV_VAR}) and cannot be read or modified.`
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
