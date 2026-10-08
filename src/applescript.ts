import { constants as fsConstants, chmodSync, copyFileSync, lstatSync, mkdtempSync, realpathSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { execFile } from "node:child_process";
import { DEFAULT_ACCOUNT, EXCLUDED_ACCOUNTS, NATIVE_DRAFT_ACCOUNTS, assertAccountAllowed, filterExcluded } from "./config.js";

/**
 * AppleScript guard skipping excluded accounts inside an account loop.
 *
 * Emitted as a matched pair around the loop body. Returns empty strings when
 * nothing is excluded, so the generated script is byte-identical to the
 * upstream one in the default configuration — the feature costs nothing when
 * unused, and a script regression can't be blamed on it.
 *
 * Relies on `acctName` already being bound in the enclosing scope. AppleScript
 * string comparison ignores case unless wrapped in `considering case`, which
 * matches the case-insensitive test in config.ts.
 */
export function accountGuard(variable = "acctName"): { open: string; close: string } {
  if (EXCLUDED_ACCOUNTS.length === 0) return { open: "", close: "" };
  const tests = EXCLUDED_ACCOUNTS.map((name) => `${variable} is "${sanitize(name)}"`).join(" or ");
  return { open: `if not (${tests}) then`, close: "end if" };
}

/**
 * AppleScript that binds `acct` (and optionally `mb`) by walking Mail's
 * account and mailbox lists instead of addressing them by name.
 *
 * Name-based specifiers such as `mailbox "Inbox" of account "University"` fail
 * with -1728 ("Can't get account") on some Exchange accounts even though the
 * same account appears when iterating `accounts`, and they fail for nested
 * Gmail mailboxes such as `[Gmail]/All Mail`. Iteration yields index-based
 * references (`item i of every account`), which resolve in both cases — the
 * same path list_mailboxes already relies on.
 *
 * Matching rules:
 * - Account names ignore case and white space, so a description with a stray
 *   trailing space still resolves. The excluded-account check is repeated on
 *   the resolved account with the same rules, so a loose spelling can never
 *   reach an excluded account.
 * - Mailbox names ignore case, so `INBOX`, `Inbox` and `inbox` resolve to the
 *   account's real inbox on both Gmail and Exchange.
 * - A mailbox may be given as its full path (`[Gmail]/All Mail`, as
 *   list_mailboxes reports it) or as its leaf name (`All Mail`). `mailboxes of
 *   acct` is flat and includes nested mailboxes under their leaf name; a leaf
 *   name shared by several mailboxes is an error listing their paths.
 * - A missing account or mailbox raises an error that lists what is
 *   available, rather than returning an empty result.
 */
export function resolveTargetScript(accountName: string, mailboxName?: string): string {
  const safeAcct = sanitize(accountName.trim());
  const exclusionCheck = exclusionCheckScript(
    "(name of acct)",
    `"Account \\"${safeAcct}\\" is excluded from this MCP server by configuration and cannot be read or modified."`
  );
  const accountPart = `
  set acct to missing value
  set acctFound to false
  set availableAccts to {}
  repeat with candidateAcct in accounts
    set candidateName to name of candidateAcct
    set end of availableAccts to candidateName
    if not acctFound then
      ignoring white space
        if candidateName is "${safeAcct}" then
          set acct to candidateAcct
          set acctFound to true
        end if
      end ignoring
    end if
  end repeat
  if not acctFound then
    set AppleScript's text item delimiters to ", "
    error "Account \\"${safeAcct}\\" not found. Available accounts: " & (availableAccts as text)
  end if${exclusionCheck}`;
  if (mailboxName === undefined) return accountPart;
  const requested = mailboxName.trim();
  const safeMb = sanitize(requested);
  const isPath = requested.includes("/");
  const safeLeaf = sanitize(requested.slice(requested.lastIndexOf("/") + 1));
  // Matches keep the loop's `item i of every mailbox of acct` reference, which
  // resolves for nested mailboxes; Mail's own by-name specifiers do not.
  return `${accountPart}
  set mb to missing value
  set mbMatchCount to 0
  set mbMatchPaths to {}
  repeat with candidateMb in mailboxes of acct
    if (name of candidateMb) is "${safeLeaf}" then
      ${mailboxPathScript("candidateMb", "candidateMbPath")}
      if ${isPath ? `candidateMbPath is "${safeMb}"` : "true"} then
        set mbMatchCount to mbMatchCount + 1
        if mbMatchCount is 1 then set mb to candidateMb
        set end of mbMatchPaths to candidateMbPath
      end if
    end if
  end repeat
  if mbMatchCount is 0 then
    set availableMbs to {}
    repeat with candidateMb in mailboxes of acct
      ${mailboxPathScript("candidateMb", "candidateMbPath")}
      set end of availableMbs to candidateMbPath
    end repeat
    set AppleScript's text item delimiters to ", "
    error "Mailbox \\"${safeMb}\\" not found in account \\"${safeAcct}\\". Available mailboxes: " & (availableMbs as text)
  end if
  if mbMatchCount > 1 then
    set AppleScript's text item delimiters to ", "
    error "Mailbox \\"${safeMb}\\" is ambiguous in account \\"${safeAcct}\\". Use one of: " & (mbMatchPaths as text)
  end if`;
}

/**
 * AppleScript that sets `outVar` to the mailbox's path within its account,
 * such as `[Gmail]/All Mail` or `Sync Issues/Conflicts`, by walking
 * containers. The walk stops at the account, which is the first container
 * that has no `account` of its own.
 */
export function mailboxPathScript(mbVar: string, outVar: string): string {
  return `set ${outVar} to name of ${mbVar}
  set pathCursor to ${mbVar}
  repeat 20 times
    try
      set pathParent to container of pathCursor
      get account of pathParent
      set ${outVar} to (name of pathParent) & "/" & ${outVar}
      set pathCursor to pathParent
    on error
      exit repeat
    end try
  end repeat`;
}

/**
 * AppleScript raising `errorExpr` when the account name in `nameExpr` is
 * excluded, with the same case- and white-space-insensitive rules as the
 * resolver. Empty when nothing is excluded.
 */
function exclusionCheckScript(nameExpr: string, errorExpr: string): string {
  if (EXCLUDED_ACCOUNTS.length === 0) return "";
  const tests = EXCLUDED_ACCOUNTS.map((name) => `${nameExpr} is "${sanitize(name)}"`).join(" or ");
  return `
  ignoring white space
    if ${tests} then error ${errorExpr}
  end ignoring`;
}

/**
 * AppleScript binding `chosenAccount` and `chosenAddress` for a new outgoing
 * message: the named account's first address (callers pass the config file's
 * default account when none is named), or the account owning Mail's
 * `primary email`. A resolved default that is excluded raises inside
 * AppleScript, so its name and address never reach this process.
 */
function senderLookupScript(from?: string): string {
  if (from) {
    return `${resolveTargetScript(from)}
  set chosenAccount to acct
  set addresses to email addresses of chosenAccount
  if (count of addresses) is 0 then error "Account has no email address"
  set chosenAddress to item 1 of addresses`;
  }
  // `primary email` raises -10000 on some macOS 27 setups; say what to do.
  return `try
    set chosenAddress to primary email
  on error
    error "Mail did not report a default account; specify from_account"
  end try
  set matchingAccounts to {}
  repeat with acct in accounts
    if (email addresses of acct) contains chosenAddress then set end of matchingAccounts to acct
  end repeat
  if (count of matchingAccounts) is not 1 then error "Cannot resolve default account; specify from_account"
  set chosenAccount to item 1 of matchingAccounts${exclusionCheckScript(
    "(name of chosenAccount)",
    `"The default account is excluded from this MCP server by configuration; specify from_account."`
  )}`;
}

export function sanitize(input: string): string {
  return input
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\r\n/g, "\\n")
    .replace(/\r/g, "\\n")
    .replace(/\n/g, "\\n");
}

export function runAppleScript(script: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("osascript", ["-e", script], { maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`AppleScript error: ${stderr || error.message}`));
        return;
      }
      resolve(stdout.trimEnd());
    });
  });
}

function openMailUrl(url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile("open", ["-a", "Mail", url], (error, _stdout, stderr) => {
      if (error) {
        reject(new Error(`Could not open Mail composer: ${stderr || error.message}`));
        return;
      }
      resolve();
    });
  });
}

const NATIVE_DRAFT_KEYS = new Set(NATIVE_DRAFT_ACCOUNTS.map((name) => name.toLocaleLowerCase()));

export function buildMailtoUrl(
  to: string[],
  subject: string,
  body: string,
  cc: string[] = [],
  bcc: string[] = []
): string {
  const query: [string, string][] = [["subject", subject], ["body", body]];
  if (cc.length > 0) query.push(["cc", cc.join(",")]);
  if (bcc.length > 0) query.push(["bcc", bcc.join(",")]);
  const encodedQuery = query
    .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
    .join("&");
  return `mailto:${to.map(encodeURIComponent).join(",")}?${encodedQuery}`;
}

export function normalizeDraftContent(mailboxName: string, content: string): string {
  // Native Mail drafts render without trailing whitespace, but Mail's HTML to
  // plain-text bridge exposes the formatting newline before </body> as one
  // terminal space. Remove only that native-composer sentinel; do not trim
  // ordinary messages or AppleScript drafts with their distinct leading LF.
  // Compare the leaf, so Gmail's nested `[Gmail]/Drafts` counts as Drafts too.
  const leaf = mailboxName.slice(mailboxName.lastIndexOf("/") + 1);
  if (leaf.toLocaleLowerCase() === "drafts" && !content.startsWith("\n") && content.endsWith(" ")) {
    return content.slice(0, -1);
  }
  return content;
}

const FIELD_DELIM = "|||";
const RECORD_DELIM = "<<<>>>";

export async function listMailboxes(
  runner: typeof runAppleScript = runAppleScript
): Promise<{ name: string; account: string; unreadCount: number }[]> {
  const guard = accountGuard();
  // Names are full paths (`[Gmail]/All Mail`), which every other tool accepts.
  const script = `
tell application "Mail"
  set mbList to {}
  repeat with acct in accounts
    set acctName to name of acct
    ${guard.open}
    repeat with mb in mailboxes of acct
      ${mailboxPathScript("mb", "mbName")}
      set mbUnread to unread count of mb
      set end of mbList to mbName & "${FIELD_DELIM}" & acctName & "${FIELD_DELIM}" & (mbUnread as text)
    end repeat
    ${guard.close}
  end repeat
  set AppleScript's text item delimiters to "${RECORD_DELIM}"
  return mbList as text
end tell`;
  const raw = await runner(script);
  if (!raw) return [];
  const rows = raw.split(RECORD_DELIM).map((record) => {
    const [name, account, unreadCount] = record.split(FIELD_DELIM).map((s) => s.trim());
    return { name, account, unreadCount: parseInt(unreadCount, 10) || 0 };
  });
  return filterExcluded(rows);
}

export async function listMessages(
  mailboxName: string,
  accountName: string,
  limit?: number,
  unreadOnly?: boolean
): Promise<{ id: number; subject: string; sender: string; date: string; isRead: boolean }[]> {
  assertAccountAllowed(accountName);
  const maxMessages = limit || 25;

  // When filtering by unread, `whose` returns a runtime list which doesn't support
  // bulk property access. We use a repeat loop in that case.
  const script = unreadOnly
    ? `
tell application "Mail"
  ${resolveTargetScript(accountName, mailboxName)}
  set targetMsgs to messages of mb whose read status is false
  set msgCount to count of targetMsgs
  set maxCount to ${maxMessages}
  if msgCount < maxCount then set maxCount to msgCount
  if maxCount is 0 then return ""
  set msgList to {}
  repeat with i from 1 to maxCount
    set m to item i of targetMsgs
    set end of msgList to (id of m as text) & "${FIELD_DELIM}" & (subject of m) & "${FIELD_DELIM}" & (sender of m) & "${FIELD_DELIM}" & (date sent of m as text) & "${FIELD_DELIM}" & (read status of m as text)
  end repeat
  set AppleScript's text item delimiters to "${RECORD_DELIM}"
  return msgList as text
end tell`
    : `
tell application "Mail"
  ${resolveTargetScript(accountName, mailboxName)}
  set msgCount to count of messages of mb
  set maxCount to ${maxMessages}
  if msgCount < maxCount then set maxCount to msgCount
  if maxCount is 0 then return ""
  set allIds to id of messages 1 thru maxCount of mb
  set allSubjects to subject of messages 1 thru maxCount of mb
  set allSenders to sender of messages 1 thru maxCount of mb
  set allDates to date sent of messages 1 thru maxCount of mb
  set allRead to read status of messages 1 thru maxCount of mb
  set msgList to {}
  repeat with i from 1 to maxCount
    set end of msgList to (item i of allIds as text) & "${FIELD_DELIM}" & item i of allSubjects & "${FIELD_DELIM}" & item i of allSenders & "${FIELD_DELIM}" & (item i of allDates as text) & "${FIELD_DELIM}" & (item i of allRead as text)
  end repeat
  set AppleScript's text item delimiters to "${RECORD_DELIM}"
  return msgList as text
end tell`;
  const raw = await runAppleScript(script);
  if (!raw) return [];
  return raw.split(RECORD_DELIM).map((record) => {
    const [id, subject, sender, date, isRead] = record.split(FIELD_DELIM).map((s) => s.trim());
    return { id: parseInt(id, 10), subject, sender, date, isRead: isRead === "true" };
  });
}

export async function getMessage(
  mailboxName: string | undefined,
  accountName: string | undefined,
  messageId: number,
  runner: typeof runAppleScript = runAppleScript
): Promise<{
  id: number;
  subject: string;
  sender: string;
  date: string;
  isRead: boolean;
  content: string;
  toRecipients: string[];
  ccRecipients: string[];
  mailbox: string;
  account: string;
}> {
  assertAccountAllowed(accountName);
  if (!Number.isSafeInteger(messageId) || messageId < 0) throw new Error("Invalid message id");
  if (mailboxName && !accountName) throw new Error("A mailbox can only be given together with its account");

  // Without a mailbox, look through the account's mailboxes (every allowed
  // account's, without an account), inboxes first. Gmail also lists inbox
  // messages under labels such as [Gmail]/Important, where moving or deleting
  // only removes a label, so the inbox copy is the one to report.
  let locate: string;
  if (mailboxName && accountName) {
    locate = `${resolveTargetScript(accountName, mailboxName)}
  set matchedMsgs to (every message of mb whose id is ${messageId})
  if (count of matchedMsgs) is 0 then
    error "Message not found with id: ${messageId}"
  end if
  set m to item 1 of matchedMsgs`;
  } else {
    const guard = accountGuard();
    const search = `
    repeat with searchPass from 1 to 2
      repeat with candidateMb in mailboxes of acct
        set isInbox to ((name of candidateMb) is "INBOX")
        if (searchPass is 1 and isInbox) or (searchPass is 2 and not isInbox) then
          try
            set matchedMsgs to (every message of candidateMb whose id is ${messageId})
            if (count of matchedMsgs) > 0 then
              set m to item 1 of matchedMsgs
              set mb to candidateMb
              set foundAcct to acct
            end if
          end try
        end if
        if m is not missing value then exit repeat
      end repeat
      if m is not missing value then exit repeat
    end repeat`;
    locate = `set m to missing value
  ${accountName ? `${resolveTargetScript(accountName)}${search}` : `repeat with acct in accounts
    set acctName to name of acct
    ${guard.open}${search}
    ${guard.close}
    if m is not missing value then exit repeat
  end repeat`}
  if m is missing value then error "Message not found with id: ${messageId}"
  set acct to foundAcct`;
  }

  const script = `
tell application "Mail"
  ${locate}
  ${mailboxPathScript("mb", "mbPath")}
  set mId to id of m
  set mSubject to subject of m
  set mSender to sender of m
  set mDate to date sent of m as text
  set mRead to read status of m
  set mContent to content of m

  set toList to {}
  repeat with r in to recipients of m
    set end of toList to address of r
  end repeat
  set AppleScript's text item delimiters to ","
  set toString to toList as text

  set ccList to {}
  repeat with r in cc recipients of m
    set end of ccList to address of r
  end repeat
  set ccString to ccList as text

  return (mId as text) & "${RECORD_DELIM}" & mSubject & "${RECORD_DELIM}" & mSender & "${RECORD_DELIM}" & mDate & "${RECORD_DELIM}" & (mRead as text) & "${RECORD_DELIM}" & mContent & "${RECORD_DELIM}" & toString & "${RECORD_DELIM}" & ccString & "${RECORD_DELIM}" & mbPath & "${RECORD_DELIM}" & (name of acct)
end tell`;
  const raw = await runner(script);
  const parts = raw.split(RECORD_DELIM);
  const mailbox = parts[8]?.trim() || mailboxName || "";
  const account = parts[9]?.trim() || accountName || "";
  // Defence in depth: the script already skipped or rejected excluded accounts.
  assertAccountAllowed(account);
  return {
    id: parseInt(parts[0]?.trim() || "0", 10),
    subject: parts[1]?.trim() || "",
    sender: parts[2]?.trim() || "",
    date: parts[3]?.trim() || "",
    isRead: parts[4]?.trim() === "true",
    content: normalizeDraftContent(mailbox, parts[5] || ""),
    toRecipients: parts[6] ? parts[6].split(",").map((s) => s.trim()).filter(Boolean) : [],
    ccRecipients: parts[7] ? parts[7].split(",").map((s) => s.trim()).filter(Boolean) : [],
    mailbox,
    account,
  };
}

export async function searchMessages(
  query: string,
  mailboxName?: string,
  accountName?: string,
  limit?: number,
  searchField?: "subject" | "sender",
  runner: typeof runAppleScript = runAppleScript
): Promise<{ id: number; subject: string; sender: string; date: string; mailbox: string; account: string }[]> {
  const safeQuery = sanitize(query);
  const maxResults = limit || 25;
  const field = searchField === "sender" ? "sender" : "subject";
  if (mailboxName && !accountName) throw new Error("A mailbox can only be given together with its account");
  assertAccountAllowed(accountName);

  // Collect the newest matches of one mailbox `mb` in account `acct`. Mail
  // lists messages newest first, so the first ${maxResults} matches of each
  // mailbox include every match that can make the overall top ${maxResults}.
  // The `whose` filter is the expensive step (seconds on a large Exchange
  // inbox), so it runs once per mailbox and only the kept matches are read.
  // A message already collected for this account (Gmail lists one message
  // under several labels) is skipped.
  const collect = `
      set matchedMsgs to (every message of mb whose ${field} contains "${safeQuery}")
      set matchCount to count of matchedMsgs
      if matchCount > 0 then
        ${mailboxPathScript("mb", "mbPath")}
        set takeCount to 0
        repeat with i from 1 to matchCount
          if takeCount >= ${maxResults} then exit repeat
          set m to item i of matchedMsgs
          set matchId to id of m
          if seenIds does not contain matchId then
            set end of seenIds to matchId
            set takeCount to takeCount + 1
            set dateText to ""
            set sortText to ""
            try
              set matchDate to date sent of m
              set dateText to matchDate as text
              set sortText to matchDate as «class isot» as string
            end try
            set end of results to (matchId as text) & "${FIELD_DELIM}" & (subject of m) & "${FIELD_DELIM}" & (sender of m) & "${FIELD_DELIM}" & dateText & "${FIELD_DELIM}" & mbPath & "${FIELD_DELIM}" & (name of acct) & "${FIELD_DELIM}" & sortText
          end if
        end repeat
      end if`;

  let script: string;
  if (mailboxName && accountName) {
    script = `
tell application "Mail"
  set results to {}
  set seenIds to {}
  ${resolveTargetScript(accountName, mailboxName)}${collect}
  set AppleScript's text item delimiters to "${RECORD_DELIM}"
  return results as text
end tell`;
  } else {
    // One unreadable mailbox (common among Exchange's calendar, contacts and
    // sync folders) is skipped instead of aborting the whole search.
    const guard = accountGuard();
    const perAccount = `
    set seenIds to {}
    repeat with mb in mailboxes of acct
      try${collect}
      end try
    end repeat`;
    script = `
tell application "Mail"
  set results to {}
  ${accountName ? `${resolveTargetScript(accountName)}${perAccount}` : `repeat with acct in accounts
    set acctName to name of acct
    ${guard.open}${perAccount}
    ${guard.close}
  end repeat`}
  set AppleScript's text item delimiters to "${RECORD_DELIM}"
  return results as text
end tell`;
  }
  const raw = await runner(script);
  if (!raw) return [];
  const rows = raw.split(RECORD_DELIM).map((record) => {
    const [id, subject, sender, date, mailbox, account, sortKey] = record.split(FIELD_DELIM).map((s) => s.trim());
    return { id: parseInt(id, 10), subject, sender, date, mailbox, account, sortKey: sortKey || "" };
  });
  // Newest first across every mailbox and account, then the overall limit.
  rows.sort((a, b) => (a.sortKey < b.sortKey ? 1 : a.sortKey > b.sortKey ? -1 : 0));
  return filterExcluded(rows)
    .slice(0, maxResults)
    .map(({ sortKey: _sortKey, ...row }) => row);
}

export async function sendEmail(
  to: string,
  subject: string,
  body: string,
  options?: { cc?: string; bcc?: string; from?: string },
  runner: typeof runAppleScript = runAppleScript
): Promise<string> {
  const from = options?.from?.trim() || DEFAULT_ACCOUNT;
  assertAccountAllowed(from);
  const safeSubject = sanitize(subject);
  const safeBody = sanitize(body);

  // Support multiple comma-separated recipients
  const toAddresses = to.split(",").map((a) => a.trim()).filter(Boolean);
  let recipientBlock = toAddresses
    .map((addr) => `make new to recipient at end of to recipients with properties {address:"${sanitize(addr)}"}`)
    .join("\n    ");

  if (options?.cc) {
    const ccAddresses = options.cc.split(",").map((a) => a.trim()).filter(Boolean);
    recipientBlock += "\n    " + ccAddresses
      .map((addr) => `make new cc recipient at end of cc recipients with properties {address:"${sanitize(addr)}"}`)
      .join("\n    ");
  }
  if (options?.bcc) {
    const bccAddresses = options.bcc.split(",").map((a) => a.trim()).filter(Boolean);
    recipientBlock += "\n    " + bccAddresses
      .map((addr) => `make new bcc recipient at end of bcc recipients with properties {address:"${sanitize(addr)}"}`)
      .join("\n    ");
  }

  // Mail's dictionary has no outgoing messages inside an account, so the
  // sender is chosen the way createDraft does it: the account's address in
  // the `sender` property. An excluded default account fails before anything
  // is created.
  const script = `
tell application "Mail"
  ${senderLookupScript(from)}
  set newMessage to make new outgoing message with properties {sender:chosenAddress, subject:"${safeSubject}", content:"${safeBody}", visible:false}
  tell newMessage
    ${recipientBlock}
  end tell
  send newMessage
  return "Email sent from " & (name of chosenAccount) & " to ${sanitize(to)}: ${safeSubject}"
end tell`;
  return runner(script);
}

export async function createDraft(
  to: string,
  subject: string,
  body: string,
  options?: { cc?: string; bcc?: string; from?: string },
  runner: typeof runAppleScript = runAppleScript,
  urlOpener: (url: string) => Promise<void> = openMailUrl
): Promise<string> {
  const from = options?.from?.trim() || DEFAULT_ACCOUNT;
  assertAccountAllowed(from);
  // Resolve the sender before creating anything, including when Mail's default is used.
  const accountLookup = senderLookupScript(from);
  const resolved = await runner(`
tell application "Mail"
  ${accountLookup}
  return (name of chosenAccount) & "${FIELD_DELIM}" & chosenAddress
end tell`);
  const fields = resolved.split(FIELD_DELIM);
  if (fields.length !== 2 || !fields[0] || !fields[1]) throw new Error("Cannot resolve draft account and email address");
  const [accountName, address] = fields;
  assertAccountAllowed(accountName);
  const safeSubject = sanitize(subject);
  const safeBody = sanitize(body);

  // Support multiple comma-separated recipients
  const toAddresses = to.split(",").map((a) => a.trim()).filter(Boolean);
  const ccAddresses = options?.cc?.split(",").map((a) => a.trim()).filter(Boolean) || [];
  const bccAddresses = options?.bcc?.split(",").map((a) => a.trim()).filter(Boolean) || [];

  // Mail 16 wraps AppleScript-assigned rich text in Apple-Mail-URLShare markup.
  // On affected accounts that adds a visible blank first line and serializes an
  // extra trailing " \n". Mail's native mailto composer does not add that
  // wrapper, so use it for accounts explicitly enabled for the workaround.
  // The mailto `from` parameter is ignored by macOS Mail, hence this path is
  // opt-in per account rather than risking a draft in the wrong account.
  if (NATIVE_DRAFT_KEYS.has(accountName.toLocaleLowerCase())) {
    const existingState = await runner(`
tell application "Mail"
  set windowIds to {}
  if (count of windows) > 0 then set windowIds to id of every window
  ${resolveTargetScript(accountName, "Drafts")}
  set draftMailbox to mb
  set matchingDrafts to every message of draftMailbox whose subject is "${safeSubject}"
  return (windowIds as text) & "${FIELD_DELIM}" & (count of matchingDrafts as text)
end tell`);
    const stateParts = existingState.split(FIELD_DELIM);
    if (stateParts.length !== 2) {
      throw new Error("Cannot determine Mail state before creating draft");
    }
    const windowIds = stateParts[0]
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean);
    const previousDraftCount = Number.parseInt(stateParts[1], 10);
    if (windowIds.some((id) => !/^\d+$/.test(id)) || !Number.isSafeInteger(previousDraftCount) || previousDraftCount < 0) {
      throw new Error("Cannot determine existing Mail windows and drafts before creating draft");
    }

    await urlOpener(buildMailtoUrl(toAddresses, subject, body, ccAddresses, bccAddresses));
    const oldIds = windowIds.length > 0 ? `{${windowIds.join(", ")}}` : "{}";
    await runner(`
tell application "Mail"
  set previousWindowIds to ${oldIds}
  set previousDraftCount to ${previousDraftCount}
  set draftWindow to missing value
  repeat 40 times
    repeat with candidateWindow in windows
      if (id of candidateWindow) is not in previousWindowIds then
        set draftWindow to candidateWindow
        exit repeat
      end if
    end repeat
    if draftWindow is not missing value then exit repeat
    delay 0.25
  end repeat
  if draftWindow is missing value then error "Timed out waiting for Mail draft window"
  ${resolveTargetScript(accountName, "Drafts")}
  set savedDraftFound to false
  repeat 120 times
    set matchingDrafts to every message of mb whose subject is "${safeSubject}"
    if (count of matchingDrafts) > previousDraftCount then set savedDraftFound to true
    if savedDraftFound then exit repeat
    delay 0.25
  end repeat
  if not savedDraftFound then error "Timed out waiting for Mail to save draft"
  close draftWindow saving yes
  return "Draft saved in Drafts for ${sanitize(accountName)}: ${safeSubject}"
end tell`);
    return `Draft saved in Drafts for ${accountName}: ${subject}`;
  }

  let recipientBlock = toAddresses
    .map((addr) => `make new to recipient at end of to recipients with properties {address:"${sanitize(addr)}"}`)
    .join("\n    ");

  if (ccAddresses.length > 0) {
    recipientBlock += "\n    " + ccAddresses
      .map((addr) => `make new cc recipient at end of cc recipients with properties {address:"${sanitize(addr)}"}`)
      .join("\n    ");
  }
  if (bccAddresses.length > 0) {
    recipientBlock += "\n    " + bccAddresses
      .map((addr) => `make new bcc recipient at end of bcc recipients with properties {address:"${sanitize(addr)}"}`)
      .join("\n    ");
  }

  // macOS 27 / Mail live test: both visibility modes persisted after save and close.
  // visible:true produced an extra recipient in the multi-recipient trial; false
  // preserved the exact To/CC/BCC lists. Review the saved message in Drafts.
  const script = `
tell application "Mail"
  set newMessage to make new outgoing message with properties {sender:"${sanitize(address)}", subject:"${safeSubject}", content:"${safeBody}", visible:false}
  tell newMessage
    ${recipientBlock}
  end tell
  save newMessage
  return "Draft saved in Drafts for ${sanitize(accountName)}: ${safeSubject}"
end tell`;
  return runner(script);
}

/**
 * Save an unsent reply to an existing message as a draft.
 *
 * Uses Mail's `reply` command rather than a new outgoing message, so the draft
 * carries the `Re:` subject and the In-Reply-To/References headers that keep it
 * in the original conversation in Mail, Gmail and Outlook. Mail chooses the
 * sender from the account that received the original.
 *
 * Any quoted original Mail places in the reply is kept below the new text.
 */
export async function createReplyDraft(
  mailboxName: string,
  accountName: string,
  messageId: number,
  body: string,
  options?: { replyAll?: boolean },
  runner: typeof runAppleScript = runAppleScript
): Promise<string> {
  assertAccountAllowed(accountName);
  if (!Number.isSafeInteger(messageId) || messageId < 0) throw new Error("Invalid message id");
  const safeBody = sanitize(body);
  const script = `
tell application "Mail"
  ${resolveTargetScript(accountName, mailboxName)}
  set matchedMsgs to (every message of mb whose id is ${messageId})
  if (count of matchedMsgs) is 0 then
    error "Message not found with id: ${messageId}"
  end if
  set originalMsg to item 1 of matchedMsgs
  set replyMsg to reply originalMsg opening window false reply to all ${options?.replyAll ? "true" : "false"}
  set quotedText to ""
  try
    set quotedText to content of replyMsg
  end try
  if quotedText is missing value then set quotedText to ""
  if quotedText is "" then
    set content of replyMsg to "${safeBody}"
  else
    set content of replyMsg to "${safeBody}" & linefeed & linefeed & quotedText
  end if
  save replyMsg
  return (subject of replyMsg) & "${FIELD_DELIM}" & (sender of replyMsg)
end tell`;
  const result = await runner(script);
  const [subject, sender] = result.split(FIELD_DELIM);
  return `Reply draft saved in Drafts${sender ? ` from ${sender}` : ""}: ${subject}`;
}

export async function getUnreadCount(mailboxName?: string, accountName?: string): Promise<number> {
  let script: string;
  if (mailboxName && accountName) {
    assertAccountAllowed(accountName);
    script = `
tell application "Mail"
  ${resolveTargetScript(accountName, mailboxName)}
  return unread count of mb
end tell`;
  } else {
    const guard = accountGuard();
    script = `
tell application "Mail"
  set totalUnread to 0
  repeat with acct in accounts
    set acctName to name of acct
    ${guard.open}
    repeat with mb in mailboxes of acct
      set totalUnread to totalUnread + (unread count of mb)
    end repeat
    ${guard.close}
  end repeat
  return totalUnread
end tell`;
  }
  const raw = await runAppleScript(script);
  return parseInt(raw, 10) || 0;
}

export async function moveMessage(
  messageId: number,
  fromMailbox: string,
  fromAccount: string,
  toMailbox: string,
  toAccount?: string
): Promise<string> {
  assertAccountAllowed(fromAccount);
  assertAccountAllowed(toAccount);
  const safeToMb = sanitize(toMailbox);
  const script = `
tell application "Mail"
  ${resolveTargetScript(fromAccount, fromMailbox)}
  set sourceMb to mb
  ${resolveTargetScript(toAccount || fromAccount, toMailbox)}
  set destMb to mb
  set matchedMsgs to (every message of sourceMb whose id is ${messageId})
  if (count of matchedMsgs) is 0 then
    error "Message not found with id: ${messageId}"
  end if
  set m to item 1 of matchedMsgs
  move m to destMb
  return "Message moved to ${safeToMb}"
end tell`;
  return runAppleScript(script);
}

export async function markRead(
  messageId: number,
  mailboxName: string,
  accountName: string,
  read: boolean
): Promise<string> {
  assertAccountAllowed(accountName);
  const script = `
tell application "Mail"
  ${resolveTargetScript(accountName, mailboxName)}
  set matchedMsgs to (every message of mb whose id is ${messageId})
  if (count of matchedMsgs) is 0 then
    error "Message not found with id: ${messageId}"
  end if
  set m to item 1 of matchedMsgs
  set read status of m to ${read}
  return "Message marked as ${read ? "read" : "unread"}"
end tell`;
  return runAppleScript(script);
}

export async function deleteMessage(
  messageId: number,
  mailboxName: string,
  accountName: string
): Promise<string> {
  assertAccountAllowed(accountName);
  const script = `
tell application "Mail"
  ${resolveTargetScript(accountName, mailboxName)}
  set matchedMsgs to (every message of mb whose id is ${messageId})
  if (count of matchedMsgs) is 0 then
    error "Message not found with id: ${messageId}"
  end if
  set m to item 1 of matchedMsgs
  delete m
  return "Message deleted (moved to trash)"
end tell`;
  return runAppleScript(script);
}

export async function flagMessage(
  messageId: number,
  mailboxName: string,
  accountName: string,
  flagged: boolean
): Promise<string> {
  assertAccountAllowed(accountName);
  const script = `
tell application "Mail"
  ${resolveTargetScript(accountName, mailboxName)}
  set matchedMsgs to (every message of mb whose id is ${messageId})
  if (count of matchedMsgs) is 0 then
    error "Message not found with id: ${messageId}"
  end if
  set m to item 1 of matchedMsgs
  set flagged status of m to ${flagged}
  return "Message ${flagged ? "flagged" : "unflagged"}"
end tell`;
  return runAppleScript(script);
}


export async function listAttachments(
  mailboxName: string,
  accountName: string,
  messageId: number,
  runner: typeof runAppleScript = runAppleScript
): Promise<{ name: string; mimeType: string | null; size: number; downloaded: boolean }[]> {
  assertAccountAllowed(accountName);
  if (!Number.isSafeInteger(messageId) || messageId < 0) throw new Error("Invalid message id");
  const script = `
tell application "Mail"
  ${resolveTargetScript(accountName, mailboxName)}
  set matchedMsgs to (every message of mb whose id is ${messageId})
  if (count of matchedMsgs) is 0 then
    error "Message not found with id: ${messageId}"
  end if
  set m to item 1 of matchedMsgs
  set attList to {}
  repeat with att in mail attachments of m
    set attName to name of att
    if attName contains "${RECORD_DELIM}" then error "Attachment name contains an unsupported record delimiter"
    -- Some Mail versions advertise MIME type but raise -10000 when it is read.
    -- Preserve usable metadata and report an unknown type instead of guessing.
    set attMime to ""
    try
      set attMime to MIME type of att
    end try
    set end of attList to attName & "${FIELD_DELIM}" & attMime & "${FIELD_DELIM}" & (file size of att as text) & "${FIELD_DELIM}" & (downloaded of att as text)
  end repeat
  set AppleScript's text item delimiters to "${RECORD_DELIM}"
  return attList as text
end tell`;
  const raw = await runner(script);
  if (!raw) return [];
  return raw.split(RECORD_DELIM).map((record) => {
    const fields = record.split(FIELD_DELIM);
    const downloaded = fields.pop();
    const size = Number(fields.pop());
    const mimeType = fields.pop();
    if (!fields.length || mimeType === undefined || !Number.isFinite(size) || size < 0 ||
        (downloaded !== "true" && downloaded !== "false")) {
      throw new Error("Invalid attachment metadata returned by Mail");
    }
    return { name: fields.join(FIELD_DELIM), mimeType: mimeType || null, size, downloaded: downloaded === "true" };
  });
}


export function validateAttachmentName(name: string): void {
  if (!name || /[/\\\0]/.test(name) || name.includes("..") || name.startsWith(".")) {
    throw new Error("Invalid attachment name: empty, hidden, traversal and path separator names are not allowed");
  }
}

export function validateAttachmentDirectory(savePath: string): string {
  if (!isAbsolute(savePath)) throw new Error("save_path must be an absolute path to an existing directory");
  const hasHiddenSegment = (path: string): boolean => path.split(sep).some((part) => part.startsWith("."));
  if (hasHiddenSegment(savePath)) throw new Error("Saving into hidden directories is not allowed");
  const directory = realpathSync.native(savePath);
  if (!statSync(directory).isDirectory()) throw new Error("save_path must be an existing directory");
  if (hasHiddenSegment(directory)) throw new Error("Saving into hidden directories is not allowed");

  const within = (path: string, root: string): boolean => {
    const rel = relative(root, path);
    return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
  };
  // Check canonical paths and case-fold the deny root as additional protection on APFS.
  const home = realpathSync.native(homedir());
  const keychains = join(home, "Library", "Keychains");
  if (within(directory.toLowerCase(), keychains.toLowerCase()) ||
      within(resolve(savePath).toLowerCase(), keychains.toLowerCase())) {
    throw new Error("Saving into Library/Keychains is not allowed");
  }
  const configured = process.env.APPLE_MAIL_ATTACHMENT_SAVE_ROOTS;
  const roots = configured === undefined ? [home, "/Volumes", tmpdir()] : configured.split(":").filter(Boolean);
  const allowed = roots.some((root) => {
    if (!isAbsolute(root)) throw new Error("APPLE_MAIL_ATTACHMENT_SAVE_ROOTS must contain absolute directories");
    try {
      const canonicalRoot = realpathSync.native(root);
      return statSync(canonicalRoot).isDirectory() && within(directory, canonicalRoot);
    } catch {
      // A missing default volume/temp root must not disable another valid root.
      return false;
    }
  });
  if (!allowed) throw new Error("save_path is outside the allowed attachment save roots");
  return directory;
}

export async function saveAttachment(
  mailboxName: string,
  accountName: string,
  messageId: number,
  attachmentName: string,
  savePath: string,
  runner: typeof runAppleScript = runAppleScript
): Promise<{ savedPath: string; bytes: number }> {
  assertAccountAllowed(accountName);
  validateAttachmentName(attachmentName);
  if (!Number.isSafeInteger(messageId) || messageId < 0) throw new Error("Invalid message id");
  const directory = validateAttachmentDirectory(savePath);
  const directoryStat = statSync(directory);
  const finalPath = join(directory, attachmentName);
  const staging = mkdtempSync(join(directory, ".apple-mail-attachment-"));
  const staged = join(staging, "attachment");
  try {
    chmodSync(staging, 0o700);
    const script = `
tell application "Mail"
  ${resolveTargetScript(accountName, mailboxName)}
  set matchedMsgs to (every message of mb whose id is ${messageId})
  if (count of matchedMsgs) is 0 then
    error "Message not found with id: ${messageId}"
  end if
  set m to item 1 of matchedMsgs
  considering case
    set matchingAttachments to (every mail attachment of m whose name is "${sanitize(attachmentName)}")
  end considering
  if (count of matchingAttachments) is 0 then error "Attachment not found: ${sanitize(attachmentName)}"
  if (count of matchingAttachments) > 1 then error "Multiple attachments have this name; cannot select one unambiguously"
  set att to item 1 of matchingAttachments
  if not (downloaded of att) then error "Attachment is not downloaded locally: ${sanitize(attachmentName)}; open it in Mail first"
  save att in POSIX file "${sanitize(staged)}"
end tell`;
    await runner(script);
    const stagedStat = lstatSync(staged);
    if (!stagedStat.isFile()) throw new Error("Mail did not save a regular attachment file");
    chmodSync(staged, 0o600);
    const currentDirectory = validateAttachmentDirectory(savePath);
    const currentStat = statSync(currentDirectory);
    if (currentDirectory !== directory || currentStat.dev !== directoryStat.dev || currentStat.ino !== directoryStat.ino) {
      throw new Error("Destination directory changed while saving attachment");
    }
    try {
      copyFileSync(staged, finalPath, fsConstants.COPYFILE_EXCL);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") {
        throw new Error(`Destination already exists; refusing to overwrite: ${finalPath}`);
      }
      throw err;
    }
    chmodSync(finalPath, 0o600);
    return { savedPath: finalPath, bytes: statSync(finalPath).size };
  } finally {
    try {
      rmSync(staging, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup must not hide the original Mail/filesystem error.
    }
  }
}
