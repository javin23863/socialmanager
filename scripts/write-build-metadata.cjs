const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const packageJson = require('../package.json');

function gitOutput(args) {
  try {
    return String(execFileSync('git', args, { cwd: path.resolve(__dirname, '..'), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })).trim();
  } catch (error) {
    return '';
  }
}

const applicationCommit = String(process.env.SOCIAL_ENGAGEMENT_STUDIO_COMMIT || process.env.GIT_COMMIT || gitOutput(['rev-parse', 'HEAD']) || 'unknown').trim();
const buildDirty = Boolean(gitOutput(['status', '--porcelain', '--untracked-files=no']));
if (process.argv.includes('--require-clean') && (applicationCommit === 'unknown' || buildDirty)) {
  process.stderr.write('A distributable installer must be built from a clean, committed checkout with a resolvable commit.\n');
  process.exit(1);
}

const outputPath = path.join(__dirname, '..', 'src', 'core', 'build-metadata.generated.cjs');
const contents = `module.exports = ${JSON.stringify({ applicationVersion: packageJson.version, applicationCommit, buildDirty, source: 'packaged-build' }, null, 2)};\n`;
fs.writeFileSync(outputPath, contents, 'utf8');
process.stdout.write(`Build metadata prepared for ${packageJson.version} at ${applicationCommit}.\n`);
