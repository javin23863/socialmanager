const { PLATFORM_SPECS, platformSpecStatus } = require('../src/core/platform-specs.cjs');

const status = platformSpecStatus({ now: Date.now(), maxAgeDays: 30 });
const numericRules = [];
for (const spec of Object.values(PLATFORM_SPECS)) {
  for (const [surface, rule] of Object.entries(spec.surfaces || {})) {
    if (!Object.values(rule).some((value) => typeof value === 'number' && Number.isFinite(value))) continue;
    numericRules.push({ platform: spec.id, surface, verificationDate: rule.verificationDate || null, sourceClass: rule.sourceClass || null, sourceUrl: rule.sourceUrl || null });
  }
}
const missing = numericRules.filter((rule) => !rule.verificationDate || !rule.sourceClass || !rule.sourceUrl);
process.stdout.write(`${JSON.stringify({ ...status, numericRules, missing }, null, 2)}\n`);
if (missing.length) process.exitCode = 1;
