'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {spawnSync} = require('node:child_process');

const root = path.resolve(__dirname, '..');
const testsDir = path.join(root, 'tests');
const tests = fs.readdirSync(testsDir).filter(name => name.endsWith('.test.js')).sort().map(name => path.join(testsDir, name));
const argumentsForNode = [
  '--test',
  '--experimental-test-coverage',
  '--test-coverage-include=src/audio_timing.js',
  '--test-coverage-include=src/pgs.js',
  '--test-coverage-include=src/precheck_cache.js',
  '--test-coverage-include=src/progress.js',
  '--test-coverage-include=src/quarantine.js',
  '--test-coverage-include=src/reservations.js',
  '--test-coverage-include=src/source_identity.js',
  '--test-coverage-include=src/subtitle_timing.js',
  '--test-coverage-include=src/validation.js',
  '--test-coverage-lines=90',
  '--test-coverage-functions=90',
  ...tests
];

const result = spawnSync(process.execPath, argumentsForNode, {
  cwd: root,
  env: process.env,
  stdio: 'inherit'
});

if (result.error) {
  process.stderr.write(`${result.error.message}\n`);
  process.exitCode = 1;
} else {
  process.exitCode = result.status === null ? 1 : result.status;
}
