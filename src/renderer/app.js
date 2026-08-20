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

  function displayTime(value) {
    if (!value) return 'not yet';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? 'not yet' : date.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
  }

  function populateForms() {
    const { profile, provider, context, execution, youtube, meta } = view.state;
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
    setValue('provider-vision-model', provider.visionModel || '');
    setValue('provider-transcription-model', provider.transcriptionModel || '');
    setValue('provider-critic-model', provider.criticModel);
    $('provider-key').value = '';
    setValue('youtube-oauth-client-id', youtube.oauthClientId || '');
    $('youtube-oauth-client-secret').value = '';
    $('autonomy-enabled').checked = Boolean(execution.autonomyEnabled);
    $('live-writes-enabled').checked = Boolean(execution.liveWritesEnabled);
    setValue('automation-interval', execution.cycleIntervalMinutes || 60);
    ['youtube', 'instagram', 'facebook'].forEach((platform) => {
      const control = $(`automation-${platform}`);
      if (control) control.checked = (execution.enabledPlatforms || []).includes(platform);
    });
    setValue('max-per-run', execution.maxCommentsPerRun);
    setValue('max-per-day', execution.maxCommentsPer24Hours);
    setValue('lookback-days', execution.discoveryLookbackDays);
    setValue('target-cooldown', execution.targetCooldownHours);
    setValue('account-cooldown', execution.accountCooldownHours);
    setValue('minimum-score', execution.minimumGateScore);
    if (!$('discovery-query').value) setValue('discovery-query', (profile.nicheTerms || []).slice(0, 4).join('|'));
    setValue('context-platform', context.platform || 'youtube');
    setValue('context-scope', context.targetScope || 'external');
    setValue('context-action', context.action || (context.targetScope === 'owned' ? 'reply' : 'comment'));
    setValue('context-url', context.url);
    setValue('context-target-id', context.targetId || context.videoId);
    setValue('context-reply-id', context.replyToId || context.targetCommentId);
    setValue('context-title', context.title);
    setValue('context-description', context.description);
    setValue('context-transcript', context.transcript);
    setValue('context-visual', context.visualNotes);
    setValue('context-comments', (context.comments || []).map((comment) => typeof comment === 'string' ? comment : comment.text).join('\n'));
    if (context.mediaProvenance?.sourceHash) {
      $('media-status').textContent = `Inspected authorized media · SHA-256 ${context.mediaProvenance.sourceHash.slice(0, 16)}… · audio ${context.transcriptStatus || 'unavailable'} · visual ${context.visualStatus || 'unavailable'}.`;
    }
    $('provider-status').textContent = provider.kind === 'demo'
      ? 'No key needed. Deterministic demo route is active.'
      : provider.apiKeyConfigured
        ? `Generation: ${provider.model || 'unset'} · critic: ${provider.criticModel || 'not configured'} · stored key ready for ${provider.name || provider.model}.`
        : `Generation: ${provider.model || 'unset'} · critic: ${provider.criticModel || 'not configured'} · keyless route configured; local models may not need a key.`;
    const oauthStatus = String(youtube.oauthStatus || 'disconnected').toUpperCase();
    const grantedScope = (youtube.grantedScopes || []).includes('https://www.googleapis.com/auth/youtube.force-ssl');
    $('youtube-status').textContent = oauthStatus === 'CONNECTED'
      ? `OAuth connected · Data API ${youtube.contextAccess === 'oauth' ? 'uses the connected grant' : 'fallback key ready'}${grantedScope ? ' · comment scope granted' : ''}.`
      : youtube.oauthClientSecretRequired && !youtube.oauthClientSecretConfigured
        ? 'OAuth client detected · enter the client secret once, save, then connect the signed-in YouTube account.'
        : youtube.oauthClientSecretRequired && youtube.oauthClientSecretConfigured
          ? 'OAuth client and secret saved · connect the signed-in YouTube account once to authorize the worker.'
      : youtube.apiKeyConfigured
        ? `Data API key ready · OAuth ${oauthStatus}${grantedScope ? ' · comment scope granted' : ' · connect for comments and autonomous writes'}.`
        : `OAuth client ready · connect YouTube to authorize discovery, context, and comments.${youtube.oauthStatusReason ? ` ${youtube.oauthStatusReason}.` : ''}`;
    $('youtube-scope').textContent = `Requested scope: ${(youtube.requestedScopes || ['https://www.googleapis.com/auth/youtube.force-ssl']).join(', ')}. ${youtube.credentialStorage || 'OS-protected credential storage'}.`;
    $('connect-youtube').disabled = !youtube.oauthClientIdConfigured || (youtube.oauthClientSecretRequired && !youtube.oauthClientSecretConfigured) || oauthStatus === 'AUTHORIZING';
    $('disconnect-youtube').disabled = !youtube.oauthReady && oauthStatus === 'DISCONNECTED';
    setValue('meta-app-id', meta?.appId || '');
    setValue('meta-graph-version', meta?.graphApiVersion || 'v26.0');
    $('meta-app-secret').value = '';
    const metaStatus = String(meta?.status || 'disconnected').toUpperCase();
    $('meta-status').textContent = meta?.appIdConfigured && meta?.appSecretConfigured
      ? `Meta OAuth ${metaStatus}${meta?.statusReason ? ` · ${meta.statusReason}` : ''}. ${view.state.accounts?.filter((account) => ['facebook', 'instagram'].includes(account.platform) && account.status === 'connected').length || 0} actor accounts registered.`
      : 'Meta app detected · add the App Secret once to authorize managed Page and Instagram accounts.';
    $('meta-permissions').textContent = meta?.permissions?.length
      ? `Granted/requested permissions: ${meta.permissions.join(', ')}.`
      : 'Community permissions are not configured.';
    $('connect-meta').disabled = !meta?.appIdConfigured || !meta?.appSecretConfigured || metaStatus === 'AUTHORIZING';
    $('disconnect-meta').disabled = !meta?.appIdConfigured && metaStatus === 'DISCONNECTED';
    renderAccounts();
    renderReconciliation();
    renderOutcomes();
    renderEvaluationExamples();
    renderExemplars();
    renderStorageStatus();
    renderPlatformContract(context.platform || 'youtube', context.targetScope || 'external');
    renderAutomation();
    renderPolicy();
  }

  function renderAutomation() {
    const execution = view.state.execution || {};
    const automation = view.state.automation || {};
    const runtime = view.state.platformRuntime || {};
    const status = String(automation.status || (execution.autonomyEnabled ? 'STARTING' : 'DISABLED')).toUpperCase();
    const statusNode = $('automation-status');
    if (statusNode) {
      statusNode.textContent = status;
      statusNode.className = `mini-state automation-state-${status.toLowerCase()}`;
    }
    const copy = $('automation-status-copy');
    if (copy) {
      const last = automation.lastRun;
      copy.textContent = status === 'RUNNING'
        ? `Running ${automation.currentPlatform ? automation.currentPlatform.toUpperCase() : 'enabled surfaces'} sequentially. No overlapping cycle will start.`
        : last
          ? `Last run ${displayTime(last.finishedAt)} · ${last.completedActions || 0} completed action(s) across ${(last.platforms || []).length} surface(s).`
          : execution.autonomyEnabled
            ? 'Worker is enabled and will run the configured surfaces automatically.'
            : 'Enable the worker once; it will run the enabled surfaces sequentially and resume after restart.';
    }
    ['youtube', 'instagram', 'facebook'].forEach((platform) => {
      const node = $(`automation-${platform}-state`);
      const item = runtime[platform];
      if (!node) return;
      node.textContent = item?.ready ? `${item.mode.toUpperCase()} READY` : `BLOCKED · ${item?.reason || 'not configured'}`;
      node.className = `automation-surface-state ${item?.ready ? 'automation-surface-ready' : 'automation-surface-blocked'}`;
      node.title = item?.reasons?.join(' · ') || item?.reason || '';
    });
    const next = $('automation-next-run');
    if (next) {
      next.textContent = automation.nextRunAt
        ? `Next automatic run: ${displayTime(automation.nextRunAt)}.`
        : status === 'PAUSED'
          ? 'Automatic runs are paused by the kill switch.'
          : status === 'DISABLED'
            ? 'No automatic run scheduled.'
            : 'Finishing the current run before scheduling the next one.';
    }
  }

  function renderPolicy() {
    const { execution, provider, youtube, meta, accounts } = view.state;
    const armed = execution.autonomyEnabled && !execution.paused;
    const accountReady = (accounts || []).some((account) => account.status === 'connected' && account.capabilities?.comment);
    const buildReady = view.state.buildMetadata?.applicationCommit && view.state.buildMetadata.applicationCommit !== 'unknown' && !view.state.buildMetadata.buildDirty;
    const liveDependenciesReady = provider.kind === 'openai-compatible' && Boolean(provider.criticModel) && (Boolean(youtube.oauthReady) || meta?.status === 'connected') && accountReady && buildReady;
    const workerStatus = String(view.state.automation?.status || '').toUpperCase();
    $('policy-state').textContent = execution.paused ? 'PAUSED' : workerStatus === 'RUNNING' ? 'RUNNING' : execution.autonomyEnabled ? 'ON' : 'OFF';
    $('policy-state').style.color = execution.paused ? 'var(--red)' : workerStatus === 'RUNNING' ? 'var(--cobalt)' : execution.autonomyEnabled ? 'var(--green)' : 'var(--muted)';
    $('kill-switch').textContent = execution.paused ? 'RESUME AUTONOMY' : 'PAUSE AUTONOMY';
    $('run-cycle').disabled = !execution.autonomyEnabled || execution.paused;
    $('run-selected-cycle').disabled = !execution.autonomyEnabled || execution.paused;
    $('write-note').textContent = execution.liveWritesEnabled && liveDependenciesReady
      ? 'Live writes are armed; official context, capability, budgets, gates, and exact read-back still apply.'
      : execution.liveWritesEnabled
        ? !buildReady
          ? 'Live writes are held until this is a clean, versioned application build; package the committed checkout before public execution.'
          : 'Live writes are requested but unavailable until a real generation model, independent critic, connected actor account, and matching official provider route are configured.'
      : 'Simulation receipts only until an official adapter and scope are configured.';
    $('execute-selected').textContent = armed && execution.liveWritesEnabled ? 'AUTO-EXECUTE PASS' : 'RUN PASSING SIMULATION';
    setRunState(execution.paused ? 'AUTONOMY PAUSED' : workerStatus === 'RUNNING' ? 'AUTOMATION RUNNING' : workerStatus === 'SCHEDULED' ? 'AUTOMATION SCHEDULED' : armed ? 'AUTONOMY ARMED' : 'OBSERVE MODE', execution.paused ? 'warn' : workerStatus === 'RUNNING' ? 'warn' : armed ? 'ok' : 'neutral');
    renderAutomation();
    if (view.analysis) renderSelected(candidateById(view.selectedId));
  }

  function updateCycleLabel() {
    const platform = $('cycle-platform').value;
    $('run-selected-cycle').textContent = platform === 'youtube'
      ? 'RUN YOUTUBE NICHE CYCLE'
      : `RUN ${platform.toUpperCase()} OWNED CARE`;
  }

  function contextFromForm() {
    const previous = view.state.context || {};
    const nextUrl = $('context-url').value.trim();
    const sameUrl = nextUrl === previous.url;
    return {
      ...previous,
      platform: $('context-platform').value,
      targetScope: $('context-scope').value,
      action: $('context-action').value,
      url: nextUrl,
      targetId: $('context-target-id').value.trim(),
      replyToId: $('context-reply-id').value.trim(),
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
    $('source-status').textContent = sources.includes('empty_state') ? 'NO SOURCE' : sources.includes('demo_fixture') ? 'PREVIEW FIXTURE' : sources.some((source) => source.startsWith('youtube_data_api:') || source.startsWith('meta_api:')) ? 'OFFICIAL SOURCE' : 'MANUAL SOURCE';
    const ranking = pack?.source?.discoveryRanking;
    const rankingText = ranking ? ` Target rank ${ranking.score}/100; ${ranking.eligible ? 'eligible' : `filtered: ${ranking.exclusionReason}`}.` : '';
    $('source-footnote').textContent = sources.includes('empty_state')
      ? 'No source has been hydrated yet. Automatic cycles hydrate provider context themselves; this panel stays empty until a real target is selected.'
      : sources.includes('demo_fixture')
        ? 'Preview fixture. Replace with an authorized source bundle before live execution.'
      : `Sources: ${sources.join(' / ') || 'manual input'}.${rankingText} ${context.ownershipStatus ? `Ownership: ${context.ownershipStatus}. ` : ''}Manual changes require a new analysis and cannot impersonate official hydration.`;
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
    const actionSelect = $('context-action');
    if (actionSelect) {
      const topLevel = [...actionSelect.options].find((option) => option.value === 'comment');
      if (topLevel) topLevel.disabled = platform === 'instagram';
      if (platform === 'instagram' && actionSelect.value === 'comment') actionSelect.value = 'reply';
    }
    const actionName = $('context-action')?.value || 'comment';
    const action = capability.actions?.[actionName] || capability.actions?.comment;
    const surface = capability.surfaces?.comment;
    const allowed = targetScope === 'owned' ? action?.owned : action?.external;
    const scopeText = allowed ? 'official comment route documented' : 'comment route blocked for this target scope';
    const limitText = Number.isFinite(surface?.platformMaxChars)
      ? `${surface.platformMaxChars.toLocaleString()} platform characters`
      : `platform maximum not documented; ${surface?.qualityMaxChars || 'no'}-character studio quality ceiling`;
    contract.append(
      make('span', 'contract-platform', `${capability.label} / ${targetScope}`),
      make('span', `contract-status ${allowed ? 'contract-status-ready' : 'contract-status-block'}`, `${actionName}: ${scopeText}`),
      make('span', 'contract-copy', `${limitText}. ${capability.officialRoute}.`),
      make('span', 'contract-copy', capability.commentStyle || 'No platform-specific comment shape is registered.'),
    );
    const hydrate = $('hydrate-youtube');
    const hydrateMeta = $('hydrate-meta');
    if (hydrate) {
      const youtube = platform === 'youtube';
      hydrate.disabled = !youtube;
      hydrate.textContent = youtube ? 'HYDRATE YOUTUBE' : 'OFFICIAL HYDRATION N/A';
      hydrate.title = youtube ? 'Fetch metadata and public comments through YouTube Data API' : 'This vertical slice accepts an authorized/manual context bundle for this platform.';
    }
    if (hydrateMeta) {
      const meta = platform === 'instagram' || platform === 'facebook';
      hydrateMeta.disabled = !meta || targetScope !== 'owned';
      hydrateMeta.textContent = meta && targetScope === 'owned' ? `HYDRATE ${platform.toUpperCase()}` : 'OWNED HYDRATION N/A';
      hydrateMeta.title = meta ? 'Fetch owned media and comments through the official Meta Graph API' : 'Meta hydration is only available for Instagram and Facebook owned media.';
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
    const buildReady = view.state.buildMetadata?.applicationCommit && view.state.buildMetadata.applicationCommit !== 'unknown' && !view.state.buildMetadata.buildDirty;
    const platform = view.analysis?.pack?.source?.platform || 'youtube';
    const action = view.analysis?.pack?.source?.action || 'comment';
    const officialContext = candidate && view.analysis?.pack?.source?.contextSources?.some((source) => source.startsWith('youtube_data_api:') || source.startsWith('meta_api:'));
    const actorAccountId = view.analysis?.pack?.source?.actorAccountId;
    const actorReady = Boolean(actorAccountId) && (view.state.accounts || []).some((account) => account.platform === platform && account.accountId === actorAccountId && account.status === 'connected' && account.capabilities?.[action]);
    const connectionReady = platform === 'youtube' ? Boolean(view.state.youtube.oauthReady) : ['instagram', 'facebook'].includes(platform) && view.state.meta?.status === 'connected';
    const ownershipReady = platform === 'youtube' || view.analysis?.pack?.source?.ownershipStatus === 'PROVIDER_LISTED_FOR_ACTOR';
    const liveRouteReady = candidate?.gate?.metrics?.capability?.allowed && providerReady && connectionReady && actorReady && ownershipReady && officialContext && buildReady;
    $('selected-mode').textContent = candidate?.mode || 'WAITING FOR ANALYSIS';
    $('selected-copy').textContent = candidate?.text || 'Run the analyzer to build a context-bound comment route.';
    $('selected-score').textContent = candidate ? String(candidate.gate.score) : '--';
    const evidence = $('selected-evidence');
    clear(evidence);
    (candidate?.evidence || []).forEach((item) => evidence.append(make('span', 'chip', item)));
    $('gate-verdict').textContent = candidate?.gate?.verdict || 'WAITING';
    $('gate-verdict').className = `gate-badge ${candidate ? candidate.gate.verdict === 'PASS' ? 'gate-pass' : 'gate-block' : 'gate-neutral'}`;
    $('simulate-selected').disabled = !pass;
    $('pin-exemplar').disabled = !pass;
    $('execute-selected').disabled = !pass || (liveArmed && !liveRouteReady);
    $('execute-selected').textContent = liveArmed && pass && !liveRouteReady
      ? 'NO LIVE ADAPTER'
      : liveArmed ? 'AUTO-EXECUTE PASS' : 'RUN PASSING SIMULATION';
    $('execution-note').textContent = view.contextDirty
      ? 'Context changed after analysis. Re-run the gates before simulation or execution.'
      : pass
        ? liveArmed && liveRouteReady
        ? `Autonomous live route armed. The bounded cycle or direct action can dispatch a passing ${platform} ${action} without another approval step.`
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
      { name: 'Action scope', blocked: gate.blocked.includes('platform_scope_not_supported') || gate.blocked.includes('platform_spec_verification_required') || gate.blocked.includes('unknown_platform_action') || gate.blocked.includes('unknown_platform'), reason: gate.metrics.capability?.reason || 'Official action route is available for this scope' },
      { name: 'Ownership proof', blocked: gate.blocked.includes('ownership_proof_required'), reason: gate.blocked.includes('ownership_proof_required') ? 'Owned-media provider identity has not been verified' : 'Target ownership is bound to the connected actor account' },
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
      const freshness = capability.specFreshness;
      const ready = capability.status === 'ready_with_oauth' && freshness?.status === 'CURRENT';
      top.append(make('span', `capability-state ${ready ? 'capability-state-ready' : 'capability-state-block'}`, capability.status.replaceAll('_', ' ')));
      row.append(top);
      row.append(make('p', 'capability-copy', `Spec snapshot ${capability.specSnapshot || 'unknown'} · ${freshness?.status || 'VERIFY_REQUIRED'}. ${capability.discovery}. ${capability.context}.`));
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

  function renderAccounts() {
    const list = $('account-list');
    if (!list) return;
    clear(list);
    const accounts = view.state.accounts || [];
    $('account-count').textContent = String(accounts.length);
    if (!accounts.length) {
      list.append(make('p', 'ledger-empty', 'No actor accounts connected. Live work stays blocked.'));
      return;
    }
    accounts.slice(0, 12).forEach((account) => {
      const row = make('div', 'account-row');
      const top = make('div', 'account-row-top');
      top.append(make('span', 'account-name', `${account.platform.toUpperCase()} · ${account.displayName || account.providerAccountId}`));
      top.append(make('span', `account-status account-status-${account.status}`, account.status.toUpperCase()));
      row.append(top);
      row.append(make('p', 'account-copy', `${account.providerAccountId} · ${Object.keys(account.capabilities || {}).filter((key) => account.capabilities[key]).join(', ') || 'no capabilities'} · budget ${account.policy?.maxActionsPer24Hours || '—'}/24h`));
      if (account.statusReason) row.append(make('p', 'account-copy', `Reason: ${account.statusReason}`));
      list.append(row);
    });
  }

  function renderStorageStatus() {
    const storage = view.state.storage;
    if (!storage) return;
    $('storage-status').textContent = `SQLite schema ${storage.schemaVersion || 'unknown'} · ${storage.accountCount || 0} actor accounts · ${storage.unresolvedCount || 0} unresolved. Legacy files remain as migration backups.`;
  }

  function renderReconciliation() {
    const list = $('reconciliation-list');
    if (!list) return;
    clear(list);
    const items = view.state.reconciliationInbox || [];
    $('reconciliation-count').textContent = String(items.length);
    if (!items.length) {
      list.append(make('p', 'ledger-empty', 'No unresolved mutations.'));
      return;
    }
    items.slice(0, 10).forEach((item) => {
      const row = make('div', 'reconciliation-row');
      const top = make('div', 'reconciliation-row-top');
      top.append(make('span', 'reconciliation-key', item.idempotencyKey.slice(0, 16)));
      top.append(make('span', 'reconciliation-status', item.status));
      row.append(top);
      row.append(make('p', 'reconciliation-copy', `${item.reasonCode}. Provider reconciliation is required before retrying.`));
      const verify = make('button', 'button button-secondary button-compact', 'VERIFY WITH PROVIDER');
      verify.type = 'button';
      verify.addEventListener('click', async () => {
        verify.disabled = true;
        try {
          const result = await api.verifyReconciliation({ idempotencyKey: item.idempotencyKey });
          view.state = result.state;
          view.ledger = await api.listLedger();
          populateForms();
          renderLedger();
          notify(result.receipt.status === 'LIVE_VERIFIED' ? 'Provider reconciliation verified the original mutation.' : 'Provider reconciliation found no exact approved mutation; the action is marked failed and may be reconsidered by policy.');
        } catch (error) {
          verify.disabled = false;
          notify(errorMessage(error), true);
        }
      });
      row.append(verify);
      list.append(row);
    });
  }

  function renderOutcomes() {
    const list = $('outcome-list');
    if (!list) return;
    clear(list);
    const snapshots = view.state.metricSnapshots || [];
    $('outcome-count').textContent = String(snapshots.length);
    if (!snapshots.length) {
      list.append(make('p', 'ledger-empty', 'No provider-sourced metric snapshots yet.'));
      return;
    }
    snapshots.slice(0, 8).forEach((snapshot) => {
      const row = make('div', 'outcome-row');
      const top = make('div', 'outcome-top');
      top.append(make('span', 'outcome-name', `${snapshot.platform.toUpperCase()} · ${snapshot.metricName}`));
      top.append(make('span', 'mini-state', String(snapshot.value)));
      row.append(top);
      row.append(make('p', 'outcome-copy', `${snapshot.source} · ${new Date(snapshot.observedAt).toLocaleString()}`));
      list.append(row);
    });
  }

  function renderEvaluationExamples() {
    const list = $('evaluation-list');
    if (!list) return;
    clear(list);
    const examples = view.state.evaluationExamples || [];
    $('evaluation-count').textContent = String(examples.length);
    if (!examples.length) {
      list.append(make('p', 'ledger-empty', 'No provider-read-back examples yet.'));
      return;
    }
    examples.slice(0, 8).forEach((example) => {
      const row = make('div', 'outcome-row');
      const top = make('div', 'outcome-top');
      top.append(make('span', 'outcome-name', `${String(example.platform || '').toUpperCase()} · ${example.action}`));
      top.append(make('span', 'mini-state', 'IMMUTABLE'));
      row.append(top);
      row.append(make('p', 'outcome-copy', `${example.commentText} · ${new Date(example.createdAt).toLocaleString()}`));
      list.append(row);
    });
  }

  function renderExemplars() {
    const list = $('exemplar-list');
    if (!list) return;
    clear(list);
    const exemplars = view.state.exemplars || [];
    $('exemplar-count').textContent = String(exemplars.length);
    if (!exemplars.length) {
      list.append(make('p', 'ledger-empty', 'No operator-approved exemplars pinned yet.'));
      return;
    }
    exemplars.slice(0, 8).forEach((exemplar) => {
      const row = make('div', 'exemplar-row');
      const top = make('div', 'exemplar-top');
      top.append(make('span', 'exemplar-name', `${exemplar.platform.toUpperCase()} · ${exemplar.action} · v${exemplar.version}`));
      top.append(make('span', 'mini-state', exemplar.sourceHash.slice(0, 8)));
      row.append(top);
      row.append(make('p', 'exemplar-copy', exemplar.text));
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
        targetId: view.analysis.pack.source.targetId,
        replyToId: view.analysis.pack.source.replyToId,
        videoId: view.analysis.pack.source.videoId,
        channelId: view.analysis.pack.source.channelId,
        ownershipStatus: view.analysis.pack.source.ownershipStatus,
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
      const receipt = live
        ? platform === 'youtube'
          ? await api.executeYouTube({ candidate, pack: view.analysis.pack, targetUrl: view.analysis.pack.source.url })
          : ['instagram', 'facebook'].includes(platform)
            ? await api.executeMeta({ candidate, pack: view.analysis.pack, targetUrl: view.analysis.pack.source.url })
            : await api.simulate({ candidate, pack: view.analysis.pack, targetUrl: view.analysis.pack.source.url, platform })
        : await api.simulate({ candidate, pack: view.analysis.pack, targetUrl: view.analysis.pack.source.url, platform });
      view.ledger = await api.listLedger();
      view.state = await api.loadState();
      renderLedger();
      renderAccounts();
      renderReconciliation();
      notify(live ? `Live action verified: ${receipt.receiptId}` : `Simulation receipt written: ${receipt.receiptId}`);
    } catch (error) {
      notify(errorMessage(error), true);
    }
  }

  function applyAutomationResult(result) {
    if (!result?.state) return;
    view.state = result.state;
    view.analysis = result.state.lastAnalysis || view.analysis;
    view.selectedId = view.analysis?.selectedId || null;
    view.contextDirty = false;
    populateForms();
    renderContext();
    renderCandidates();
  }

  async function runAutomationNow() {
    try {
      setRunState('RUNNING ENABLED SURFACES', 'warn');
      const result = await api.runAutomationNow();
      applyAutomationResult(result);
      view.ledger = await api.listLedger();
      renderLedger();
      (result.platforms || []).forEach((summary) => {
        appendConsole(summary.status === 'COMPLETED' || summary.status === 'NO_OP' ? 'assistant' : 'error', `${summary.platform.toUpperCase()}: ${summary.status} · ${summary.completedActions} action(s)${summary.results?.[0]?.reason ? ` — ${summary.results[0].reason}` : ''}`);
      });
      setRunState(result.state?.execution?.paused ? 'CIRCUIT BREAKER PAUSED' : result.state?.automation?.status === 'SCHEDULED' ? 'AUTOMATION SCHEDULED' : 'AUTOMATION COMPLETE', result.state?.execution?.paused ? 'block' : 'ok');
      notify(`Automation completed across ${(result.platforms || []).length} enabled surface(s); ${result.platforms?.reduce((total, item) => total + item.completedActions, 0) || 0} action(s) completed.`);
    } catch (error) {
      setRunState('AUTOMATION BLOCKED', 'block');
      notify(errorMessage(error), true);
    }
  }

  async function runNicheCycle() {
    try {
      const platform = $('cycle-platform').value;
      setRunState(platform === 'youtube' ? 'DISCOVERING NICHE TARGETS' : `READING ${platform.toUpperCase()} OWNED MEDIA`, 'warn');
      const result = platform === 'youtube'
        ? await api.runYouTubeCycle({ query: $('discovery-query').value.trim() })
        : await api.runMetaCycle({ platform });
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
      notify(`${platform === 'youtube' ? 'Discovered' : 'Read'} ${result.discovered} ${platform} targets; ${result.completedActions} passed and ${blocked} were blocked or skipped.`);
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

  async function hydrateMeta() {
    try {
      const platform = $('context-platform').value;
      const account = (view.state.accounts || []).find((item) => item.platform === platform && item.status === 'connected');
      if (!account) throw new Error(`Connect a ${platform} actor account before owned-media hydration.`);
      const targetId = $('context-target-id').value.trim();
      if (!targetId) throw new Error('Enter the provider media or Page post ID before hydration.');
      setRunState(`HYDRATING ${platform.toUpperCase()}`, 'warn');
      const result = await api.fetchMetaContext({ platform, actorAccountId: account.providerAccountId, targetId });
      view.state = result.state;
      populateForms();
      await analyze();
      notify(`${platform} owned media and comments hydrated through the official Meta Graph API.`);
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
      visionModel: $('provider-vision-model').value.trim(),
      transcriptionModel: $('provider-transcription-model').value.trim(),
      criticModel: $('provider-critic-model').value.trim(),
      apiKey: $('provider-key').value,
    });
    populateForms();
    notify('Model adapter saved with OS-protected key storage.');
  }

  async function saveYouTube() {
    view.state = await api.saveYouTubeSecrets({
      apiKey: $('youtube-api-key').value,
      oauthClientId: $('youtube-oauth-client-id').value.trim(),
      oauthClientSecret: $('youtube-oauth-client-secret').value,
    });
    $('youtube-api-key').value = '';
    $('youtube-oauth-client-secret').value = '';
    populateForms();
    notify('YouTube connection settings saved. Connect the prefilled desktop client once to authorize.');
  }

  async function connectYouTube() {
    try {
      $('youtube-status').textContent = 'Opening the signed-in browser for PKCE authorization…';
      $('connect-youtube').disabled = true;
      view.state = await api.connectYouTube();
      populateForms();
      notify('YouTube connected. Refreshable OAuth credentials are stored by the operating system.');
    } catch (error) {
      populateForms();
      notify(errorMessage(error), true);
    }
  }

  async function disconnectYouTube() {
    try {
      view.state = await api.disconnectYouTube();
      populateForms();
      notify(view.state.youtube.oauthStatusReason === 'revocation_unconfirmed'
        ? 'Local YouTube credentials were removed, but Google revocation could not be confirmed.'
        : 'YouTube disconnected and local OAuth credentials removed.');
    } catch (error) {
      notify(errorMessage(error), true);
    }
  }

  async function saveMeta() {
    view.state = await api.saveMetaSecrets({
      appId: $('meta-app-id').value.trim(),
      graphApiVersion: $('meta-graph-version').value.trim(),
      appSecret: $('meta-app-secret').value,
    });
    $('meta-app-secret').value = '';
    populateForms();
    notify('Meta connection settings saved. Connect once to authorize the managed Page and Instagram accounts.');
  }

  async function connectMeta() {
    try {
      $('meta-status').textContent = 'Opening the signed-in browser for Meta authorization…';
      $('connect-meta').disabled = true;
      view.state = await api.connectMeta();
      populateForms();
      notify('Meta connected. Managed Page and linked professional Instagram actor accounts are registered.');
    } catch (error) {
      populateForms();
      notify(errorMessage(error), true);
    }
  }

  async function disconnectMeta() {
    try {
      view.state = await api.disconnectMeta();
      populateForms();
      notify('Meta actor credentials were removed locally and accounts were marked disconnected.');
    } catch (error) {
      notify(errorMessage(error), true);
    }
  }

  async function pinExemplar() {
    const candidate = candidateById(view.selectedId);
    const pack = view.analysis?.pack;
    if (!candidate || candidate.gate.verdict !== 'PASS' || !pack) return;
    try {
      const result = await api.pinExemplar({
        platform: pack.source.platform,
        action: pack.source.action || 'comment',
        text: candidate.text,
        evidence: candidate.evidence,
      });
      view.state = result.state;
      populateForms();
      notify('Selected candidate pinned as an immutable operator exemplar.');
    } catch (error) {
      notify(errorMessage(error), true);
    }
  }

  async function chooseMedia() {
    try {
      const filePath = await api.chooseMedia();
      if (filePath) $('media-file-path').value = filePath;
    } catch (error) {
      notify(errorMessage(error), true);
    }
  }

  async function inspectMedia() {
    const filePath = $('media-file-path').value.trim();
    if (!filePath) {
      notify('Choose an authorized local video before inspection.', true);
      return;
    }
    try {
      setRunState('INSPECTING AUTHORIZED MEDIA', 'warn');
      const result = await api.inspectMedia({ filePath, transcriptPath: $('media-transcript-path').value.trim(), mediaId: $('context-target-id').value.trim() });
      view.state = result.state;
      $('context-transcript').value = result.bundle.transcript || '';
      $('context-visual').value = result.bundle.visualNotes || '';
      $('media-status').textContent = `Inspected ${result.bundle.mediaProvenance.sourceHash.slice(0, 16)}… · audio ${result.bundle.transcriptStatus} · visual ${result.bundle.visualStatus}. Re-run analysis to bind the evidence.`;
      populateForms();
      await analyze();
      notify(result.bundle.visualStatus === 'provider_analyzed' ? 'Authorized media frames were analyzed through the configured vision model.' : 'Authorized media was hashed and inspected; semantic visual analysis is not configured, so the model cannot imply it watched the video.');
    } catch (error) {
      setRunState('MEDIA INSPECTION BLOCKED', 'block');
      notify(errorMessage(error), true);
    }
  }

  async function saveExecution() {
    view.state = await api.saveExecution({
      autonomyEnabled: $('autonomy-enabled').checked,
      liveWritesEnabled: $('live-writes-enabled').checked,
      cycleIntervalMinutes: $('automation-interval').value,
      enabledPlatforms: ['youtube', 'instagram', 'facebook'].filter((platform) => $(`automation-${platform}`).checked),
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
    $('context-platform').addEventListener('change', () => {
      const platform = $('context-platform').value;
      if (['instagram', 'facebook'].includes(platform)) {
        $('context-scope').value = 'owned';
        $('context-action').value = 'reply';
      } else if (platform === 'youtube') {
        $('context-scope').value = 'external';
        $('context-action').value = 'comment';
      }
      renderPlatformContract(platform, $('context-scope').value);
    });
    $('context-scope').addEventListener('change', () => renderPlatformContract($('context-platform').value, $('context-scope').value));
    $('context-action').addEventListener('change', () => renderPlatformContract($('context-platform').value, $('context-scope').value));
    $('cycle-platform').addEventListener('change', updateCycleLabel);
    $('context-form').addEventListener('input', () => {
      if (!view.analysis) return;
      view.contextDirty = true;
      renderSelected(candidateById(view.selectedId));
      setRunState('CONTEXT CHANGED', 'warn');
    });
    $('run-cycle').addEventListener('click', runAutomationNow);
    $('run-selected-cycle').addEventListener('click', runNicheCycle);
    $('hydrate-youtube').addEventListener('click', hydrateYouTube);
    $('hydrate-meta').addEventListener('click', hydrateMeta);
    $('save-profile').addEventListener('click', saveProfile);
    $('save-provider').addEventListener('click', saveProvider);
    $('save-youtube').addEventListener('click', saveYouTube);
    $('connect-youtube').addEventListener('click', connectYouTube);
    $('disconnect-youtube').addEventListener('click', disconnectYouTube);
    $('save-meta').addEventListener('click', saveMeta);
    $('connect-meta').addEventListener('click', connectMeta);
    $('disconnect-meta').addEventListener('click', disconnectMeta);
    $('pin-exemplar').addEventListener('click', pinExemplar);
    $('choose-media').addEventListener('click', chooseMedia);
    $('inspect-media').addEventListener('click', inspectMedia);
    $('autonomy-enabled').addEventListener('change', saveExecution);
    $('live-writes-enabled').addEventListener('change', saveExecution);
    $('automation-interval').addEventListener('change', saveExecution);
    ['automation-youtube', 'automation-instagram', 'automation-facebook'].forEach((id) => $(id).addEventListener('change', saveExecution));
    ['max-per-run', 'max-per-day', 'lookback-days', 'target-cooldown', 'account-cooldown', 'minimum-score'].forEach((id) => $(id).addEventListener('change', saveExecution));
    $('kill-switch').addEventListener('click', togglePause);
    $('test-provider').addEventListener('click', testProvider);
    $('simulate-selected').addEventListener('click', executeSelected);
    $('execute-selected').addEventListener('click', executeSelected);
    $('console-form').addEventListener('submit', sendChat);
  }

  function listenForAutomationState() {
    if (typeof api.onAutomationState !== 'function') return;
    api.onAutomationState((nextState) => {
      if (!nextState) return;
      view.state = nextState;
      if (nextState.lastAnalysis) {
        view.analysis = nextState.lastAnalysis;
        view.selectedId = view.analysis.selectedId || null;
        view.contextDirty = false;
        renderContext();
        renderCandidates();
      }
      renderAutomation();
      renderPolicy();
    });
  }

  async function init() {
    if (!api) {
      notify('The Electron preload bridge is unavailable.', true);
      return;
    }
    try {
      listenForAutomationState();
      [view.state, view.capabilities, view.ledger] = await Promise.all([api.loadState(), api.listCapabilities(), api.listLedger()]);
      populateForms();
      renderCapabilities();
      renderLedger();
      view.analysis = view.state.lastAnalysis || null;
      renderContext();
      renderCandidates();
      bind();
      updateCycleLabel();
      await analyze();
    } catch (error) {
      setRunState('BOOT BLOCKED', 'block');
      notify(errorMessage(error), true);
    }
  }

  init();
})();
