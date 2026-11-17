const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { compareOpenFileToPath, hashFilePath, hashFileAsync, diffOriginalSnapshot } = require('../src/source_identity');

function withFiles(t, sourceBytes, currentBytes = sourceBytes) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tdarr-source-identity-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const source = path.join(dir, 'source.mkv');
  const current = path.join(dir, 'current.mkv');
  fs.writeFileSync(source, sourceBytes);
  fs.writeFileSync(current, currentBytes);
  return { source, current };
}

test('byte comparison accepts a relocated byte-identical file and returns its SHA-256', t => {
  const bytes = Buffer.from('same media payload '.repeat(200000));
  const { source, current } = withFiles(t, bytes);
  const fd = fs.openSync(source, 'r');
  t.after(() => fs.closeSync(fd));

  assert.deepEqual(compareOpenFileToPath(fd, current), {
    identical: true,
    hash: crypto.createHash('sha256').update(bytes).digest('hex')
  });
  assert.equal(hashFilePath(current), crypto.createHash('sha256').update(bytes).digest('hex'));
});

test('byte comparison rejects same-size content changes', t => {
  const sourceBytes = Buffer.alloc(2 * 1024 * 1024, 0x41);
  const changedBytes = Buffer.from(sourceBytes);
  changedBytes[changedBytes.length - 11] = 0x42;
  const { source, current } = withFiles(t, sourceBytes, changedBytes);
  const fd = fs.openSync(source, 'r');
  t.after(() => fs.closeSync(fd));

  assert.deepEqual(compareOpenFileToPath(fd, current), { identical: false });
});

test('byte comparison can read the original handle after the path is replaced by a moved copy', t => {
  const bytes = Buffer.from('original file handle remains readable '.repeat(50000));
  const { source } = withFiles(t, bytes);
  const fd = fs.openSync(source, 'r');
  t.after(() => fs.closeSync(fd));
  const movedCopy = `${source}.moved-copy`;
  fs.writeFileSync(movedCopy, bytes);
  fs.renameSync(movedCopy, source);

  assert.deepEqual(compareOpenFileToPath(fd, source), {
    identical: true,
    hash: crypto.createHash('sha256').update(bytes).digest('hex')
  });
});

test('byte comparison rejects a changed file size without reading it as a match', t => {
  const { source, current } = withFiles(t, Buffer.from('original'), Buffer.from('replacement'));
  const fd = fs.openSync(source, 'r');
  t.after(() => fs.closeSync(fd));

  assert.deepEqual(compareOpenFileToPath(fd, current), { identical: false });
});

test('diffOriginalSnapshot classifies unchanged, ctime-only, mover relocation, and drift cases', () => {
  const base = { realPath: '/media/movie.mkv', dev: 49n, ino: 100n, size: 500n, mtimeNs: 1000n, ctimeNs: 2000n };
  assert.deepEqual(diffOriginalSnapshot(base, base, base.realPath), {
    changed: [],
    sameStableMetadata: true,
    identityMoved: false,
    ctimeOnly: false
  });
  assert.deepEqual(diffOriginalSnapshot(base, { ...base, ctimeNs: 3000n }, base.realPath), {
    changed: ['ctime'],
    sameStableMetadata: true,
    identityMoved: false,
    ctimeOnly: true
  });
  assert.deepEqual(diffOriginalSnapshot(
    { ...base, dev: String(base.dev), ino: String(base.ino), size: String(base.size), mtimeNs: String(base.mtimeNs), ctimeNs: String(base.ctimeNs) },
    { ...base, ino: 200n, ctimeNs: 3000n },
    base.realPath
  ), {
    changed: ['inode', 'ctime'],
    sameStableMetadata: true,
    identityMoved: true,
    ctimeOnly: false
  });
  assert.deepEqual(diffOriginalSnapshot(base, { ...base, mtimeNs: 1001n, ctimeNs: 3000n }, base.realPath), {
    changed: ['mtime', 'ctime'],
    sameStableMetadata: false,
    identityMoved: false,
    ctimeOnly: false
  });
});

test('hashFileAsync matches hashFilePath, yields across chunks, and reports monotonic progress', async t => {
  const bytes = Buffer.alloc(3 * 1024 * 1024 + 513, 0x7b);
  const { current } = withFiles(t, bytes);
  const expected = hashFilePath(current);
  const updates = [];
  let timerFired = false;
  const timer = setTimeout(() => { timerFired = true; }, 0);
  const actual = await hashFileAsync(current, {
    onProgress: info => updates.push(info)
  });
  clearTimeout(timer);
  assert.equal(actual, expected);
  assert.equal(timerFired, true, 'hashFileAsync must yield to the event loop across multi-chunk reads');
  assert.ok(updates.length >= 2, `expected multi-chunk progress updates, got ${updates.length}`);
  for (let i = 1; i < updates.length; i++) {
    assert.ok(updates[i].ratio >= updates[i - 1].ratio);
  }
  assert.equal(updates.at(-1).ratio, 1);
});

