const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const flow = JSON.parse(fs.readFileSync(path.join(__dirname, 'flow.json'), 'utf8'));
const recheckCode = flow.flowPlugins.find(plugin => plugin.id === 'original_recheck').inputsDB.code;

function loadPlugin(code) {
  const module = { exports: {} };
  new Function('module', 'require', code)(module, require);
  return module.exports;
}

function makeSnapshot(filePath, hash) {
  const stat = fs.statSync(filePath, { bigint: true });
  return {
    path: filePath,
    realPath: fs.realpathSync(filePath),
    dev: String(stat.dev),
    ino: String(stat.ino),
    size: String(stat.size),
    mtimeNs: String(stat.mtimeNs),
    ctimeNs: String(stat.ctimeNs),
    contentHash: hash
  };
}

function createFixture(t, initialBytes) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tdarr-mover-recheck-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const original = path.join(dir, 'original.mkv');
  const candidate = path.join(dir, 'candidate.mkv');
  fs.writeFileSync(original, initialBytes);
  const mtime = new Date('2022-01-01T00:00:00.000Z');
  fs.utimesSync(original, mtime, mtime);
  return { dir, original, candidate, mtime };
}

function replaceOriginal(fixture, bytes) {
  const moved = path.join(fixture.dir, 'moved-copy.mkv');
  fs.writeFileSync(moved, bytes);
  fs.utimesSync(moved, fixture.mtime, fixture.mtime);
  fs.renameSync(moved, fixture.original);
}

test('final recheck accepts a byte-identical Mover relocation and refreshes the snapshot', async t => {
  const bytes = Buffer.from('complete source bytes '.repeat(10000));
  const fixture = createFixture(t, bytes);
  const snapshot = makeSnapshot(fixture.original, crypto.createHash('sha256').update(bytes).digest('hex'));
  replaceOriginal(fixture, bytes);
  assert.notEqual(String(fs.statSync(fixture.original, { bigint: true }).ino), snapshot.ino);

  const messages = [];
  const result = await loadPlugin(recheckCode)({
    originalLibraryFile: { _id: fixture.original },
    inputFileObj: { _id: fixture.candidate },
    variables: { user: { original_snapshot: snapshot } },
    jobLog: message => messages.push(String(message))
  });

  assert.equal(result.outputNumber, 1);
  assert.equal(result.variables.user.original_snapshot.ino, String(fs.statSync(fixture.original, { bigint: true }).ino));
  assert.ok(messages.some(message => message.includes('byte-for-byte verification passed')));
});

test('final recheck rejects same-size, same-mtime replacement bytes', async t => {
  const bytes = Buffer.alloc(256 * 1024, 0x31);
  const fixture = createFixture(t, bytes);
  const snapshot = makeSnapshot(fixture.original, crypto.createHash('sha256').update(bytes).digest('hex'));
  replaceOriginal(fixture, Buffer.alloc(bytes.length, 0x32));

  const result = await loadPlugin(recheckCode)({
    originalLibraryFile: { _id: fixture.original },
    inputFileObj: { _id: fixture.candidate },
    variables: { user: { original_snapshot: snapshot } },
    jobLog: () => {}
  });

  assert.equal(result.outputNumber, 2);
  assert.match(result.variables.user.failure_reason, /byte comparison failed/);
});
