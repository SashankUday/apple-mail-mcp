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

This is an application-level filter, not a macOS permission boundary. The existing `send_email` tool checks an explicitly supplied `from_account`; omitting that parameter leaves sender selection to Mail and does not check the default account against the exclusion list. This fork currently has no draft tool or additional approval gate for sending.

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
| `send_email` | Send email with multiple recipients and optional CC/BCC |
| `get_unread_count` | Get a mailbox or total unread count |
| `move_message` | Move a message between mailboxes |
| `mark_read` | Mark a message read or unread |
| `delete_message` | Move a message to trash |
| `flag_message` | Flag or unflag a message |

## Development

```bash
npx tsc --noEmit
grep -c 'assertAccountAllowed(' src/applescript.ts
```

The exclusion patch adds ten explicit account guard calls; attachment listing adds one. The TypeScript check does not exercise Mail.app; live behavior requires separate macOS testing.

`src/applescript.ts` contains Mail operations, `src/index.ts` registers MCP tools, and `src/config.ts` parses and enforces account exclusions.

## Upstream credit and license

The original Apple Mail implementation is by griches in [griches/apple-mcp](https://github.com/griches/apple-mcp), whose package metadata declares MIT licensing. This fork retains that declaration and credits the upstream project. The cloned repository did not contain a standalone `LICENSE` file.

The `upstream` Git remote points to `https://github.com/griches/apple-mcp.git` for tracking future changes.
