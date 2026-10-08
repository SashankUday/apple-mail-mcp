const { test } = require('node:test');
const assert = require('node:assert/strict');
process.env.APPLE_MAIL_EXCLUDE_ACCOUNTS = 'Blocked Test Account';
const { createReplyDraft, sanitize } = require('../build/applescript.js');
const { ExcludedAccountError } = require('../build/config.js');

test('reply draft exclusion and id validation run before the runner', async () => {
  let calls = 0;
  const runner = async () => { calls++; return ''; };
  await assert.rejects(createReplyDraft('INBOX', 'blocked test account', 1, 'Body', undefined, runner), ExcludedAccountError);
  for (const id of [-1, 1.5, Number.NaN]) {
    await assert.rejects(createReplyDraft('INBOX', 'Allowed', id, 'Body', undefined, runner), /Invalid message id/);
  }
  assert.equal(calls, 0);
});

test('reply draft uses Mail reply on the original message and only saves', async () => {
  const scripts = [];
  const body = 'Thanks "all"\\\nSee you then';
  const result = await createReplyDraft('Inbox', 'Allowed', 42, body, undefined, async script => {
    scripts.push(script);
    return 'Re: Plans|||Me <me@example.invalid>';
  });
  assert.equal(scripts.length, 1);
  const [script] = scripts;
  assert.ok(script.includes('candidateName is "Allowed"'));
  assert.ok(script.includes('(name of candidateMb) is "Inbox"'));
  assert.ok(script.includes('whose id is 42'));
  assert.ok(script.includes('set replyMsg to reply originalMsg opening window false reply to all false'));
  assert.ok(script.includes(`set content of replyMsg to "${sanitize(body)}"`));
  assert.ok(script.includes('save replyMsg'));
  assert.doesNotMatch(script, /make new outgoing message/);
  assert.doesNotMatch(script, /\bsend\s/);
  assert.equal(result, 'Reply draft saved in Drafts from Me <me@example.invalid>: Re: Plans');
});

test('reply all is passed through to Mail', async () => {
  let script = '';
  await createReplyDraft('INBOX', 'Allowed', 7, 'Body', { replyAll: true }, async s => { script = s; return 'Re: x|||'; });
  assert.ok(script.includes('reply to all true'));
});
