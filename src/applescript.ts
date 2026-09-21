import { constants as fsConstants, chmodSync, copyFileSync, lstatSync, mkdtempSync, realpathSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { execFile } from "node:child_process";
import { EXCLUDED_ACCOUNTS, assertAccountAllowed, filterExcluded } from "./config.js";

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

const FIELD_DELIM = "|||";
const RECORD_DELIM = "<<<>>>";

export async function listMailboxes(): Promise<{ name: string; account: string; unreadCount: number }[]> {
  const guard = accountGuard();
  const script = `
tell application "Mail"
  set mbList to {}
  repeat with acct in accounts
    set acctName to name of acct
    ${guard.open}
    repeat with mb in mailboxes of acct
      set mbName to name of mb
      set mbUnread to unread count of mb
      set end of mbList to mbName & "${FIELD_DELIM}" & acctName & "${FIELD_DELIM}" & (mbUnread as text)
    end repeat
    ${guard.close}
  end repeat
  set AppleScript's text item delimiters to "${RECORD_DELIM}"
  return mbList as text
end tell`;
  const raw = await runAppleScript(script);
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
  const safeMb = sanitize(mailboxName);
  const safeAcct = sanitize(accountName);
  const maxMessages = limit || 25;

  // When filtering by unread, `whose` returns a runtime list which doesn't support
  // bulk property access. We use a repeat loop in that case.
  const script = unreadOnly
    ? `
tell application "Mail"
  set mb to mailbox "${safeMb}" of account "${safeAcct}"
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
  set mb to mailbox "${safeMb}" of account "${safeAcct}"
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
  mailboxName: string,
  accountName: string,
  messageId: number
): Promise<{
  id: number;
  subject: string;
  sender: string;
  date: string;
  isRead: boolean;
  content: string;
  toRecipients: string[];
  ccRecipients: string[];
}> {
  assertAccountAllowed(accountName);
  const safeMb = sanitize(mailboxName);
  const safeAcct = sanitize(accountName);
  const script = `
tell application "Mail"
  set mb to mailbox "${safeMb}" of account "${safeAcct}"
  set matchedMsgs to (every message of mb whose id is ${messageId})
  if (count of matchedMsgs) is 0 then
    error "Message not found with id: ${messageId}"
  end if
  set m to item 1 of matchedMsgs
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

  return (mId as text) & "${RECORD_DELIM}" & mSubject & "${RECORD_DELIM}" & mSender & "${RECORD_DELIM}" & mDate & "${RECORD_DELIM}" & (mRead as text) & "${RECORD_DELIM}" & mContent & "${RECORD_DELIM}" & toString & "${RECORD_DELIM}" & ccString
end tell`;
  const raw = await runAppleScript(script);
  const parts = raw.split(RECORD_DELIM);
  return {
    id: parseInt(parts[0]?.trim() || "0", 10),
    subject: parts[1]?.trim() || "",
    sender: parts[2]?.trim() || "",
    date: parts[3]?.trim() || "",
    isRead: parts[4]?.trim() === "true",
    content: parts[5] || "",
    toRecipients: parts[6] ? parts[6].split(",").map((s) => s.trim()).filter(Boolean) : [],
    ccRecipients: parts[7] ? parts[7].split(",").map((s) => s.trim()).filter(Boolean) : [],
  };
}

export async function searchMessages(
  query: string,
  mailboxName?: string,
  accountName?: string,
  limit?: number,
  searchField?: "subject" | "sender"
): Promise<{ id: number; subject: string; sender: string; date: string; mailbox: string; account: string }[]> {
  const safeQuery = sanitize(query);
  const maxResults = limit || 25;
  const field = searchField === "sender" ? "sender" : "subject";

  let script: string;
  if (mailboxName && accountName) {
    assertAccountAllowed(accountName);
    const safeMb = sanitize(mailboxName);
    const safeAcct = sanitize(accountName);
    script = `
tell application "Mail"
  set results to {}
  set mb to mailbox "${safeMb}" of account "${safeAcct}"
  set matchedMsgs to (every message of mb whose ${field} contains "${safeQuery}")
  set maxCount to ${maxResults}
  set msgCount to count of matchedMsgs
  if msgCount < maxCount then set maxCount to msgCount
  repeat with i from 1 to maxCount
    set m to item i of matchedMsgs
    set end of results to (id of m as text) & "${FIELD_DELIM}" & subject of m & "${FIELD_DELIM}" & sender of m & "${FIELD_DELIM}" & (date sent of m as text) & "${FIELD_DELIM}" & "${safeMb}" & "${FIELD_DELIM}" & "${safeAcct}"
  end repeat
  set AppleScript's text item delimiters to "${RECORD_DELIM}"
  return results as text
end tell`;
  } else {
    const guard = accountGuard();
    script = `
tell application "Mail"
  set results to {}
  set resultCount to 0
  repeat with acct in accounts
    set acctName to name of acct
    ${guard.open}
    repeat with mb in mailboxes of acct
      set mbName to name of mb
      set matchedMsgs to (every message of mb whose ${field} contains "${safeQuery}")
      repeat with m in matchedMsgs
        if resultCount >= ${maxResults} then exit repeat
        set end of results to (id of m as text) & "${FIELD_DELIM}" & subject of m & "${FIELD_DELIM}" & sender of m & "${FIELD_DELIM}" & (date sent of m as text) & "${FIELD_DELIM}" & mbName & "${FIELD_DELIM}" & acctName
        set resultCount to resultCount + 1
      end repeat
      if resultCount >= ${maxResults} then exit repeat
    end repeat
    ${guard.close}
    if resultCount >= ${maxResults} then exit repeat
  end repeat
  set AppleScript's text item delimiters to "${RECORD_DELIM}"
  return results as text
end tell`;
  }
  const raw = await runAppleScript(script);
  if (!raw) return [];
  const rows = raw.split(RECORD_DELIM).map((record) => {
    const [id, subject, sender, date, mailbox, account] = record.split(FIELD_DELIM).map((s) => s.trim());
    return { id: parseInt(id, 10), subject, sender, date, mailbox, account };
  });
  return filterExcluded(rows);
}

export async function sendEmail(
  to: string,
  subject: string,
  body: string,
  options?: { cc?: string; bcc?: string; from?: string }
): Promise<string> {
  assertAccountAllowed(options?.from);
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

  let accountPart = "";
  if (options?.from) {
    const safeFrom = sanitize(options.from);
    accountPart = ` of account "${safeFrom}"`;
  }

  const script = `
tell application "Mail"
  set newMessage to make new outgoing message${accountPart} with properties {subject:"${safeSubject}", content:"${safeBody}", visible:false}
  tell newMessage
    ${recipientBlock}
  end tell
  send newMessage
  return "Email sent to ${sanitize(to)}: ${safeSubject}"
end tell`;
  return runAppleScript(script);
}

export async function createDraft(
  to: string,
  subject: string,
  body: string,
  options?: { cc?: string; bcc?: string; from?: string },
  runner: typeof runAppleScript = runAppleScript
): Promise<string> {
  assertAccountAllowed(options?.from);
  // Resolve the sender before creating anything, including when Mail's default is used.
  const accountLookup = options?.from
    ? `set chosenAccount to account "${sanitize(options.from.trim())}"
  set addresses to email addresses of chosenAccount
  if (count of addresses) is 0 then error "Account has no email address"
  set chosenAddress to item 1 of addresses`
    : `set chosenAddress to primary email
  set matchingAccounts to {}
  repeat with acct in accounts
    if (email addresses of acct) contains chosenAddress then set end of matchingAccounts to acct
  end repeat
  if (count of matchingAccounts) is not 1 then error "Cannot resolve default account; specify from_account"
  set chosenAccount to item 1 of matchingAccounts`;
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

export async function getUnreadCount(mailboxName?: string, accountName?: string): Promise<number> {
  let script: string;
  if (mailboxName && accountName) {
    assertAccountAllowed(accountName);
    const safeMb = sanitize(mailboxName);
    const safeAcct = sanitize(accountName);
    script = `
tell application "Mail"
  return unread count of mailbox "${safeMb}" of account "${safeAcct}"
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
  const safeFromMb = sanitize(fromMailbox);
  const safeFromAcct = sanitize(fromAccount);
  const safeToMb = sanitize(toMailbox);
  const safeToAcct = sanitize(toAccount || fromAccount);
  const script = `
tell application "Mail"
  set sourceMb to mailbox "${safeFromMb}" of account "${safeFromAcct}"
  set destMb to mailbox "${safeToMb}" of account "${safeToAcct}"
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
  const safeMb = sanitize(mailboxName);
  const safeAcct = sanitize(accountName);
  const script = `
tell application "Mail"
  set mb to mailbox "${safeMb}" of account "${safeAcct}"
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
  const safeMb = sanitize(mailboxName);
  const safeAcct = sanitize(accountName);
  const script = `
tell application "Mail"
  set mb to mailbox "${safeMb}" of account "${safeAcct}"
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
  const safeMb = sanitize(mailboxName);
  const safeAcct = sanitize(accountName);
  const script = `
tell application "Mail"
  set mb to mailbox "${safeMb}" of account "${safeAcct}"
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
  const safeMb = sanitize(mailboxName);
  const safeAcct = sanitize(accountName);
  const script = `
tell application "Mail"
  set mb to mailbox "${safeMb}" of account "${safeAcct}"
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
  set mb to mailbox "${sanitize(mailboxName)}" of account "${sanitize(accountName)}"
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
