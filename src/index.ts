#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import * as applescript from "./applescript.js";
import { EXCLUDED_ACCOUNTS } from "./config.js";

const server = new McpServer({
  name: "apple-mail",
  version: "1.0.0",
});

// ---- list_mailboxes ----
server.registerTool(
  "list_mailboxes",
  {
    description: "List all mailboxes across all accounts with unread counts",
    inputSchema: z.object({}),
  },
  async () => {
    try {
      const mailboxes = await applescript.listMailboxes();
      return { content: [{ type: "text", text: JSON.stringify(mailboxes, null, 2) }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${(err as Error).message}` }], isError: true };
    }
  }
);

// ---- list_messages ----
server.registerTool(
  "list_messages",
  {
    description: "List recent messages in a mailbox, optionally filtered to unread only",
    inputSchema: z.object({
      mailbox: z.string().describe("Name of the mailbox (e.g. 'INBOX')"),
      account: z.string().describe("Name of the email account"),
      limit: z.number().optional().describe("Maximum number of messages to return (default 25)"),
      unread_only: z.boolean().optional().describe("When true, only return unread messages"),
    }),
  },
  async ({ mailbox, account, limit, unread_only }) => {
    try {
      const messages = await applescript.listMessages(mailbox, account, limit, unread_only);
      return { content: [{ type: "text", text: JSON.stringify(messages, null, 2) }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${(err as Error).message}` }], isError: true };
    }
  }
);

// ---- get_message ----
server.registerTool(
  "get_message",
  {
    description: "Get the full content of an email message by ID",
    inputSchema: z.object({
      mailbox: z.string().describe("Name of the mailbox"),
      account: z.string().describe("Name of the email account"),
      message_id: z.number().describe("ID of the message to retrieve"),
    }),
  },
  async ({ mailbox, account, message_id }) => {
    try {
      const message = await applescript.getMessage(mailbox, account, message_id);
      return { content: [{ type: "text", text: JSON.stringify(message, null, 2) }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${(err as Error).message}` }], isError: true };
    }
  }
);

// ---- search_messages ----
server.registerTool(
  "search_messages",
  {
    description: "Search emails by subject or sender across mailboxes",
    inputSchema: z.object({
      query: z.string().describe("Text to search for in email subjects or sender"),
      mailbox: z.string().optional().describe("Mailbox to search in (searches all if omitted)"),
      account: z.string().optional().describe("Account to search in (required if mailbox is specified)"),
      limit: z.number().optional().describe("Maximum number of results (default 25)"),
      search_field: z.enum(["subject", "sender"]).optional().describe("Field to search: 'subject' (default) or 'sender'"),
    }),
  },
  async ({ query, mailbox, account, limit, search_field }) => {
    try {
      const results = await applescript.searchMessages(query, mailbox, account, limit, search_field);
      return { content: [{ type: "text", text: JSON.stringify(results, null, 2) }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${(err as Error).message}` }], isError: true };
    }
  }
);

// ---- send_email ----
server.registerTool(
  "send_email",
  {
    description: "Send an email via Apple Mail",
    inputSchema: z.object({
      to: z.string().describe("Recipient email address (comma-separated for multiple recipients)"),
      subject: z.string().describe("Email subject"),
      body: z.string().describe("Email body text"),
      cc: z.string().optional().describe("CC recipient email address (comma-separated for multiple)"),
      bcc: z.string().optional().describe("BCC recipient email address (comma-separated for multiple)"),
      from_account: z.string().optional().describe("Account to send from (uses default if omitted)"),
    }),
  },
  async ({ to, subject, body, cc, bcc, from_account }) => {
    try {
      const result = await applescript.sendEmail(to, subject, body, {
        cc,
        bcc,
        from: from_account,
      });
      return { content: [{ type: "text", text: result }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${(err as Error).message}` }], isError: true };
    }
  }
);

// ---- get_unread_count ----
server.registerTool(
  "get_unread_count",
  {
    description: "Get the unread email count for a mailbox or across all mailboxes",
    inputSchema: z.object({
      mailbox: z.string().optional().describe("Mailbox name (returns total across all if omitted)"),
      account: z.string().optional().describe("Account name (required if mailbox is specified)"),
    }),
  },
  async ({ mailbox, account }) => {
    try {
      const count = await applescript.getUnreadCount(mailbox, account);
      return { content: [{ type: "text", text: JSON.stringify({ unread_count: count }, null, 2) }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${(err as Error).message}` }], isError: true };
    }
  }
);

// ---- move_message ----
server.registerTool(
  "move_message",
  {
    description: "Move an email message to a different mailbox",
    inputSchema: z.object({
      message_id: z.number().describe("ID of the message to move"),
      from_mailbox: z.string().describe("Source mailbox name"),
      from_account: z.string().describe("Source account name"),
      to_mailbox: z.string().describe("Destination mailbox name"),
      to_account: z.string().optional().describe("Destination account (same as source if omitted)"),
    }),
  },
  async ({ message_id, from_mailbox, from_account, to_mailbox, to_account }) => {
    try {
      const result = await applescript.moveMessage(message_id, from_mailbox, from_account, to_mailbox, to_account);
      return { content: [{ type: "text", text: result }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${(err as Error).message}` }], isError: true };
    }
  }
);

// ---- mark_read ----
server.registerTool(
  "mark_read",
  {
    description: "Mark an email message as read or unread",
    inputSchema: z.object({
      message_id: z.number().describe("ID of the message"),
      mailbox: z.string().describe("Mailbox the message is in"),
      account: z.string().describe("Account the mailbox belongs to"),
      read: z.boolean().describe("True to mark as read, false to mark as unread"),
    }),
  },
  async ({ message_id, mailbox, account, read }) => {
    try {
      const result = await applescript.markRead(message_id, mailbox, account, read);
      return { content: [{ type: "text", text: result }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${(err as Error).message}` }], isError: true };
    }
  }
);

// ---- delete_message ----
server.registerTool(
  "delete_message",
  {
    description: "Delete an email message (moves to trash)",
    inputSchema: z.object({
      message_id: z.number().describe("ID of the message to delete"),
      mailbox: z.string().describe("Mailbox the message is in"),
      account: z.string().describe("Account the mailbox belongs to"),
    }),
  },
  async ({ message_id, mailbox, account }) => {
    try {
      const result = await applescript.deleteMessage(message_id, mailbox, account);
      return { content: [{ type: "text", text: result }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${(err as Error).message}` }], isError: true };
    }
  }
);

// ---- flag_message ----
server.registerTool(
  "flag_message",
  {
    description: "Flag or unflag an email message",
    inputSchema: z.object({
      message_id: z.number().describe("ID of the message to flag/unflag"),
      mailbox: z.string().describe("Mailbox the message is in"),
      account: z.string().describe("Account the mailbox belongs to"),
      flagged: z.boolean().describe("True to flag, false to unflag"),
    }),
  },
  async ({ message_id, mailbox, account, flagged }) => {
    try {
      const result = await applescript.flagMessage(message_id, mailbox, account, flagged);
      return { content: [{ type: "text", text: result }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${(err as Error).message}` }], isError: true };
    }
  }
);

// ---- list_attachments ----
server.registerTool(
  "list_attachments",
  {
    description: "List attachment names, MIME types (null when unavailable from Mail), approximate sizes and download status. Call this before save_attachment to obtain the exact attachment_name.",
    inputSchema: z.object({
      message_id: z.number().int().nonnegative().safe().describe("ID of the message"),
      mailbox: z.string().describe("Mailbox containing the message"),
      account: z.string().describe("Account containing the mailbox"),
    }),
  },
  async ({ message_id, mailbox, account }) => {
    try {
      const attachments = await applescript.listAttachments(mailbox, account, message_id);
      return { content: [{ type: "text", text: JSON.stringify({ count: attachments.length, attachments }, null, 2) }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${(err as Error).message}` }], isError: true };
    }
  }
);

// ---- save_attachment ----
server.registerTool(
  "save_attachment",
  {
    description: "Save one downloaded attachment to disk without overwriting. Call list_attachments first for its exact name. save_path must be an absolute directory that already exists, within the configured allowed roots. Returns the saved path and byte count.",
    inputSchema: z.object({
      message_id: z.number().int().nonnegative().safe().describe("ID of the message"),
      mailbox: z.string().describe("Mailbox containing the message"),
      account: z.string().describe("Account containing the mailbox"),
      attachment_name: z.string().describe("Exact attachment name from list_attachments"),
      save_path: z.string().describe("Absolute path to an existing destination directory"),
    }),
  },
  async ({ message_id, mailbox, account, attachment_name, save_path }) => {
    try {
      const result = await applescript.saveAttachment(mailbox, account, message_id, attachment_name, save_path);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${(err as Error).message}` }], isError: true };
    }
  }
);

// ---- Start server ----
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Apple Mail MCP server running on stdio");
  // Echo the exclusion list to stderr so a misspelled account name is visible
  // in the client's MCP log rather than silently excluding nothing.
  if (EXCLUDED_ACCOUNTS.length > 0) {
    console.error(`Excluded accounts (${EXCLUDED_ACCOUNTS.length}): ${EXCLUDED_ACCOUNTS.join(", ")}`);
  } else {
    console.error("No account exclusions configured.");
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
