const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const packageJson = require('../../package.json');

function gitOutput(args) {
  try {
    return String(execFileSync('git', args, {
      cwd: path.resolve(__dirname, '../..'),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })).trim();
  } catch (error) {
    return '';
  }
}

function packagedMetadata() {
  if (process.defaultApp !== false) return null;
  try {
    return require('./build-metadata.generated.cjs');
  } catch (error) {
    return null;
  }
}

const generated = packagedMetadata() || {};
const applicationCommit = String(
  generated.applicationCommit
    || process.env.SOCIAL_ENGAGEMENT_STUDIO_COMMIT
    || process.env.GIT_COMMIT
    || gitOutput(['rev-parse', 'HEAD'])
    || 'unknown',
).trim();
const dirtyOutput = gitOutput(['status', '--porcelain', '--untracked-files=no']);
const buildDirty = generated.buildDirty === undefined
  ? Boolean(dirtyOutput)
  : Boolean(generated.buildDirty);

const BUILD_METADATA = Object.freeze({
  applicationVersion: String(generated.applicationVersion || packageJson.version),
  applicationCommit,
  buildDirty,
  source: generated.source || (process.defaultApp === false ? 'packaged' : 'working-tree'),
});

module.exports = { BUILD_METADATA };
