const { test } = require('node:test');
const assert = require('node:assert/strict');
process.env.APPLE_MAIL_EXCLUDE_ACCOUNTS = 'Blocked Test Account';
const { resolveTargetScript, listMailboxes, getMessage, searchMessages, sendEmail, createDraft, normalizeDraftContent } = require('../build/applescript.js');
const { ExcludedAccountError } = require('../build/config.js');

test('mailbox paths match the full path; leaf names match any depth', () => {
  const byPath = resolveTargetScript('Personal Gmail', '[Gmail]/All Mail');
  assert.ok(byPath.includes('(name of candidateMb) is "All Mail"'), 'leaf compared first');
  assert.ok(byPath.includes('if candidateMbPath is "[Gmail]/All Mail" then'), 'then the full path');
  const byLeaf = resolveTargetScript('Personal Gmail', 'All Mail');
  assert.ok(byLeaf.includes('(name of candidateMb) is "All Mail"'));
  assert.ok(byLeaf.includes('if true then'), 'any path accepted for a bare leaf');
  assert.ok(byLeaf.includes('is ambiguous in account'), 'shared leaf names are an error, not a guess');
  assert.ok(byLeaf.includes('get account of pathParent'), 'path walk stops at the account');
});

test('excluded accounts are rejected inside the resolver script', () => {
  assert.match(resolveTargetScript('Allowed'), /if \(name of acct\) is "Blocked Test Account" then error/);
});

test('list_mailboxes reports full paths and skips excluded accounts in AppleScript', async () => {
  let script = '';
  const rows = await listMailboxes(async s => { script = s; return '[Gmail]/All Mail|||Personal Gmail|||3<<<>>>INBOX|||Blocked Test Account|||1'; });
  assert.ok(script.includes('set mbName to name of mb'));
  assert.ok(script.includes('set mbName to (name of pathParent) & "/" & mbName'));
  assert.ok(script.includes('if not (acctName is "Blocked Test Account") then'));
  assert.deepEqual(rows, [{ name: '[Gmail]/All Mail', account: 'Personal Gmail', unreadCount: 3 }]);
});

test('get_message without a mailbox searches inboxes first and reports where it found the message', async () => {
  let script = '';
  const raw = ['7', 'Hi', 'a@example.invalid', 'Monday', 'true', 'Body ', 'b@example.invalid', '', '[Gmail]/Drafts', 'Personal Gmail'].join('<<<>>>');
  const message = await getMessage(undefined, 'Personal Gmail', 7, async s => { script = s; return raw; });
  assert.ok(script.includes('repeat with searchPass from 1 to 2'));
  assert.ok(script.includes('set isInbox to ((name of candidateMb) is "INBOX")'));
  assert.ok(script.includes('whose id is 7'));
  assert.equal(message.mailbox, '[Gmail]/Drafts');
  assert.equal(message.account, 'Personal Gmail');
  assert.equal(message.content, 'Body', 'nested Drafts gets the native-draft normalisation');
});

test('get_message validates arguments before running Mail', async () => {
  let calls = 0;
  const runner = async () => { calls++; return ''; };
  await assert.rejects(getMessage('INBOX', undefined, 1, runner), /only be given together with its account/);
  await assert.rejects(getMessage(undefined, 'Blocked Test Account', 1, runner), ExcludedAccountError);
  await assert.rejects(getMessage(undefined, undefined, -1, runner), /Invalid message id/);
  assert.equal(calls, 0);
});

test('get_message never returns a message from an excluded account', async () => {
  const raw = ['7', 'Hi', 'a', 'b', 'true', 'c', '', '', 'INBOX', 'Blocked Test Account'].join('<<<>>>');
  await assert.rejects(getMessage(undefined, undefined, 7, async () => raw), ExcludedAccountError);
});

test('all-account search isolates mailbox errors and sorts newest first across accounts', async () => {
  let script = '';
  const raw = [
    '1|||Old|||a|||d1|||INBOX|||Work|||2024-01-01T09:00:00',
    '2|||New|||b|||d2|||[Gmail]/All Mail|||Home|||2026-10-01T09:00:00',
    '3|||Mid|||c|||d3|||Inbox|||Exchange|||2025-06-01T09:00:00',
  ].join('<<<>>>');
  const rows = await searchMessages('report', undefined, undefined, 2, 'subject', async s => { script = s; return raw; });
  assert.match(script, /repeat with mb in mailboxes of acct\s+try/);
  assert.ok(script.includes('if seenIds does not contain matchId then'), 'Gmail label duplicates skipped');
  assert.ok(script.includes('if takeCount >= 2 then exit repeat'), 'per-mailbox cap, not a global first-come cap');
  assert.equal(script.split('whose subject contains "report"').length, 2, 'one filter pass per mailbox');
  assert.deepEqual(rows.map(r => r.id), [2, 3]);
  assert.equal(rows[0].mailbox, '[Gmail]/All Mail');
  assert.ok(!('sortKey' in rows[0]));
});

test('search with only an account is scoped to that account', async () => {
  let script = '';
  await searchMessages('x', undefined, 'Exchange', undefined, 'sender', async s => { script = s; return ''; });
  assert.ok(script.includes('candidateName is "Exchange"'));
  assert.ok(!script.includes('repeat with acct in accounts'));
  assert.ok(script.includes('every message of mb whose sender contains "x"'));
});

test('send_email sets the sender address instead of an account-scoped outgoing message', async () => {
  let script = '';
  await sendEmail('to@example.invalid', 'S', 'B', { from: 'Exchange' }, async s => { script = s; return 'ok'; });
  assert.ok(!script.includes('outgoing message of account'));
  assert.ok(script.includes('candidateName is "Exchange"'));
  assert.ok(script.includes('make new outgoing message with properties {sender:chosenAddress,'));
});

test('an excluded default account is rejected inside AppleScript before its address is returned', async () => {
  for (const run of [
    runner => sendEmail('to@example.invalid', 'S', 'B', undefined, runner),
    runner => createDraft('to@example.invalid', 'S', 'B', undefined, runner).catch(() => {}),
  ]) {
    let script = '';
    await run(async s => { script ||= s; return 'Allowed|||a@example.invalid'; });
    const check = script.indexOf('if (name of chosenAccount) is "Blocked Test Account" then error');
    assert.ok(check > 0, 'exclusion check present');
    assert.ok(check < script.indexOf('return'), 'and before anything is returned');
  }
});

test('draft normalisation recognises nested Drafts mailboxes', () => {
  assert.equal(normalizeDraftContent('[Gmail]/Drafts', 'Body '), 'Body');
  assert.equal(normalizeDraftContent('[Gmail]/All Mail', 'Body '), 'Body ');
});
