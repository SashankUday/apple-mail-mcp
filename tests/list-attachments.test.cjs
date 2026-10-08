const { test } = require('node:test');
const assert = require('node:assert/strict');
process.env.APPLE_MAIL_EXCLUDE_ACCOUNTS = 'Blocked Test Account';
const { listAttachments, sanitize } = require('../build/applescript.js');
const { ExcludedAccountError } = require('../build/config.js');

test('excluded account fails before script execution or input processing', async () => {
  let calls = 0;
  await assert.rejects(listAttachments(null, 'blocked test account', NaN, async () => { calls++; }), ExcludedAccountError);
  assert.equal(calls, 0);
});

test('attachment metadata preserves exact names and downloaded status', async () => {
  const mailbox = 'Inbox "quoted"\\folder\nnext';
  const account = 'Allowed "quoted"\\name';
  const attachments = await listAttachments(mailbox, account, 42, async script => {
    assert.ok(script.includes(`candidateName is "${sanitize(account)}"`));
    assert.ok(script.includes(`candidateMbName is "${sanitize(mailbox)}"`));
    assert.ok(!script.includes('of account "'));
    assert.ok(script.includes('whose id is 42'));
    assert.ok(script.includes('mail attachments of m'));
    assert.ok(script.includes('downloaded of att'));
    return ' résumé |||final.pdf |||application/pdf|||123|||true<<<>>>second.txt|||text/plain|||0|||false';
  });
  assert.deepEqual(attachments, [
    { name: ' résumé |||final.pdf ', mimeType: 'application/pdf', size: 123, downloaded: true },
    { name: 'second.txt', mimeType: 'text/plain', size: 0, downloaded: false },
  ]);
});

test('no attachments returns an empty array; runner errors propagate', async () => {
  assert.deepEqual(await listAttachments('Inbox', 'Allowed', 1, async () => ''), []);
  await assert.rejects(listAttachments('Inbox', 'Allowed', 1, async () => { throw new Error('Message not found'); }), /Message not found/);
});

test('invalid message ids never reach the runner', async () => {
  for (const id of [NaN, Infinity, 1.5, -1, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(listAttachments('Inbox', 'Allowed', id, async () => assert.fail('runner invoked')), /Invalid message id/);
  }
});


test('unavailable MIME metadata is explicit and does not discard attachments', async () => {
  assert.deepEqual(await listAttachments('Inbox', 'Allowed', 1, async () => 'file.pdf||||||123|||true'),
    [{ name: 'file.pdf', mimeType: null, size: 123, downloaded: true }]);
});
