'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {spawnSync} = require('node:child_process');

const root = __dirname;
const tests = fs.readdirSync(root).filter(name => name.endsWith('.test.js')).sort().map(name => path.join(root, name));
const argumentsForNode = [
  '--test',
  '--experimental-test-coverage',
  '--test-coverage-include=audio_timing.js',
  '--test-coverage-include=pgs.js',
  '--test-coverage-include=precheck_cache.js',
  '--test-coverage-include=progress.js',
  '--test-coverage-include=quarantine.js',
  '--test-coverage-include=reservations.js',
  '--test-coverage-include=source_identity.js',
  '--test-coverage-include=subtitle_timing.js',
  '--test-coverage-include=validation.js',
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
