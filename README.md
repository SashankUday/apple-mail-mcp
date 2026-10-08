# Apple Mail MCP fork

This fork of [griches/apple-mcp](https://github.com/griches/apple-mcp) contains only the Apple Mail package. It provides an [MCP](https://modelcontextprotocol.io) server that controls Mail.app on macOS through AppleScript, with account exclusion added in this fork. The Notes, Messages, Contacts, Reminders, Calendar and Maps packages are not included.

## Requirements and setup

- macOS with Apple Mail configured
- Node.js 18+ and npm
- macOS Automation permission for the process running the server to control Mail

```bash
git clone https://github.com/SashankUday/apple-mail-mcp.git
cd apple-mail-mcp
npm install
npm run build
```

Then create your exclusion file (see [Account exclusion](#account-exclusion)) before connecting any client.

Run this fork from its local build. The upstream npm package `@griches/apple-mail-mcp` does not include this fork's account-exclusion changes.

## Account exclusion

Put the accounts to exclude, by their names in Mail, in `~/.config/apple-mail-mcp/config.json`:

```json
{
  "excludeAccounts": ["Personal Gmail", "iCloud"],
  "defaultAccount": "Work",
  "nativeDraftAccounts": ["Work"]
}
```

`excludeAccounts` is required (use `[]` for none). `defaultAccount` is optional: it is the account `create_draft` and `send_email` use when no `from_account` is given; without it they fall back to the account owning Mail's `primary email`, which some macOS 27 setups cannot report. The default account must not also be excluded. Reply drafts always come from the account that received the original. `nativeDraftAccounts` is optional and explained under [create_draft](#tools); leave it out unless drafts from your account start with a blank line.

This is the recommended setup. The file is outside the repository, so account names are never committed, and the server reads it on every launch, so the exclusion holds whichever client starts the server (Claude Desktop, Claude Code's project `.mcp.json`, or anything else) and whatever arguments that client passes. A missing file means no exclusions from it. A file that exists but cannot be read, is not valid JSON, has no `excludeAccounts` list of strings, or contains a misspelled setting stops the server from starting, rather than letting it run without the exclusions. Keep it private with `chmod 600`.

Exclusions can also be given per launch; all sources are merged, so these can add accounts but never remove one listed in the file:

```bash
node build/index.js --exclude-accounts "Personal Gmail,iCloud"
node build/index.js --exclude-accounts="Personal Gmail" --exclude-accounts=iCloud
APPLE_MAIL_EXCLUDE_ACCOUNTS="Personal Gmail,iCloud" node build/index.js
```

Names are trimmed, matched case-insensitively and deduplicated. No accounts are excluded by default. The server logs its configured exclusions to stderr at startup; a misspelled or renamed account will not match, so check that log after setting up.

Enumeration skips excluded accounts in mailbox listings, unscoped searches and total unread counts. Operations explicitly naming an excluded account fail before AppleScript runs. Message moves check both source and destination. Mailbox listings and search results also receive a TypeScript filter as a second check.

This is an application-level filter, not a macOS permission boundary. `send_email` and `create_draft` check both an explicitly named `from_account` and the resolved default account; the default is checked inside AppleScript, so an excluded default account's address never reaches the server. `send_email` still has no additional approval gate.

## MCP client configuration

Point your client at the built entry point using an absolute path:

```json
{
  "mcpServers": {
    "apple-mail": {
      "command": "node",
      "args": ["/absolute/path/to/apple-mail-mcp/build/index.js"]
    }
  }
}
```

The repository's `.mcp.json` uses `build/index.js` relative to the repository root and passes no exclusions; they come from your config file. Build before launching.

## Tools

| Tool | Description |
| --- | --- |
| `list_mailboxes` | List mailboxes and unread counts across allowed accounts |
| `list_messages` | List recent messages, optionally unread only |
| `get_message` | Read an email's full content; mailbox and account are optional |
| `search_messages` | Search by subject or sender, newest first |
| `list_attachments` | List exact attachment names, MIME types (null if unavailable), approximate sizes and download status |
| `save_attachment` | Save one downloaded attachment to an existing allowed directory, without overwriting |
| `create_draft` | Save an unsent draft for review in Mail (default for composing) |
| `create_reply_draft` | Save an unsent reply to an existing email, threaded with the original |
| `send_email` | Send email with multiple recipients and optional CC/BCC |
| `get_unread_count` | Get a mailbox or total unread count |
| `move_message` | Move a message between mailboxes |
| `mark_read` | Mark a message read or unread |
| `delete_message` | Move a message to trash |
| `flag_message` | Flag or unflag a message |

### Accounts and mailboxes

Every tool finds accounts and mailboxes by walking Mail's lists rather than addressing them by name, which fails on some Exchange accounts and on nested Gmail mailboxes. Names are case-insensitive (`INBOX`, `Inbox` and `inbox` are the same) and account names also ignore spaces. `list_mailboxes` reports nested mailboxes by full path, such as `[Gmail]/All Mail` or `Sync Issues/Conflicts`; tools accept that path or just the last part (`All Mail`), and a last part shared by two mailboxes is an error listing both paths. An unknown account or mailbox is an error listing what exists, instead of an empty result.

`get_message` needs only `message_id`. Without `mailbox` it looks through the account's mailboxes, inbox first; without `account` it looks through every allowed account. The result includes the `mailbox` and `account` where the message was found, for use with other tools. Gmail also lists inbox messages under labels such as `[Gmail]/Important`, where moving or deleting only removes the label, so the inbox copy is preferred.

`search_messages` with no `account` searches every allowed account; with only `account` it searches that account. Results are sorted newest first across all mailboxes and accounts before the limit is applied, Gmail's duplicate copies under several labels are collapsed, and a mailbox Mail cannot search (common among Exchange's calendar, contacts and sync folders) is skipped instead of failing the whole search.

## Drafting mail

Use `create_draft` for composition by default. It takes `to`, `subject`, `body`, optional `cc`/`bcc` (comma-separated), and optional `from_account` (a Mail account name). It saves without sending and returns a confirmation naming the account's Drafts mailbox. Review the draft in Mail and send it yourself. `send_email` is for a direct user instruction to send.

To answer an existing email, use `create_reply_draft` with the `message_id`, `mailbox` and `account` from `list_messages` or `search_messages`, a `body`, and optional `reply_all`. It uses Mail's own reply command, so the draft gets the `Re:` subject and reply headers and stays in the original conversation; `create_draft` always starts a new thread. Mail picks the sender from the account that received the original. The draft is saved, never sent.

An explicit account uses its first configured email address as the sender. Omission resolves Mail's `primary email` to one account and checks it against exclusions before creating anything; an unresolved or ambiguous default requires `from_account`. This uses the dictionary's primary email, rather than Mail's context-sensitive automatic sender selection. Live testing selected `visible:false`: both modes saved successfully, but the visible multi-recipient trial included an unexpected extra recipient. Invisible drafts passed exact recipient checks and remained in Drafts after closing.

Mail 16 serializes AppleScript-assigned rich text through an `Apple-Mail-URLShare` wrapper, which adds a visible blank first line to drafts. Accounts listed in the config file's `nativeDraftAccounts` (or the comma-separated `APPLE_MAIL_NATIVE_DRAFT_ACCOUNTS` environment variable) avoid this: their drafts open in Mail's native `mailto:` composer, and the server waits until the new message is observable in the account's Drafts mailbox before closing the compose window. This preserves paragraph breaks and bullet lines without the leading blank. None are listed by default. Mail's composer always uses Mail's own sending account (Settings > Composing > Send new messages from) and ignores any requested sender, so list only that account; a draft for any other account would be saved in the wrong place and the tool would time out. Other accounts use the sender-explicit AppleScript path.

`send_email` resolves its sender the same way as `create_draft`: the account's address is set as `sender` on an application-level outgoing message, as Mail's dictionary defines it. Without `from_account` both tools use the config file's `defaultAccount`, or else the account owning Mail's `primary email`; on some macOS 27 setups Mail cannot report it (-10000), and the tools then ask for `from_account` rather than letting Mail choose an unchecked sender.

## Saving attachments

Call `list_attachments` first, then pass its exact `attachment_name` to `save_attachment` along with `message_id`, `mailbox`, `account` and an absolute `save_path` naming an existing directory. The result contains `savedPath` and the actual `bytes` saved. Size reported by listing is approximate; `downloaded: false` means the attachment must first be opened/downloaded in Mail.


Allowed destination roots default to the home directory, `/Volumes`, and Node's system temporary directory. Override them with `APPLE_MAIL_ATTACHMENT_SAVE_ROOTS` (colon-separated absolute directories). An empty value permits no destinations. Hidden directories, symlinks resolving outside allowed roots, and `~/Library/Keychains` are denied even with custom roots. Empty/hidden filenames and names containing separators, null bytes or `..` are rejected. Existing files are never overwritten; choose another directory or filename in a separate user-directed action.

Files are staged privately in the destination directory, copied with exclusive creation, and restricted to mode `600`. No new dependencies are required. Attachments with duplicate names in one message are rejected as ambiguous. The implementation uses Mail's attachment interface only; some attachments may not be exposed by it. When Mail cannot supply its advertised MIME type property, listing returns `mimeType: null` rather than guessing.

## Development

```bash
npx tsc --noEmit
npm test
grep -c 'assertAccountAllowed(' src/applescript.ts
```

The exclusion patch adds ten explicit account guard calls; the two attachment tools add one each and drafting adds two (explicit and resolved account), for 14 total. The TypeScript check does not exercise Mail.app. See [verification results](docs/verification.md) for automated coverage, live checks and remaining limitations.

`src/applescript.ts` contains Mail operations, `src/index.ts` registers MCP tools, and `src/config.ts` parses and enforces account exclusions.

## Upstream credit and license

The original Apple Mail implementation is by griches in [griches/apple-mcp](https://github.com/griches/apple-mcp), whose package metadata declares MIT licensing. This fork retains that declaration and credits the upstream project. The cloned repository did not contain a standalone `LICENSE` file.

The `upstream` Git remote points to `https://github.com/griches/apple-mcp.git` for tracking future changes.
