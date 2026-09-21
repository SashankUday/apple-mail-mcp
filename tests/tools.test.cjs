const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');

test('new tools expose described schemas and return MCP errors for excluded accounts', async t => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.resolve(__dirname, '../build/index.js'), '--exclude-accounts', 'Blocked Test Account'],
    stderr: 'pipe',
  });
  const client = new Client({ name: 'local-tests', version: '1.0.0' });
  t.after(() => client.close());
  await client.connect(transport);
  const { tools } = await client.listTools();
  for (const name of ['create_draft', 'list_attachments', 'save_attachment']) {
    const tool = tools.find(t => t.name === name);
    assert.ok(tool, name);
    for (const [field, schema] of Object.entries(tool.inputSchema.properties)) assert.ok(schema.description, `${name}.${field}`);
  }
  const description = tools.find(t => t.name === 'create_draft').description;
  assert.match(description, /default tool for composing mail/);
  assert.match(description, /send_email only when the user directly instructs/);
  for (const [name, args] of [
    ['create_draft', { to: 'a@example.invalid', subject: 'Test', body: 'Body', from_account: 'Blocked Test Account' }],
    ['list_attachments', { message_id: 1, mailbox: 'Inbox', account: 'Blocked Test Account' }],
    ['save_attachment', { message_id: 1, mailbox: 'Inbox', account: 'Blocked Test Account', attachment_name: 'test.pdf', save_path: '/tmp' }],
  ]) {
    const result = await client.callTool({ name, arguments: args });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /excluded from this MCP server/);
  }
});
