// Self-contained helpers embedded into the Tdarr custom function at build time.
const safeFs = require('fs');
const safePath = require('path');
const safeChild = require('child_process');

function safeFreeSpaceMB(dir) {
  try {
    const s = safeFs.statfsSync(dir, { bigint: true });
    const bytes = s.bavail * s.bsize;
    if (bytes < 0n) return null;
    return Number(bytes / (1024n * 1024n));
  } catch (_) {
    try {
      const out = safeChild.execFileSync('df', ['-Pk', dir], { encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'] });
      const lines = out.trim().split(/\r?\n/);
      const parts = lines[lines.length - 1].trim().split(/\s+/);
      if (parts.length < 6 || !/^\d+$/.test(parts[3])) return null;
      return Math.floor(Number(parts[3]) / 1024);
    } catch (_) { return null; }
  }
}

function makeJobDir(parent) {
  return safeFs.mkdtempSync(safePath.join(parent, 'tdarr-av1-'));
}

function validateOutput(ffprobe, source, output, expected) {
  const probe = (file) => JSON.parse(safeChild.execFileSync(ffprobe,
    ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', file],
    { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 120000 }));
  const src = probe(source), dst = probe(output);
  const video = (dst.streams || []).filter(s => s.codec_type === 'video' && !s.disposition?.attached_pic && !s.disposition?.timed_thumbnails);
  if (video.length !== 1) throw new Error(`Output has ${video.length} video streams, expected 1`);
  if (expected.codec && video[0].codec_name !== expected.codec) throw new Error(`Output video codec ${video[0].codec_name} does not match ${expected.codec}`);
  for (const type of ['audio', 'subtitle']) {
    const actual = (dst.streams || []).filter(s => s.codec_type === type).length;
    if (actual !== expected[type]) throw new Error(`Output ${type} count ${actual} does not match expected ${expected[type]}`);
    const expectedCodecs = expected[type + 'Codecs'];
    if (expectedCodecs) {
      const actualCodecs = (dst.streams || []).filter(s => s.codec_type === type).map(s => s.codec_name);
      expectedCodecs.forEach((codec, i) => {
        if (codec && actualCodecs[i] !== codec) throw new Error(`Output ${type} codec ${actualCodecs[i]} at index ${i} does not match ${codec}`);
      });
    }
  }
  const a = Number(src.format?.duration), b = Number(dst.format?.duration);
  if (!(a > 0) || !(b > 0) || !Number.isFinite(a) || !Number.isFinite(b)) throw new Error('Source or output duration unavailable');
  const tolerance = Math.max(1, a * 0.005);
  if (Math.abs(a - b) > tolerance) throw new Error(`Output duration ${b}s differs from source ${a}s (tolerance ${tolerance.toFixed(2)}s)`);
  return { sourceDuration: a, outputDuration: b };
}

module.exports = { safeFreeSpaceMB, makeJobDir, validateOutput };
