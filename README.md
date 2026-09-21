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
node build/index.js --exclude-accounts "Personal Gmail,iCloud"
```

Run this fork from its local build. The upstream npm package `@griches/apple-mail-mcp` does not include this fork's account-exclusion changes.

## Account exclusion

Configure excluded accounts by their names in Mail:

```bash
node build/index.js --exclude-accounts "Personal Gmail,iCloud"
node build/index.js --exclude-accounts="Personal Gmail" --exclude-accounts=iCloud
APPLE_MAIL_EXCLUDE_ACCOUNTS="Personal Gmail,iCloud" node build/index.js
```

CLI and environment lists are merged. Names are trimmed, matched case-insensitively and deduplicated. No accounts are excluded by default. The server logs its configured exclusions to stderr at startup; a misspelled or renamed account will not match.

Enumeration skips excluded accounts in mailbox listings, unscoped searches and total unread counts. Operations explicitly naming an excluded account fail before AppleScript runs. Message moves check both source and destination. Mailbox listings and search results also receive a TypeScript filter as a second check.

This is an application-level filter, not a macOS permission boundary. The existing `send_email` tool checks an explicitly supplied `from_account`; omitting that parameter leaves sender selection to Mail and does not check the default account against the exclusion list. The new `create_draft` tool checks both explicitly named and resolved default accounts before creating a draft. The existing `send_email` tool still has no additional approval gate.

## MCP client configuration

Point your client at the built entry point using an absolute path:

```json
{
  "mcpServers": {
    "apple-mail": {
      "command": "node",
      "args": [
        "/absolute/path/to/apple-mail-mcp/build/index.js",
        "--exclude-accounts",
        "Personal Gmail,iCloud"
      ]
    }
  }
}
```

The repository's `.mcp.json` uses `build/index.js` relative to the repository root. Build before launching, and configure your own exclusions before using it.

## Tools

| Tool | Description |
| --- | --- |
| `list_mailboxes` | List mailboxes and unread counts across allowed accounts |
| `list_messages` | List recent messages, optionally unread only |
| `get_message` | Read an email's full content |
| `search_messages` | Search by subject or sender |
| `list_attachments` | List exact attachment names, MIME types (null if unavailable), approximate sizes and download status |
| `save_attachment` | Save one downloaded attachment to an existing allowed directory, without overwriting |
| `create_draft` | Save an unsent draft for review in Mail (default for composing) |
| `send_email` | Send email with multiple recipients and optional CC/BCC |
| `get_unread_count` | Get a mailbox or total unread count |
| `move_message` | Move a message between mailboxes |
| `mark_read` | Mark a message read or unread |
| `delete_message` | Move a message to trash |
| `flag_message` | Flag or unflag a message |

## Drafting mail

Use `create_draft` for composition by default. It takes `to`, `subject`, `body`, optional `cc`/`bcc` (comma-separated), and optional `from_account` (a Mail account name). It saves without sending and returns a confirmation naming the account's Drafts mailbox. Review the draft in Mail and send it yourself. `send_email` is for a direct user instruction to send.

An explicit account uses its first configured email address as the sender. Omission resolves Mail's `primary email` to one account and checks it against exclusions before creating anything; an unresolved or ambiguous default requires `from_account`. This uses the dictionary's primary email, rather than Mail's context-sensitive automatic sender selection. Live testing selected `visible:false`: both modes saved successfully, but the visible multi-recipient trial included an unexpected extra recipient. Invisible drafts passed exact recipient checks and remained in Drafts after closing.

`send_email` remains unchanged. Its existing `make new outgoing message of account ...` construction is inconsistent with Mail's dictionary (outgoing messages belong to the application); a separate fix should resolve the account address and set `sender`, and check default-account exclusion as drafting does.

## Saving attachments

Call `list_attachments` first, then pass its exact `attachment_name` to `save_attachment` along with `message_id`, `mailbox`, `account` and an absolute `save_path` naming an existing directory. The result contains `savedPath` and the actual `bytes` saved. Size reported by listing is approximate; `downloaded: false` means the attachment must first be opened/downloaded in Mail.

Current limitation: attachment lookup resolves only mailboxes directly addressable as `mailbox <name> of account <name>`. Gmail's `All Mail` is exposed by Mail as nested `[Gmail]/All Mail`, so passing `mailbox: "All Mail"` currently fails with AppleEvent -1728 even though the message and attachment are present. `INBOX` was verified live; nested mailbox resolution remains to be implemented.

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
