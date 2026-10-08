const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdirSync, mkdtempSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
const { configFilePath, parseExcludedAccounts, readConfigExclusions } = require('../build/config.js');

const serverPath = path.resolve(__dirname, '../build/index.js');

function homeWithConfig(contents) {
  const home = mkdtempSync(path.join(tmpdir(), 'mail-mcp-home-'));
  if (contents !== undefined) {
    mkdirSync(path.dirname(configFilePath(home)), { recursive: true });
    writeFileSync(configFilePath(home), contents);
  }
  return home;
}

test('config file lives under ~/.config, outside the repository', () => {
  assert.equal(configFilePath('/Users/x'), '/Users/x/.config/apple-mail-mcp/config.json');
});

test('config exclusions merge with flags and environment', () => {
  const home = homeWithConfig(JSON.stringify({ excludeAccounts: ['Config Account', 'shared'] }));
  const names = parseExcludedAccounts(['--exclude-accounts', 'Flag Account,Shared'], { APPLE_MAIL_EXCLUDE_ACCOUNTS: 'Env Account' }, configFilePath(home));
  assert.deepEqual(names, ['Config Account', 'shared', 'Flag Account', 'Env Account']);
});

test('a missing config file adds nothing', () => {
  assert.deepEqual(readConfigExclusions(configFilePath(homeWithConfig())), []);
});

test('an unreadable or malformed config file refuses to load', () => {
  for (const contents of ['{not json', '{}', '{"excludeAccounts": "One Account"}', '{"excludeAccounts": [1]}', 'null']) {
    assert.throws(() => readConfigExclusions(configFilePath(homeWithConfig(contents))), /refusing to start/, contents);
  }
});

test('the server enforces config-file exclusions without any flag', async t => {
  const home = homeWithConfig(JSON.stringify({ excludeAccounts: ['Config Only Account'] }));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    env: { HOME: home, PATH: process.env.PATH },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'config-tests', version: '1.0.0' });
  t.after(() => client.close());
  await client.connect(transport);
  for (const [name, args] of [
    ['get_message', { message_id: 1, account: 'config only account' }],
    ['create_draft', { to: 'a@example.invalid', subject: 'S', body: 'B', from_account: 'Config Only Account' }],
    ['send_email', { to: 'a@example.invalid', subject: 'S', body: 'B', from_account: 'Config Only Account' }],
  ]) {
    const result = await client.callTool({ name, arguments: args });
    assert.equal(result.isError, true, name);
    assert.match(result.content[0].text, /excluded from this MCP server/, name);
  }
});

test('the server will not start with a malformed config file', () => {
  const home = homeWithConfig('{"excludeAccounts": "Config Only Account"}');
  const run = spawnSync(process.execPath, [serverPath], { env: { HOME: home, PATH: process.env.PATH }, input: '', timeout: 10000, encoding: 'utf8' });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /refusing to start without its account exclusions/);
});

test('defaultAccount is optional, trimmed and validated; unknown keys are refused', () => {
  const read = contents => require('../build/config.js').readConfigFile(configFilePath(homeWithConfig(contents)));
  assert.deepEqual(read('{"excludeAccounts": [], "defaultAccount": " iCloud "}'), { excludeAccounts: [], defaultAccount: 'iCloud', nativeDraftAccounts: [] });
  assert.deepEqual(read('{"excludeAccounts": [], "nativeDraftAccounts": ["Work"]}').nativeDraftAccounts, ['Work']);
  assert.equal(read('{"excludeAccounts": []}').defaultAccount, undefined);
  for (const contents of ['{"excludeAccounts": [], "defaultAccount": ""}', '{"excludeAccounts": [], "defaultAccount": 3}', '{"excludeAccount": ["Typo"]}', '{"excludeAccounts": [], "defaultAcount": "x"}', '{"excludeAccounts": [], "nativeDraftAccounts": "Work"}']) {
    assert.throws(() => read(contents), /refusing to start/, contents);
  }
});

test('the server will not start when the default account is also excluded', () => {
  const home = homeWithConfig('{"excludeAccounts": ["Both"], "defaultAccount": "both"}');
  const run = spawnSync(process.execPath, [serverPath], { env: { HOME: home, PATH: process.env.PATH }, input: '', timeout: 10000, encoding: 'utf8' });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /default account "both" is also excluded/);
});

test('drafts and emails without from_account use the configured default account', () => {
  const home = homeWithConfig('{"excludeAccounts": [], "defaultAccount": "Configured Default"}');
  const script = `
    const { createDraft, sendEmail } = require(${JSON.stringify(path.resolve(__dirname, '../build/applescript.js'))});
    (async () => {
      const scripts = [];
      await createDraft('a@example.invalid', 'S', 'B', undefined, async s => { scripts.push(s); throw new Error('stop'); }).catch(() => {});
      await sendEmail('a@example.invalid', 'S', 'B', undefined, async s => { scripts.push(s); return 'ok'; });
      await createDraft('a@example.invalid', 'S', 'B', { from: 'Named' }, async s => { scripts.push(s); throw new Error('stop'); }).catch(() => {});
      console.log(JSON.stringify(scripts.map(s => [s.includes('candidateName is "Configured Default"'), s.includes('primary email'), s.includes('candidateName is "Named"')])));
    })();`;
  const run = spawnSync(process.execPath, ['-e', script], { env: { HOME: home, PATH: process.env.PATH }, encoding: 'utf8' });
  assert.deepEqual(JSON.parse(run.stdout), [[true, false, false], [true, false, false], [false, false, true]]);
});

test('no account uses the native composer unless configured', () => {
  const check = `console.log(JSON.stringify(require(${JSON.stringify(path.resolve(__dirname, '../build/config.js'))}).NATIVE_DRAFT_ACCOUNTS))`;
  const run = (home, extra = {}) => JSON.parse(spawnSync(process.execPath, ['-e', check], { env: { HOME: home, PATH: process.env.PATH, ...extra }, encoding: 'utf8' }).stdout);
  assert.deepEqual(run(homeWithConfig()), []);
  assert.deepEqual(run(homeWithConfig('{"excludeAccounts": [], "nativeDraftAccounts": ["Work"]}'), { APPLE_MAIL_NATIVE_DRAFT_ACCOUNTS: 'Other' }), ['Work', 'Other']);
});
