const AUTOMATED_PLATFORMS = Object.freeze(['youtube', 'instagram', 'facebook']);
const DEFAULT_INTERVAL_MINUTES = 60;
const MIN_INTERVAL_MINUTES = 5;
const MAX_INTERVAL_MINUTES = 1440;

function normalizePlatforms(value, fallback = AUTOMATED_PLATFORMS) {
  const source = Array.isArray(value) ? value : fallback;
  return [...new Set(source.map((platform) => String(platform || '').trim().toLowerCase()))]
    .filter((platform) => AUTOMATED_PLATFORMS.includes(platform));
}

function normalizeIntervalMinutes(value, fallback = DEFAULT_INTERVAL_MINUTES) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(MAX_INTERVAL_MINUTES, Math.max(MIN_INTERVAL_MINUTES, Math.round(numeric)));
}

function normalizeAutomationExecution(execution = {}) {
  return {
    ...execution,
    cycleIntervalMinutes: normalizeIntervalMinutes(execution.cycleIntervalMinutes),
    enabledPlatforms: normalizePlatforms(execution.enabledPlatforms),
  };
}

function defaultAutomationRuntime() {
  return {
    status: 'DISABLED',
    currentPlatform: null,
    currentRunStartedAt: null,
    lastRunStartedAt: null,
    lastRunFinishedAt: null,
    nextRunAt: null,
    lastTrigger: null,
    lastError: null,
    lastRun: null,
  };
}

function summarizeResult(platform, result) {
  const items = Array.isArray(result?.results) ? result.results : [];
  return {
    platform,
    status: items.some((item) => item.status === 'UNKNOWN') ? 'UNKNOWN'
      : result?.completedActions > 0 ? 'COMPLETED'
        : items.some((item) => String(item.status || '').startsWith('BLOCKED') || item.status === 'SKIPPED') ? 'BLOCKED'
          : 'NO_OP',
    discovered: Number(result?.discovered || 0),
    ranked: Number(result?.ranked || 0),
    completedActions: Number(result?.completedActions || 0),
    results: items.slice(0, 25).map((item) => ({
      status: String(item.status || 'UNKNOWN').slice(0, 80),
      targetUrl: String(item.targetUrl || '').slice(0, 500),
      targetAccount: String(item.targetAccount || '').slice(0, 240),
      targetId: String(item.targetId || '').slice(0, 240),
      commentId: String(item.commentId || '').slice(0, 240),
      receiptId: String(item.receiptId || '').slice(0, 160),
      reason: String(item.reason || '').slice(0, 300),
    })),
  };
}

function summarizeError(platform, error) {
  return {
    platform,
    status: error?.executionStatus === 'UNKNOWN' ? 'UNKNOWN' : 'BLOCKED',
    discovered: 0,
    ranked: 0,
    completedActions: 0,
    results: [{
      status: error?.executionStatus || 'BLOCKED',
      reason: String(error?.message || error || 'Automation cycle failed').slice(0, 300),
    }],
  };
}

class AutomationRunner {
  constructor({ getExecution, getRuntime, setRuntime, persist, runPlatform, onState, now = () => Date.now(), setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
    if (typeof getExecution !== 'function' || typeof setRuntime !== 'function' || typeof runPlatform !== 'function') {
      throw new TypeError('AutomationRunner requires execution, runtime, and platform callbacks');
    }
    this.getExecution = getExecution;
    this.getRuntime = typeof getRuntime === 'function' ? getRuntime : () => defaultAutomationRuntime();
    this.setRuntime = setRuntime;
    this.persist = typeof persist === 'function' ? persist : () => {};
    this.runPlatform = runPlatform;
    this.onState = typeof onState === 'function' ? onState : () => {};
    this.now = now;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.timer = null;
    this.running = false;
    this.runPromise = null;
  }

  execution() {
    return normalizeAutomationExecution(this.getExecution() || {});
  }

  runtime() {
    return { ...defaultAutomationRuntime(), ...(this.getRuntime() || {}) };
  }

  updateRuntime(patch, { persist = true } = {}) {
    const next = { ...this.runtime(), ...patch };
    this.setRuntime(next);
    if (persist) this.persist();
    this.onState(next);
    return next;
  }

  clearScheduledRun() {
    if (this.timer) this.clearTimer(this.timer);
    this.timer = null;
  }

  stop(reason = 'stopped') {
    this.clearScheduledRun();
    const execution = this.execution();
    const status = execution.autonomyEnabled ? (execution.paused ? 'PAUSED' : 'STOPPED') : 'DISABLED';
    const normalStop = new Set(['stopped', 'autonomy_disabled', 'kill_switch', 'app_closed']);
    return this.updateRuntime({ status, nextRunAt: null, currentPlatform: null, currentRunStartedAt: null, lastError: normalStop.has(reason) ? null : reason });
  }

  start({ runNow = true, reason = 'startup' } = {}) {
    if (this.running) return this.updateRuntime({ status: 'RUNNING', nextRunAt: null, lastError: null });
    this.clearScheduledRun();
    const execution = this.execution();
    if (!execution.autonomyEnabled) return this.stop('autonomy_disabled');
    if (execution.paused) return this.updateRuntime({ status: 'PAUSED', nextRunAt: null, currentPlatform: null, currentRunStartedAt: null, lastError: null });
    if (runNow) return this.trigger(reason);
    return this.schedule(reason);
  }

  schedule(reason = 'completed') {
    this.clearScheduledRun();
    const execution = this.execution();
    if (!execution.autonomyEnabled) return this.stop('autonomy_disabled');
    if (execution.paused) return this.updateRuntime({ status: 'PAUSED', nextRunAt: null, currentPlatform: null, currentRunStartedAt: null });
    const delay = normalizeIntervalMinutes(execution.cycleIntervalMinutes) * 60 * 1000;
    const nextRunAt = new Date(this.now() + delay).toISOString();
    this.timer = this.setTimer(() => {
      this.timer = null;
      void this.trigger('scheduled');
    }, delay);
    if (this.timer && typeof this.timer.unref === 'function') this.timer.unref();
    return this.updateRuntime({ status: 'SCHEDULED', nextRunAt, lastTrigger: reason, lastError: null });
  }

  trigger(reason = 'operator') {
    if (this.running) return this.runPromise || Promise.resolve({ status: 'RUN_IN_PROGRESS' });
    const execution = this.execution();
    if (!execution.autonomyEnabled) return Promise.resolve(this.updateRuntime({ status: 'DISABLED', nextRunAt: null, lastError: 'Enable autonomous run before starting a cycle.' }));
    if (execution.paused) return Promise.resolve(this.updateRuntime({ status: 'PAUSED', nextRunAt: null, lastError: 'The kill switch is engaged.' }));
    this.clearScheduledRun();
    this.running = true;
    this.runPromise = this.execute(reason).finally(() => {
      this.running = false;
      this.runPromise = null;
    });
    return this.runPromise;
  }

  async execute(reason) {
    const startedAt = new Date(this.now()).toISOString();
    const execution = this.execution();
    const platforms = normalizePlatforms(execution.enabledPlatforms);
    const summaries = [];
    this.updateRuntime({
      status: 'RUNNING',
      currentPlatform: null,
      currentRunStartedAt: startedAt,
      lastRunStartedAt: startedAt,
      lastTrigger: reason,
      lastError: null,
      nextRunAt: null,
    });
    for (const platform of platforms) {
      const latestExecution = this.execution();
      if (!latestExecution.autonomyEnabled || latestExecution.paused) break;
      this.updateRuntime({ status: 'RUNNING', currentPlatform: platform, currentRunStartedAt: startedAt }, { persist: false });
      try {
        const result = await this.runPlatform(platform);
        const summary = summarizeResult(platform, result);
        summaries.push(summary);
        if (summary.status === 'UNKNOWN') break;
      } catch (error) {
        const summary = summarizeError(platform, error);
        summaries.push(summary);
        if (summary.status === 'UNKNOWN') break;
      }
    }
    const finishedAt = new Date(this.now()).toISOString();
    const hasUnknown = summaries.some((summary) => summary.status === 'UNKNOWN');
    const latestExecution = this.execution();
    const lastRun = {
      startedAt,
      finishedAt,
      trigger: reason,
      platforms: summaries,
      completedActions: summaries.reduce((total, summary) => total + summary.completedActions, 0),
    };
    this.updateRuntime({
      status: hasUnknown || latestExecution.paused ? 'PAUSED' : latestExecution.autonomyEnabled ? 'SCHEDULED' : 'DISABLED',
      currentPlatform: null,
      currentRunStartedAt: null,
      lastRunFinishedAt: finishedAt,
      nextRunAt: null,
      lastError: hasUnknown ? 'An ambiguous provider mutation paused automation for reconciliation.' : null,
      lastRun,
    });
    if (!hasUnknown && latestExecution.autonomyEnabled && !latestExecution.paused) this.schedule('completed');
    return { status: hasUnknown ? 'PAUSED' : 'COMPLETED', startedAt, finishedAt, platforms: summaries, state: this.runtime() };
  }
}

module.exports = {
  AUTOMATED_PLATFORMS,
  DEFAULT_INTERVAL_MINUTES,
  MIN_INTERVAL_MINUTES,
  MAX_INTERVAL_MINUTES,
  normalizePlatforms,
  normalizeIntervalMinutes,
  normalizeAutomationExecution,
  defaultAutomationRuntime,
  summarizeResult,
  AutomationRunner,
};
