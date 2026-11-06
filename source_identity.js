const sourceIdentityFs = require('node:fs');
const sourceIdentityCrypto = require('node:crypto');
const SOURCE_COMPARE_CHUNK_BYTES = 1024 * 1024;

function sourceIdentityReadChunk(fd, buffer, length, position) {
  let total = 0;
  while (total < length) {
    const count = sourceIdentityFs.readSync(fd, buffer, total, length - total, position + total);
    if (count === 0) break;
    total += count;
  }
  return total;
}

function compareOpenFileToPath(sourceFd, currentPath) {
  let currentFd;
  try {
    currentFd = sourceIdentityFs.openSync(currentPath, 'r');
    const sourceStat = sourceIdentityFs.fstatSync(sourceFd, { bigint: true });
    const currentStat = sourceIdentityFs.fstatSync(currentFd, { bigint: true });
    if (!sourceStat.isFile() || !currentStat.isFile() || sourceStat.size !== currentStat.size) {
      return { identical: false };
    }
    if (sourceStat.size > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error('File exceeds the safe positional-read limit');
    }

    const size = Number(sourceStat.size);
    const sourceBuffer = Buffer.allocUnsafe(SOURCE_COMPARE_CHUNK_BYTES);
    const currentBuffer = Buffer.allocUnsafe(SOURCE_COMPARE_CHUNK_BYTES);
    const sourceHash = sourceIdentityCrypto.createHash('sha256');
    const currentHash = sourceIdentityCrypto.createHash('sha256');
    for (let position = 0; position < size; position += SOURCE_COMPARE_CHUNK_BYTES) {
      const length = Math.min(SOURCE_COMPARE_CHUNK_BYTES, size - position);
      const sourceRead = sourceIdentityReadChunk(sourceFd, sourceBuffer, length, position);
      const currentRead = sourceIdentityReadChunk(currentFd, currentBuffer, length, position);
      if (sourceRead !== length || currentRead !== length) return { identical: false };
      const sourceChunk = sourceBuffer.subarray(0, length);
      const currentChunk = currentBuffer.subarray(0, length);
      if (!sourceChunk.equals(currentChunk)) return { identical: false };
      sourceHash.update(sourceChunk);
      currentHash.update(currentChunk);
    }
    const hash = sourceHash.digest('hex');
    if (hash !== currentHash.digest('hex')) return { identical: false };
    return { identical: true, hash };
  } finally {
    if (currentFd !== undefined) sourceIdentityFs.closeSync(currentFd);
  }
}

function hashFilePath(filePath) {
  const fd = sourceIdentityFs.openSync(filePath, 'r');
  try {
    const stat = sourceIdentityFs.fstatSync(fd, { bigint: true });
    if (!stat.isFile()) throw new Error('Path is not a regular file');
    if (stat.size > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('File exceeds the safe positional-read limit');
    const size = Number(stat.size);
    const buffer = Buffer.allocUnsafe(SOURCE_COMPARE_CHUNK_BYTES);
    const hash = sourceIdentityCrypto.createHash('sha256');
    for (let position = 0; position < size; position += SOURCE_COMPARE_CHUNK_BYTES) {
      const length = Math.min(SOURCE_COMPARE_CHUNK_BYTES, size - position);
      const read = sourceIdentityReadChunk(fd, buffer, length, position);
      if (read !== length) throw new Error('File changed or ended during content verification');
      hash.update(buffer.subarray(0, length));
    }
    return hash.digest('hex');
  } finally {
    sourceIdentityFs.closeSync(fd);
  }
}

module.exports = { compareOpenFileToPath, hashFilePath };
