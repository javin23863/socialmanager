(() => {
  const api = window.studio;
  const view = { state: null, capabilities: {}, analysis: null, ledger: [], selectedId: null, contextDirty: false };
  let toastTimer;

  const $ = (id) => document.getElementById(id);
  const text = (value) => String(value ?? '');
  const make = (tag, className, content) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (content !== undefined) node.textContent = content;
    return node;
  };
  const clear = (node) => { while (node.firstChild) node.removeChild(node.firstChild); };
  const errorMessage = (error) => String(error?.message || error || 'Unknown error')
    .replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/i, '')
    .replace(/^Error:\s*/i, '');

  function notify(message, error = false) {
    const toast = $('toast');
    toast.textContent = message;
    toast.classList.toggle('is-error', error);
    toast.classList.add('is-visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('is-visible'), 4200);
  }

  function setRunState(label, kind = 'neutral') {
    const state = $('run-state');
    state.replaceChildren();
    const dot = make('span', `status-dot status-${kind}`);
    state.append(dot, make('span', '', label));
  }

  function setValue(id, value) { $(id).value = value || ''; }

  function populateForms() {
    const { profile, provider, context, execution, youtube } = view.state;
    setValue('profile-name', profile.name);
    setValue('niche-terms', (profile.nicheTerms || []).join(', '));
    setValue('audience-needs', (profile.audienceNeeds || []).join(', '));
    setValue('preferred-language', profile.language || 'en');
    setValue('owned-channel-ids', (profile.ownedChannelIds || []).join(', '));
    setValue('allowed-channel-ids', (profile.allowedChannelIds || []).join(', '));
    setValue('excluded-channel-ids', (profile.excludedChannelIds || []).join(', '));
    setValue('excluded-keywords', (profile.excludedKeywords || []).join(', '));
    setValue('provider-kind', provider.kind);
    setValue('provider-name', provider.name);
    setValue('provider-base-url', provider.baseUrl);
    setValue('provider-model', provider.model);
    setValue('provider-critic-model', provider.criticModel);
    $('provider-key').value = '';
    $('autonomy-enabled').checked = Boolean(execution.autonomyEnabled);
    $('live-writes-enabled').checked = Boolean(execution.liveWritesEnabled);
    setValue('max-per-run', execution.maxCommentsPerRun);
    setValue('max-per-day', execution.maxCommentsPer24Hours);
    setValue('lookback-days', execution.discoveryLookbackDays);
    setValue('target-cooldown', execution.targetCooldownHours);
    setValue('account-cooldown', execution.accountCooldownHours);
    setValue('minimum-score', execution.minimumGateScore);
    if (!$('discovery-query').value) setValue('discovery-query', (profile.nicheTerms || []).slice(0, 4).join('|'));
    setValue('context-platform', context.platform || 'youtube');
    setValue('context-scope', context.targetScope || 'external');
    setValue('context-url', context.url);
    setValue('context-title', context.title);
    setValue('context-description', context.description);
    setValue('context-transcript', context.transcript);
    setValue('context-visual', context.visualNotes);
    setValue('context-comments', (context.comments || []).map((comment) => typeof comment === 'string' ? comment : comment.text).join('\n'));
    $('provider-status').textContent = provider.kind === 'demo'
      ? 'No key needed. Deterministic demo route is active.'
      : provider.apiKeyConfigured
        ? `Generation: ${provider.model || 'unset'} · critic: ${provider.criticModel || 'not configured'} · stored key ready for ${provider.name || provider.model}.`
        : `Generation: ${provider.model || 'unset'} · critic: ${provider.criticModel || 'not configured'} · keyless route configured; local models may not need a key.`;
    $('youtube-status').textContent = youtube.apiKeyConfigured || youtube.accessTokenConfigured
      ? `Data API ${youtube.apiKeyConfigured ? 'ready' : 'missing'} / OAuth ${youtube.accessTokenConfigured ? 'ready' : 'missing'}.`
      : 'No YouTube credentials configured.';
    renderPlatformContract(context.platform || 'youtube', context.targetScope || 'external');
    renderPolicy();
  }

  function renderPolicy() {
    const { execution, provider, youtube } = view.state;
    const armed = execution.autonomyEnabled && !execution.paused;
    const liveDependenciesReady = provider.kind === 'openai-compatible' && Boolean(provider.criticModel) && youtube.accessTokenConfigured;
    $('policy-state').textContent = execution.paused ? 'PAUSED' : execution.autonomyEnabled ? 'ON' : 'OFF';
    $('policy-state').style.color = execution.paused ? 'var(--red)' : execution.autonomyEnabled ? 'var(--green)' : 'var(--muted)';
    $('kill-switch').textContent = execution.paused ? 'RESUME AUTONOMY' : 'PAUSE AUTONOMY';
    $('write-note').textContent = execution.liveWritesEnabled && liveDependenciesReady
      ? 'Live writes are armed; official context, capability, budgets, gates, and exact read-back still apply.'
      : execution.liveWritesEnabled
        ? 'Live writes are requested but unavailable until a real generation model, independent critic, and YouTube OAuth are configured.'
      : 'Simulation receipts only until an official adapter and scope are configured.';
    $('execute-selected').textContent = armed && execution.liveWritesEnabled ? 'AUTO-EXECUTE PASS' : 'RUN PASSING SIMULATION';
    setRunState(execution.paused ? 'AUTONOMY PAUSED' : armed ? 'AUTONOMY ARMED' : 'OBSERVE MODE', execution.paused ? 'warn' : armed ? 'ok' : 'neutral');
    if (view.analysis) renderSelected(candidateById(view.selectedId));
  }

  function contextFromForm() {
    const previous = view.state.context || {};
    const nextUrl = $('context-url').value.trim();
    const sameUrl = nextUrl === previous.url;
    return {
      ...previous,
      platform: $('context-platform').value,
      targetScope: $('context-scope').value,
      url: nextUrl,
      videoId: sameUrl ? previous.videoId : '',
      channelId: sameUrl ? previous.channelId : '',
      title: $('context-title').value.trim(),
      description: $('context-description').value.trim(),
      transcript: $('context-transcript').value.trim(),
      visualNotes: $('context-visual').value.trim(),
      comments: $('context-comments').value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => ({ text: line })),
      contextSources: sameUrl ? previous.contextSources : ['manual_context_form'],
    };
  }

  function renderContext() {
    const pack = view.analysis?.pack;
    const context = view.state.context;
    const sources = pack?.source?.contextSources || context.contextSources || [];
    renderPlatformContract(context.platform || 'youtube', context.targetScope || 'external');
    $('source-status').textContent = sources.includes('demo_fixture') ? 'DEMO FIXTURE' : sources.includes('youtube_data_api:videos') ? 'OFFICIAL SOURCE' : 'MANUAL SOURCE';
    const ranking = pack?.source?.discoveryRanking;
    const rankingText = ranking ? ` Target rank ${ranking.score}/100; ${ranking.eligible ? 'eligible' : `filtered: ${ranking.exclusionReason}`}.` : '';
    $('source-footnote').textContent = sources.includes('demo_fixture')
      ? 'Synthetic fixture. Replace with an authorized source bundle before live execution.'
      : `Sources: ${sources.join(' / ') || 'manual input'}.${rankingText} Manual changes require a new analysis and cannot impersonate official hydration.`;
    const anchors = pack?.anchors || [];
    $('anchor-count').textContent = String(anchors.length);
    const list = $('anchor-list');
    clear(list);
    if (!anchors.length) list.append(make('span', 'chip-empty', 'No source anchors yet.'));
    anchors.slice(0, 8).forEach((anchor) => list.append(make('span', 'chip', anchor.slice(0, 90))));
  }

  function renderPlatformContract(platform, targetScope) {
    const capability = view.capabilities[platform];
    const contract = $('platform-contract');
    if (!contract || !capability) return;
    clear(contract);
    const action = capability.actions?.comment;
    const surface = capability.surfaces?.comment;
    const allowed = targetScope === 'owned' ? action?.owned : action?.external;
    const scopeText = allowed ? 'official comment route documented' : 'comment route blocked for this target scope';
    const limitText = Number.isFinite(surface?.platformMaxChars)
      ? `${surface.platformMaxChars.toLocaleString()} platform characters`
      : `platform maximum not documented; ${surface?.qualityMaxChars || 'no'}-character studio quality ceiling`;
    contract.append(
      make('span', 'contract-platform', `${capability.label} / ${targetScope}`),
      make('span', `contract-status ${allowed ? 'contract-status-ready' : 'contract-status-block'}`, scopeText),
      make('span', 'contract-copy', `${limitText}. ${capability.officialRoute}.`),
      make('span', 'contract-copy', capability.commentStyle || 'No platform-specific comment shape is registered.'),
    );
    const hydrate = $('hydrate-youtube');
    if (hydrate) {
      const youtube = platform === 'youtube';
      hydrate.disabled = !youtube;
      hydrate.textContent = youtube ? 'HYDRATE YOUTUBE' : 'OFFICIAL HYDRATION N/A';
      hydrate.title = youtube ? 'Fetch metadata and public comments through YouTube Data API' : 'This vertical slice accepts an authorized/manual context bundle for this platform.';
    }
  }

  function candidateById(id) { return view.analysis?.candidates?.find((candidate) => candidate.id === id) || null; }

  function renderCandidates() {
    const list = $('candidate-list');
    clear(list);
    const candidates = view.analysis?.candidates || [];
    $('metric-candidates').textContent = String(candidates.length);
    $('metric-passing').textContent = String(candidates.filter((candidate) => candidate.gate.verdict === 'PASS').length);
    $('provider-badge').textContent = view.analysis?.provider?.label || 'WAITING';
    if (!candidates.length) {
      list.append(make('p', 'ledger-empty', 'Run the analyzer to generate context-bound candidates.'));
      renderSelected(null);
      return;
    }
    if (!view.selectedId || !candidateById(view.selectedId)) view.selectedId = view.analysis.selectedId || candidates[0].id;
    candidates.forEach((candidate, index) => {
      const row = make('button', `candidate-row ${candidate.id === view.selectedId ? 'is-selected' : ''}`);
      row.type = 'button';
      row.addEventListener('click', () => { view.selectedId = candidate.id; renderCandidates(); });
      row.append(make('span', 'candidate-index', String(index + 1).padStart(2, '0')));
      const body = make('div');
      body.append(make('span', 'candidate-mode', candidate.mode));
      body.append(make('p', 'candidate-text', candidate.text));
      row.append(body);
      row.append(make('span', `candidate-status candidate-status-${candidate.gate.verdict === 'PASS' ? 'pass' : 'block'}`, candidate.gate.verdict));
      list.append(row);
    });
    renderSelected(candidateById(view.selectedId));
  }

  function renderSelected(candidate) {
    const pass = candidate?.gate?.verdict === 'PASS' && !view.contextDirty;
    const liveArmed = view.state.execution.liveWritesEnabled && view.state.execution.autonomyEnabled && !view.state.execution.paused;
    const providerReady = view.state.provider.kind === 'openai-compatible' && Boolean(view.state.provider.criticModel);
    const oauthReady = Boolean(view.state.youtube.accessTokenConfigured);
    const officialContext = candidate && view.analysis?.pack?.source?.contextSources?.includes('youtube_data_api:videos');
    const liveRouteReady = candidate?.gate?.metrics?.capability?.allowed && candidate?.gate?.metrics?.platform === 'youtube' && providerReady && oauthReady && officialContext;
    $('selected-mode').textContent = candidate?.mode || 'WAITING FOR ANALYSIS';
    $('selected-copy').textContent = candidate?.text || 'Run the analyzer to build a context-bound comment route.';
    $('selected-score').textContent = candidate ? String(candidate.gate.score) : '--';
    const evidence = $('selected-evidence');
    clear(evidence);
    (candidate?.evidence || []).forEach((item) => evidence.append(make('span', 'chip', item)));
    $('gate-verdict').textContent = candidate?.gate?.verdict || 'WAITING';
    $('gate-verdict').className = `gate-badge ${candidate ? candidate.gate.verdict === 'PASS' ? 'gate-pass' : 'gate-block' : 'gate-neutral'}`;
    $('simulate-selected').disabled = !pass;
    $('execute-selected').disabled = !pass || (liveArmed && !liveRouteReady);
    $('execute-selected').textContent = liveArmed && pass && !liveRouteReady
      ? 'NO LIVE ADAPTER'
      : liveArmed ? 'AUTO-EXECUTE PASS' : 'RUN PASSING SIMULATION';
    $('execution-note').textContent = view.contextDirty
      ? 'Context changed after analysis. Re-run the gates before simulation or execution.'
      : pass
        ? liveArmed && liveRouteReady
        ? 'Autonomous live route armed. RUN CYCLE dispatches a passing YouTube candidate without another approval step.'
        : liveArmed
          ? 'Live writes are armed, but the official context, real model, OAuth, or platform route is not ready. The candidate remains blocked from live execution.'
        : 'Passing copy can be simulated now. Live execution requires an armed policy and an official adapter.'
      : candidate ? 'Blocked candidates cannot reach the action seam.' : 'Simulation is local. Live execution requires an armed policy and an official adapter.';
    renderGates(candidate);
  }

  function renderGates(candidate) {
    const list = $('gate-list');
    clear(list);
    if (!candidate) {
      list.append(make('p', 'ledger-empty', 'No candidate selected.'));
      return;
    }
    const gate = candidate.gate;
    const rows = [
      { name: 'Context sufficiency', blocked: gate.blocked.includes('context_insufficient'), reason: gate.blocked.includes('context_insufficient') ? 'Source bundle is too thin' : 'Enough source detail to reason' },
      { name: 'Candidate schema', blocked: gate.blocked.includes('candidate_schema_invalid') || gate.blocked.includes('candidate_risk_high'), reason: gate.blocked.filter((reason) => reason.startsWith('candidate_')).join(', ') || 'Structured value-add and risk fields are valid' },
      { name: 'Evidence anchors', blocked: gate.blocked.some((reason) => reason.includes('evidence')), reason: gate.blocked.filter((reason) => reason.includes('evidence')).join(', ') || `${gate.metrics.evidenceHits.length} source anchors verified` },
      { name: 'Niche fit', blocked: gate.blocked.includes('niche_mismatch'), reason: gate.blocked.includes('niche_mismatch') ? 'No configured niche overlap' : `${gate.metrics.topicHits.length} configured niche hits` },
      { name: 'Value move', blocked: gate.blocked.includes('no_observable_value_move'), reason: gate.blocked.includes('no_observable_value_move') ? 'No test, condition, or contrast' : 'Adds an observable test or question' },
      { name: 'Anti-slop', blocked: gate.blocked.some((reason) => ['generic_opening_or_praise', 'prompt_injection', 'promotion_or_link', 'punctuation_hype', 'repetitive_against_ledger'].includes(reason)), reason: gate.blocked.filter((reason) => ['generic_opening_or_praise', 'prompt_injection', 'promotion_or_link', 'punctuation_hype', 'repetitive_against_ledger'].includes(reason)).join(', ') || 'No generic, injected, or promotional pattern' },
      { name: 'Risk language', blocked: gate.blocked.some((reason) => ['absolute_or_hype_claim', 'direct_financial_action'].includes(reason)), reason: gate.blocked.filter((reason) => ['absolute_or_hype_claim', 'direct_financial_action'].includes(reason)).join(', ') || 'No direct advice or certainty claim' },
      { name: 'Deterministic critic', blocked: gate.blocked.includes('critic_regression_failure'), reason: gate.metrics.critic?.findings?.join(', ') || 'Literal anti-slop regression checks passed' },
      { name: 'Independent model critic', blocked: gate.metrics.modelCritic?.status === 'BLOCK', state: gate.metrics.modelCritic?.status || 'NOT_PERFORMED', reason: gate.metrics.modelCritic?.findings?.join(', ') || (gate.metrics.modelCritic?.status === 'PASS' ? `Separate ${gate.metrics.modelCritic.model || 'critic'} verdict passed` : 'Not performed; simulation-only until a critic model returns PASS') },
      { name: 'Platform text contract', blocked: gate.blocked.includes('platform_length_limit'), reason: gate.blocked.includes('platform_length_limit') ? `Exceeds the ${gate.metrics.platformLimit || gate.metrics.qualityCeiling || 'platform'} ceiling` : `${gate.metrics.qualityCeiling || 'No'}-character studio ceiling / ${gate.metrics.platformLimit || 'provider-enforced'} platform limit` },
      { name: 'Action scope', blocked: gate.blocked.includes('platform_scope_not_supported') || gate.blocked.includes('unknown_platform_action') || gate.blocked.includes('unknown_platform'), reason: gate.metrics.capability?.reason || 'Official action route is available for this scope' },
    ];
    rows.forEach(({ name, reason, blocked, state }) => {
      const row = make('div', 'gate-row');
      const result = state || (blocked ? 'BLOCK' : 'PASS');
      row.append(make('span', `gate-marker ${result === 'PASS' ? 'gate-marker-pass' : result === 'NOT_PERFORMED' ? 'gate-marker-warn' : 'gate-marker-block'}`));
      const body = make('span');
      body.append(make('span', 'gate-name', name));
      body.append(make('span', 'gate-reason', reason));
      row.append(body);
      row.append(make('span', 'gate-result', result));
      list.append(row);
    });
    if (gate.warnings.length) {
      const warning = make('p', 'field-note', `Warnings: ${gate.warnings.join(', ')}`);
      list.append(warning);
    }
  }

  function renderCapabilities() {
    const list = $('capability-list');
    clear(list);
    Object.values(view.capabilities).forEach((capability) => {
      const row = make('div', 'capability-row');
      const top = make('div', 'capability-top');
      top.append(make('span', 'capability-name', capability.label));
      const ready = capability.status === 'ready_with_oauth';
      top.append(make('span', `capability-state ${ready ? 'capability-state-ready' : 'capability-state-block'}`, capability.status.replaceAll('_', ' ')));
      row.append(top);
      row.append(make('p', 'capability-copy', `Spec snapshot ${capability.specSnapshot || 'unknown'}. ${capability.discovery}. ${capability.context}.`));
      const comment = capability.actions?.comment;
      const surface = capability.surfaces?.comment;
      const limit = Number.isFinite(surface?.platformMaxChars)
        ? `${surface.platformMaxChars.toLocaleString()} documented chars`
        : `${surface?.qualityMaxChars || '—'} studio chars / platform max undocumented`;
      row.append(make('p', 'capability-copy', `Comments: external ${comment?.external ? 'allowed' : 'blocked'} · owned ${comment?.owned ? 'allowed' : 'blocked'} · ${limit}.`));
      const surfaceSummary = Object.entries(capability.surfaces || {}).map(([name, rule]) => {
        if (Number.isFinite(rule.platformMaxChars)) return `${name} ≤${rule.platformMaxChars.toLocaleString()}`;
        if (Number.isFinite(rule.qualityMaxChars)) return `${name} studio ≤${rule.qualityMaxChars.toLocaleString()}`;
        if (rule.shortForm) return `${name}: ${rule.shortForm}`;
        if (rule.maxDurationMinutes) return `${name}: ≤${rule.maxDurationMinutes}m / ${rule.maxFileSizeGB || '?'}GB`;
        return `${name}: source-sensitive`;
      }).join(' · ');
      row.append(make('p', 'capability-copy', `Surfaces: ${surfaceSummary}.`));
      list.append(row);
    });
  }

  function renderLedger() {
    const list = $('ledger-list');
    clear(list);
    $('metric-receipts').textContent = String(view.ledger.length);
    $('ledger-count').textContent = String(view.ledger.length);
    if (!view.ledger.length) {
      list.append(make('p', 'ledger-empty', 'No receipts yet. Simulation writes the same durable shape without a public mutation.'));
      return;
    }
    view.ledger.slice(0, 5).forEach((receipt) => {
      const row = make('div', 'ledger-row');
      const top = make('div', 'ledger-row-top');
      top.append(make('span', 'ledger-status', receipt.status));
      top.append(make('span', 'ledger-date', new Date(receipt.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })));
      row.append(top);
      row.append(make('p', 'ledger-copy', `${receipt.platform} / ${text(receipt.commentText).slice(0, 110)}`));
      list.append(row);
    });
  }

  async function analyze({ autoExecute = false } = {}) {
    try {
      setRunState('ANALYZING CONTEXT', 'warn');
      const context = contextFromForm();
      view.state.context = context;
      view.analysis = await api.runAnalysis(context);
      view.state.context = {
        ...context,
        videoId: view.analysis.pack.source.videoId,
        channelId: view.analysis.pack.source.channelId,
        contextSources: view.analysis.pack.source.contextSources,
      };
      view.contextDirty = false;
      view.selectedId = view.analysis.selectedId;
      renderContext();
      renderCandidates();
      setRunState(view.analysis.selectedId ? 'PASS FOUND' : 'ALL CANDIDATES BLOCKED', view.analysis.selectedId ? 'ok' : 'block');
      if (autoExecute && view.state.execution.autonomyEnabled && !view.state.execution.paused && view.analysis.selectedId) await executeSelected();
      notify(`${view.analysis.candidates.length} candidates generated; ${view.analysis.candidates.filter((item) => item.gate.verdict === 'PASS').length} passed the gates.`);
    } catch (error) {
      setRunState('RUN BLOCKED', 'block');
      notify(errorMessage(error), true);
    }
  }

  async function executeSelected() {
    const candidate = candidateById(view.selectedId);
    if (!candidate || candidate.gate.verdict !== 'PASS') return;
    try {
      const live = view.state.execution.autonomyEnabled && view.state.execution.liveWritesEnabled;
      const platform = view.analysis.pack.source.platform || 'youtube';
      if (live && platform !== 'youtube') throw new Error(`${platform} has no proven live comment adapter in this build; the candidate is simulation-only.`);
      const receipt = live ? await api.executeYouTube({ candidate, pack: view.analysis.pack, targetUrl: view.analysis.pack.source.url }) : await api.simulate({ candidate, pack: view.analysis.pack, targetUrl: view.analysis.pack.source.url, platform });
      view.ledger = await api.listLedger();
      renderLedger();
      notify(live ? `Live action verified: ${receipt.receiptId}` : `Simulation receipt written: ${receipt.receiptId}`);
    } catch (error) {
      notify(errorMessage(error), true);
    }
  }

  async function runNicheCycle() {
    try {
      setRunState('DISCOVERING NICHE TARGETS', 'warn');
      const result = await api.runYouTubeCycle({ query: $('discovery-query').value.trim() });
      view.state = result.state;
      view.analysis = result.lastAnalysis;
      view.selectedId = view.analysis?.selectedId || null;
      view.contextDirty = false;
      populateForms();
      renderContext();
      renderCandidates();
      view.ledger = await api.listLedger();
      renderLedger();
      result.results.forEach((item) => appendConsole(item.status === 'LIVE_VERIFIED' || item.status === 'SIMULATED' ? 'assistant' : 'error', `${item.status}: ${item.targetAccount || item.targetUrl}${item.reason ? ` — ${item.reason}` : ''}`));
      const blocked = result.results.length - result.completedActions;
      setRunState(view.state.execution.paused ? 'CIRCUIT BREAKER PAUSED' : `${result.completedActions} ACTIONS COMPLETE`, view.state.execution.paused ? 'block' : result.completedActions ? 'ok' : 'block');
      notify(`Discovered ${result.discovered} recent targets; ${result.completedActions} passed and ${blocked} were blocked or skipped.`);
    } catch (error) {
      setRunState('NICHE CYCLE BLOCKED', 'block');
      notify(errorMessage(error), true);
    }
  }

  async function hydrateYouTube() {
    try {
      setRunState('HYDRATING YOUTUBE', 'warn');
      const result = await api.fetchYouTubeContext({ url: $('context-url').value.trim() });
      view.state = result.state;
      populateForms();
      await analyze();
      notify('YouTube metadata and public comments hydrated through the official Data API.');
    } catch (error) {
      setRunState('HYDRATION BLOCKED', 'block');
      notify(errorMessage(error), true);
    }
  }

  async function saveProfile() {
    const profile = {
      name: $('profile-name').value.trim(),
      nicheTerms: $('niche-terms').value.split(',').map((item) => item.trim()).filter(Boolean),
      audienceNeeds: $('audience-needs').value.split(',').map((item) => item.trim()).filter(Boolean),
      language: $('preferred-language').value.trim() || 'en',
      ownedChannelIds: $('owned-channel-ids').value.split(',').map((item) => item.trim()).filter(Boolean),
      allowedChannelIds: $('allowed-channel-ids').value.split(',').map((item) => item.trim()).filter(Boolean),
      excludedChannelIds: $('excluded-channel-ids').value.split(',').map((item) => item.trim()).filter(Boolean),
      excludedKeywords: $('excluded-keywords').value.split(',').map((item) => item.trim()).filter(Boolean),
    };
    view.state = await api.saveProfile(profile);
    notify('Audience profile saved.');
  }

  async function saveProvider() {
    view.state = await api.saveProvider({
      kind: $('provider-kind').value,
      name: $('provider-name').value.trim(),
      baseUrl: $('provider-base-url').value.trim(),
      model: $('provider-model').value.trim(),
      criticModel: $('provider-critic-model').value.trim(),
      apiKey: $('provider-key').value,
    });
    populateForms();
    notify('Model adapter saved with OS-protected key storage.');
  }

  async function saveYouTube() {
    view.state = await api.saveYouTubeSecrets({ apiKey: $('youtube-api-key').value, accessToken: $('youtube-access-token').value });
    $('youtube-api-key').value = '';
    $('youtube-access-token').value = '';
    populateForms();
    notify('YouTube connection settings saved.');
  }

  async function saveExecution() {
    view.state = await api.saveExecution({
      autonomyEnabled: $('autonomy-enabled').checked,
      liveWritesEnabled: $('live-writes-enabled').checked,
      maxCommentsPerRun: $('max-per-run').value,
      maxCommentsPer24Hours: $('max-per-day').value,
      discoveryLookbackDays: $('lookback-days').value,
      targetCooldownHours: $('target-cooldown').value,
      accountCooldownHours: $('account-cooldown').value,
      minimumGateScore: $('minimum-score').value,
    });
    populateForms();
    renderPolicy();
    notify(view.state.execution.liveWritesEnabled ? 'Live writes armed; all gates and read-back checks remain mandatory.' : 'Autonomy policy saved in simulation mode.');
  }

  async function togglePause() {
    view.state = await api.saveExecution({ paused: !view.state.execution.paused });
    renderPolicy();
    notify(view.state.execution.paused ? 'Kill switch engaged. No action seam will run.' : 'Autonomy resumed.');
  }

  async function testProvider() {
    try {
      const message = 'Reply with the single word READY if this model route is reachable.';
      appendConsole('user', message);
      const response = await api.chat({ message });
      appendConsole('assistant', `${response.provider}: ${response.text}`);
      notify('Model route responded.');
    } catch (error) {
      appendConsole('error', errorMessage(error));
      notify(errorMessage(error), true);
    }
  }

  async function sendChat(event) {
    event.preventDefault();
    const input = $('console-input');
    const message = input.value.trim();
    if (!message) return;
    input.value = '';
    appendConsole('user', message);
    try {
      const response = await api.chat({ message });
      appendConsole('assistant', `${response.provider}: ${response.text}`);
    } catch (error) {
      appendConsole('error', errorMessage(error));
    }
  }

  function appendConsole(kind, content) {
    const log = $('console-log');
    log.append(make('div', `console-line console-${kind}`, content));
    log.scrollTop = log.scrollHeight;
  }

  function bind() {
    $('context-form').addEventListener('submit', (event) => { event.preventDefault(); analyze(); });
    $('context-platform').addEventListener('change', () => renderPlatformContract($('context-platform').value, $('context-scope').value));
    $('context-scope').addEventListener('change', () => renderPlatformContract($('context-platform').value, $('context-scope').value));
    $('context-form').addEventListener('input', () => {
      if (!view.analysis) return;
      view.contextDirty = true;
      renderSelected(candidateById(view.selectedId));
      setRunState('CONTEXT CHANGED', 'warn');
    });
    $('run-cycle').addEventListener('click', runNicheCycle);
    $('hydrate-youtube').addEventListener('click', hydrateYouTube);
    $('save-profile').addEventListener('click', saveProfile);
    $('save-provider').addEventListener('click', saveProvider);
    $('save-youtube').addEventListener('click', saveYouTube);
    $('autonomy-enabled').addEventListener('change', saveExecution);
    $('live-writes-enabled').addEventListener('change', saveExecution);
    ['max-per-run', 'max-per-day', 'lookback-days', 'target-cooldown', 'account-cooldown', 'minimum-score'].forEach((id) => $(id).addEventListener('change', saveExecution));
    $('kill-switch').addEventListener('click', togglePause);
    $('test-provider').addEventListener('click', testProvider);
    $('simulate-selected').addEventListener('click', executeSelected);
    $('execute-selected').addEventListener('click', executeSelected);
    $('console-form').addEventListener('submit', sendChat);
  }

  async function init() {
    if (!api) {
      notify('The Electron preload bridge is unavailable.', true);
      return;
    }
    try {
      [view.state, view.capabilities, view.ledger] = await Promise.all([api.loadState(), api.listCapabilities(), api.listLedger()]);
      populateForms();
      renderCapabilities();
      renderLedger();
      view.analysis = view.state.lastAnalysis || null;
      renderContext();
      renderCandidates();
      bind();
      await analyze();
    } catch (error) {
      setRunState('BOOT BLOCKED', 'block');
      notify(errorMessage(error), true);
    }
  }

  init();
})();
