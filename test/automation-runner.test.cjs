const test = require('node:test');
const assert = require('node:assert/strict');
const {
  AutomationRunner,
  normalizeAutomationExecution,
  normalizeIntervalMinutes,
} = require('../src/core/automation-runner.cjs');

function harness({ execution, runPlatform } = {}) {
  const timers = [];
  const persisted = [];
  const events = [];
  const runtime = {};
  const runner = new AutomationRunner({
    getExecution: () => execution,
    getRuntime: () => runtime,
    setRuntime: (next) => Object.assign(runtime, next),
    persist: () => persisted.push({ ...runtime }),
    runPlatform,
    onState: (next) => events.push({ ...next }),
    now: () => 1_000_000,
    setTimer: (callback, delay) => {
      const timer = { callback, delay };
      timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => { timer.cleared = true; },
  });
  return { runner, timers, persisted, events, runtime };
}

test('normalizes bounded automation settings without accepting TikTok', () => {
  assert.equal(normalizeIntervalMinutes(1), 5);
  assert.equal(normalizeIntervalMinutes(5000), 1440);
  assert.deepEqual(normalizeAutomationExecution({ enabledPlatforms: ['youtube', 'tiktok', 'youtube'], cycleIntervalMinutes: 17 }).enabledPlatforms, ['youtube']);
  assert.deepEqual(normalizeAutomationExecution({ enabledPlatforms: [] }).enabledPlatforms, []);
});

test('runs enabled platforms sequentially and schedules the next cycle', async () => {
  const execution = { autonomyEnabled: true, paused: false, enabledPlatforms: ['youtube', 'instagram'], cycleIntervalMinutes: 5 };
  const calls = [];
  const { runner, timers, runtime } = harness({
    execution,
    runPlatform: async (platform) => {
      calls.push(platform);
      return { platform, discovered: 2, ranked: 1, completedActions: 1, results: [{ status: 'SIMULATED' }] };
    },
  });

  const result = await runner.start({ runNow: true, reason: 'test' });

  assert.deepEqual(calls, ['youtube', 'instagram']);
  assert.equal(result.status, 'COMPLETED');
  assert.equal(runtime.status, 'SCHEDULED');
  assert.equal(timers.length, 1);
  assert.equal(timers[0].delay, 300_000);
  assert.equal(runtime.lastRun.completedActions, 2);
  assert.equal(runtime.lastRun.platforms[0].status, 'COMPLETED');
});

test('does not overlap a running cycle', async () => {
  const execution = { autonomyEnabled: true, paused: false, enabledPlatforms: ['youtube'], cycleIntervalMinutes: 5 };
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const { runner } = harness({
    execution,
    runPlatform: async () => {
      await gate;
      return { completedActions: 0, results: [] };
    },
  });

  const first = runner.trigger('test');
  const second = runner.trigger('test-again');
  assert.strictEqual(second, first);
  release();
  await first;
});

test('continues scheduling after a configuration block but pauses on an unknown mutation', async () => {
  const execution = { autonomyEnabled: true, paused: false, enabledPlatforms: ['youtube', 'facebook'], cycleIntervalMinutes: 5 };
  const blocked = harness({
    execution,
    runPlatform: async (platform) => {
      if (platform === 'youtube') throw new Error('API key is not configured');
      return { completedActions: 0, results: [{ status: 'NO_INBOUND_COMMENTS' }] };
    },
  });
  const blockedResult = await blocked.runner.trigger('test');
  assert.equal(blockedResult.status, 'COMPLETED');
  assert.equal(blocked.runtime.status, 'SCHEDULED');
  assert.equal(blocked.runtime.lastRun.platforms[0].status, 'BLOCKED');
  assert.equal(blocked.runtime.lastRun.platforms[1].status, 'NO_OP');

  const unknownExecution = { autonomyEnabled: true, paused: false, enabledPlatforms: ['youtube'], cycleIntervalMinutes: 5 };
  const unknown = harness({
    execution: unknownExecution,
    runPlatform: async () => {
      const error = new Error('provider read-back missing');
      error.executionStatus = 'UNKNOWN';
      throw error;
    },
  });
  const unknownResult = await unknown.runner.trigger('test');
  assert.equal(unknownResult.status, 'PAUSED');
  assert.equal(unknown.runtime.status, 'PAUSED');
  assert.equal(unknown.timers.length, 0);
});

test('stops immediately when autonomy is disabled or paused', async () => {
  const execution = { autonomyEnabled: false, paused: false, enabledPlatforms: ['youtube'], cycleIntervalMinutes: 5 };
  const disabled = harness({ execution, runPlatform: async () => { throw new Error('must not run'); } });
  const disabledState = await disabled.runner.start({ runNow: true });
  assert.equal(disabledState.status, 'DISABLED');
  assert.equal(disabled.runtime.status, 'DISABLED');

  execution.autonomyEnabled = true;
  execution.paused = true;
  const paused = harness({ execution, runPlatform: async () => { throw new Error('must not run'); } });
  const pausedState = await paused.runner.start({ runNow: true });
  assert.equal(pausedState.status, 'PAUSED');
  assert.equal(paused.runtime.status, 'PAUSED');
});
