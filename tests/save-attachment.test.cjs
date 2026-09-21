const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
process.env.APPLE_MAIL_EXCLUDE_ACCOUNTS = 'Blocked Test Account';
const { saveAttachment, validateAttachmentName, validateAttachmentDirectory, sanitize } = require('../build/applescript.js');
const { ExcludedAccountError } = require('../build/config.js');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mail-attachment-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return fs.realpathSync.native(dir);
}
function stagingFile(dir) {
  const stages = fs.readdirSync(dir).filter(n => n.startsWith('.apple-mail-attachment-'));
  assert.equal(stages.length, 1);
  const stage = path.join(dir, stages[0]);
  assert.equal(fs.statSync(stage).mode & 0o777, 0o700);
  return path.join(stage, 'attachment');
}
function noStaging(dir) {
  assert.deepEqual(fs.readdirSync(dir).filter(n => n.startsWith('.apple-mail-attachment-')), []);
}

test('attachment names reject traversal, separators, nulls and hidden files', () => {
  for (const name of ['../etc/passwd', 'a/b.pdf', 'a\\b.pdf', 'a\0.pdf', '..', 'a..pdf', '', '.bashrc']) {
    assert.throws(() => validateAttachmentName(name), /Invalid attachment name/);
  }
  for (const name of ['Student Resource Pack v2.final.pdf', 'résumé 日本語.pdf', 'ordinary.txt']) {
    assert.doesNotThrow(() => validateAttachmentName(name));
  }
});

test('directory validation rejects relative, missing, file, hidden, denied and symlink destinations', t => {
  const dir = fixture(t);
  fs.writeFileSync(path.join(dir, 'file'), 'original');
  const hidden = path.join(dir, '.hidden');
  fs.mkdirSync(hidden);
  fs.symlinkSync(hidden, path.join(dir, 'alias'));
  for (const target of ['relative', path.join(dir, 'missing'), path.join(dir, 'file'), hidden, path.join(dir, 'alias'),
    path.join(os.homedir(), '.ssh'), path.join(os.homedir(), 'Library', 'Keychains'), path.join(os.homedir(), 'library', 'keychains')]) {
    assert.throws(() => validateAttachmentDirectory(target), undefined, target);
  }
  assert.equal(validateAttachmentDirectory(dir), dir);
  assert.equal(validateAttachmentDirectory(os.homedir()), fs.realpathSync.native(os.homedir()));
});

test('configured roots replace defaults and reject sibling prefixes and symlink escapes', t => {
  const dir = fixture(t);
  const allowed = path.join(dir, 'allowed');
  const sibling = path.join(dir, 'allowed-other');
  fs.mkdirSync(allowed); fs.mkdirSync(sibling);
  fs.symlinkSync(sibling, path.join(allowed, 'escape'));
  const previous = process.env.APPLE_MAIL_ATTACHMENT_SAVE_ROOTS;
  t.after(() => previous === undefined ? delete process.env.APPLE_MAIL_ATTACHMENT_SAVE_ROOTS : process.env.APPLE_MAIL_ATTACHMENT_SAVE_ROOTS = previous);
  process.env.APPLE_MAIL_ATTACHMENT_SAVE_ROOTS = allowed;
  assert.equal(validateAttachmentDirectory(allowed), allowed);
  assert.throws(() => validateAttachmentDirectory(sibling), /outside/);
  assert.throws(() => validateAttachmentDirectory(path.join(allowed, 'escape')), /outside/);
  process.env.APPLE_MAIL_ATTACHMENT_SAVE_ROOTS = '';
  assert.throws(() => validateAttachmentDirectory(allowed), /outside/);
  process.env.APPLE_MAIL_ATTACHMENT_SAVE_ROOTS = dir;
  fs.mkdirSync(path.join(dir, '.hidden'));
  assert.throws(() => validateAttachmentDirectory(path.join(dir, '.hidden')), /hidden/);
});

test('save writes exact bytes privately and removes staging', async t => {
  const dir = fixture(t);
  const name = 'résumé 日本語 v2.final.pdf';
  const bytes = Buffer.alloc(10 * 1024 * 1024, 65);
  const mailbox = 'Inbox "quoted"\\folder\nnext';
  const account = 'Allowed "quoted"\\account';
  const result = await saveAttachment(mailbox, account, 42, name, dir, async script => {
    assert.ok(script.includes(`mailbox "${sanitize(mailbox)}" of account "${sanitize(account)}"`));
    assert.ok(script.includes('whose id is 42'));
    assert.ok(script.includes(`whose name is "${name}"`));
    assert.ok(script.includes('if not (downloaded of att)'));
    assert.ok(script.includes('considering case'));
    const staged = stagingFile(dir);
    assert.ok(script.includes(`save att in POSIX file "${sanitize(staged)}"`));
    fs.writeFileSync(staged, bytes);
    return '';
  });
  assert.deepEqual(result, { savedPath: path.join(dir, name), bytes: bytes.length });
  assert.deepEqual(fs.readFileSync(result.savedPath), bytes);
  assert.equal(fs.statSync(result.savedPath).mode & 0o777, 0o600);
  noStaging(dir);
});

test('COPYFILE_EXCL preserves a destination created while Mail writes', async t => {
  const dir = fixture(t);
  const destination = path.join(dir, 'test.pdf');
  await assert.rejects(saveAttachment('Inbox', 'Allowed', 1, 'test.pdf', dir, async () => {
    fs.writeFileSync(stagingFile(dir), 'replacement');
    fs.writeFileSync(destination, 'original');
    return '';
  }), /Destination already exists/);
  assert.equal(fs.readFileSync(destination, 'utf8'), 'original');
  noStaging(dir);
});

test('existing symlink is not followed or overwritten', async t => {
  const dir = fixture(t);
  const target = path.join(dir, 'target');
  fs.writeFileSync(target, 'original');
  fs.symlinkSync(target, path.join(dir, 'test.pdf'));
  await assert.rejects(saveAttachment('Inbox', 'Allowed', 1, 'test.pdf', dir, async () => {
    fs.writeFileSync(stagingFile(dir), 'replacement'); return '';
  }), /Destination already exists/);
  assert.equal(fs.readFileSync(target, 'utf8'), 'original');
  assert.ok(fs.lstatSync(path.join(dir, 'test.pdf')).isSymbolicLink());
  noStaging(dir);
});

test('runner failures, missing saves and nonregular staged files all clean staging', async t => {
  const dir = fixture(t);
  for (const runner of [async () => { throw new Error('Not downloaded'); }, async () => '', async () => {
    fs.symlinkSync(__filename, stagingFile(dir)); return '';
  }]) {
    await assert.rejects(saveAttachment('Inbox', 'Allowed', 1, 'test.pdf', dir, runner));
    assert.equal(fs.existsSync(path.join(dir, 'test.pdf')), false);
    noStaging(dir);
  }
});

test('excluded account is checked before names, directories or runner', async () => {
  let calls = 0;
  await assert.rejects(saveAttachment(null, 'BLOCKED TEST ACCOUNT', NaN, null, null, async () => { calls++; }), ExcludedAccountError);
  assert.equal(calls, 0);
});
