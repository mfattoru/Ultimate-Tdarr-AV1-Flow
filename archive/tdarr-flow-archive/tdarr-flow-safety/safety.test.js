const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const safety = require('./safety');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tdarr-safety-test-'));
process.on('exit', () => fs.rmSync(dir, { recursive: true, force: true }));
const input = path.join(dir, 'source.mkv');
const short = path.join(dir, 'short.mkv');
const noAudio = path.join(dir, 'no-audio.mkv');
execFileSync('ffmpeg', ['-v','error','-f','lavfi','-i','testsrc2=size=128x96:rate=10','-f','lavfi','-i','sine=frequency=440','-t','4','-c:v','libx264','-c:a','aac','-y',input]);
execFileSync('ffmpeg', ['-v','error','-i',input,'-t','1','-c','copy','-y',short]);
execFileSync('ffmpeg', ['-v','error','-i',input,'-map','0:v:0','-c','copy','-y',noAudio]);

test('filesystem free space is finite and nonexistent paths fail closed', () => {
  assert.ok(Number.isFinite(safety.safeFreeSpaceMB(dir)));
  assert.equal(safety.safeFreeSpaceMB(path.join(dir, 'missing')), null);
});

test('unique job directories do not collide', () => {
  const a=safety.makeJobDir(dir), b=safety.makeJobDir(dir);
  assert.notEqual(a,b);
});

test('validation accepts complete output and rejects short or missing tracks', () => {
  const expected = {audio: 1, subtitle: 0};
  assert.doesNotThrow(() => safety.validateOutput('ffprobe', input, input, expected));
  assert.throws(() => safety.validateOutput('ffprobe', input, short, expected), /duration/i);
  assert.throws(() => safety.validateOutput('ffprobe', input, noAudio, expected), /audio/i);
  assert.throws(() => safety.validateOutput('ffprobe', input, input, { ...expected, audioCodecs: ['eac3'] }), /audio codec/i);
  assert.throws(() => safety.validateOutput('ffprobe', input, path.join(dir,'missing'), expected));
});

