const { test } = require('node:test');
const assert = require('node:assert/strict');
process.env.APPLE_MAIL_EXCLUDE_ACCOUNTS = 'Blocked Test Account';
const { buildMailtoUrl, createDraft, normalizeDraftContent, sanitize } = require('../build/applescript.js');
const { ExcludedAccountError } = require('../build/config.js');

test('draft exclusion runs first without invoking runner', async () => {
  let calls = 0;
  await assert.rejects(createDraft(null, null, null, { from: 'blocked test account' }, async () => { calls++; }), ExcludedAccountError);
  assert.equal(calls, 0);
});

test('excluded default is rejected before creating a message', async () => {
  const scripts = [];
  await assert.rejects(createDraft('a@example.invalid', 'Test', 'Body', undefined, async script => {
    scripts.push(script); return 'Blocked Test Account|||blocked@example.invalid';
  }), ExcludedAccountError);
  assert.equal(scripts.length, 1);
  assert.ok(scripts[0].includes('primary email'));
  assert.ok(!scripts[0].includes('make new outgoing message'));
});

for (const [label, to, options, expected] of [
  ['one', 'one@example.invalid', undefined, { to: ['one@example.invalid'], cc: [], bcc: [] }],
  ['several', ' one@example.invalid, ,two@example.invalid,', { from: 'Allowed' }, { to: ['one@example.invalid', 'two@example.invalid'], cc: [], bcc: [] }],
  ['cc and bcc', 'one@example.invalid', { cc: ' c@example.invalid, d@example.invalid ', bcc: 'b@example.invalid' }, { to: ['one@example.invalid'], cc: ['c@example.invalid', 'd@example.invalid'], bcc: ['b@example.invalid'] }],
]) {
  test(`draft renders ${label} recipients and only saves`, async () => {
    const scripts = [];
    const confirmation = await createDraft(to, 'Test', 'Body', options, async script => {
      scripts.push(script);
      return scripts.length === 1 ? 'Allowed|||me@example.invalid' : 'Draft saved in Drafts for Allowed: Test';
    });
    assert.equal(scripts.length, 2);
    for (const script of scripts) assert.doesNotMatch(script, /\bsend\s/);
    const script = scripts[1];
    assert.match(script, /save newMessage/);
    assert.match(script, /visible:false/);
    assert.match(script, /make new outgoing message with properties \{sender:"me@example.invalid"/);
    assert.doesNotMatch(script, /outgoing message of account/);
    for (const kind of ['to', 'cc', 'bcc']) {
      assert.equal((script.match(new RegExp(`make new ${kind} recipient`, 'g')) || []).length, expected[kind].length);
      for (const address of expected[kind]) assert.ok(script.includes(`make new ${kind} recipient at end of ${kind} recipients with properties {address:"${address}"}`));
    }
    assert.equal(confirmation, 'Draft saved in Drafts for Allowed: Test');
  });
}

test('all caller and resolved values are escaped', async () => {
  const input = 'a"\\b\r\nc';
  const scripts = [];
  await createDraft(input, input, input, { from: input, cc: input, bcc: input }, async script => {
    scripts.push(script); return scripts.length === 1 ? `${input}|||${input}` : 'ok';
  });
  assert.ok(scripts[0].includes(`candidateName is "${sanitize(input)}"`));
  for (const property of ['sender', 'subject', 'content', 'address']) assert.ok(scripts[1].includes(`${property}:"${sanitize(input)}"`));
});

test('lookup failure or invalid metadata never creates a message', async () => {
  for (const output of ['', 'Allowed|||', 'Allowed|||address|||unexpected']) {
    let calls = 0;
    await assert.rejects(createDraft('a', 'b', 'c', undefined, async () => { calls++; return output; }), /Cannot resolve/);
    assert.equal(calls, 1);
  }
  await assert.rejects(createDraft('a', 'b', 'c', undefined, async () => { throw new Error('lookup failed'); }), /lookup failed/);
});

test('affected account uses native Mail composer without sending', async () => {
  const scripts = [];
  const urls = [];
  const body = 'Hi team,\n\n- Alpha\n- Beta\n\nRegards';
  const result = await createDraft(
    ' one@example.invalid, two@example.invalid ',
    'Test & review',
    body,
    { from: 'President Email', cc: 'c@example.invalid', bcc: 'b@example.invalid' },
    async script => {
      scripts.push(script);
      if (scripts.length === 1) return 'President Email|||president@example.invalid';
      if (scripts.length === 2) return '101, 202|||1';
      return 'Draft saved in Drafts for President Email: Test & review';
    },
    async url => { urls.push(url); }
  );

  assert.equal(urls.length, 1);
  assert.equal(urls[0], buildMailtoUrl(
    ['one@example.invalid', 'two@example.invalid'],
    'Test & review',
    body,
    ['c@example.invalid'],
    ['b@example.invalid']
  ));
  assert.match(urls[0], /^mailto:one%40example\.invalid,two%40example\.invalid\?/);
  assert.ok(urls[0].includes('body=Hi%20team%2C%0A%0A-%20Alpha%0A-%20Beta%0A%0ARegards'));
  assert.equal(scripts.length, 3);
  assert.match(scripts[2], /set previousWindowIds to \{101, 202\}/);
  assert.match(scripts[2], /set previousDraftCount to 1/);
  assert.match(scripts[2], /if not savedDraftFound then error "Timed out waiting for Mail to save draft"/);
  assert.match(scripts[2], /close draftWindow saving yes/);
  for (const script of scripts) {
    assert.doesNotMatch(script, /make new outgoing message/);
    assert.doesNotMatch(script, /\bsend\s/);
  }
  assert.equal(result, 'Draft saved in Drafts for President Email: Test & review');
});

test('native draft content drops only Mail HTML bridge terminal space', () => {
  const body = 'Hi team,\n\n- Alpha\n- Beta\n\nRegards';
  assert.equal(normalizeDraftContent('Drafts', `${body} `), body);
  assert.equal(normalizeDraftContent('INBOX', `${body} `), `${body} `);
  assert.equal(normalizeDraftContent('Drafts', `\n${body} \n`), `\n${body} \n`);
});
