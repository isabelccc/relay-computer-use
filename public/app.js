const $ = (s) => document.querySelector(s);
const esc = (s) =>
  String(s ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
let runs = [],
  catalog = [],
  selectedId = null,
  selectedTab = 'session',
  currentPage = 'operations',
  lease = null,
  observation = null,
  busy = false,
  lastScreenshot = '',
  config = null,
  handoffSignature = '',
  runCapability = null;
const pretty = (s) =>
  String(s)
    .replaceAll('_', ' ')
    .replace(/^./, (c) => c.toUpperCase());
async function api(path, body) {
  const response = await fetch('/api' + path, {
    method: body ? 'POST' : 'GET',
    headers: { 'Content-Type': 'application/json', 'X-Relay-Client': '1' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  let data;
  try {
    data = await response.json();
  } catch {
    throw new Error('Connection unavailable');
  }
  if (!response.ok) throw new Error(pretty(data.error || 'Request failed'));
  return data;
}
function toast(message) {
  $('#toast').textContent = message;
  $('#toast').hidden = false;
  setTimeout(() => ($('#toast').hidden = true), 4500);
}
function selected() {
  return runs.find((r) => r.id === selectedId);
}
function state(r) {
  if (r.status === 'completed') {
    return r.result?.status === 'success'
      ? ['success', 'SUCCESS']
      : r.result?.status === 'business_outcome'
        ? ['neutral', 'BUSINESS OUTCOME']
        : ['failure', 'FAILED'];
  }
  return r.status === 'human_owned'
    ? ['attention', 'HUMAN CONTROL']
    : r.status === 'awaiting_human'
      ? ['attention', 'NEEDS OPERATOR']
      : ['running', 'RUNNING'];
}
function openRun(mode = 'replay', capability = selected()?.capability || catalog[0]) {
  runCapability = capability;
  if (config?.targetUrl) $('#run-form').elements.targetUrl.value = config.targetUrl;
  $('#run-form').elements.mode.value = mode;
  $('#goal-field').hidden = mode !== 'discovery';
  $('#form-error').hidden = true;
  $('#run-dialog').showModal();
}
function showPage(page) {
  window.scrollTo(0, 0);
  currentPage = page;
  for (const p of ['operations', 'capabilities', 'policy'])
    $('#' + p + '-page').hidden = p !== page;
  document
    .querySelectorAll('[data-page]')
    .forEach((b) => b.classList.toggle('active', b.dataset.page === page));
  $('#breadcrumb').textContent = page === 'policy' ? 'Safety & policy' : pretty(page);
  if (page === 'capabilities') renderCatalog();
}
function renderList() {
  $('#run-empty').hidden = runs.length > 0;
  $('#metric-runs').innerHTML = `${runs.length}<span>tracked end to end</span>`;
  $('#metric-attention').innerHTML =
    `${runs.filter((r) => ['awaiting_human', 'human_owned'].includes(r.status)).length}<span>awaiting an operator</span>`;
  $('#run-list').innerHTML = runs
    .map((r) => {
      const [cls, label] = state(r);
      return `<button class="run-item ${r.id === selectedId ? 'selected' : ''}" data-run="${esc(r.id)}"><div class="run-row"><span class="run-name">${r.mode === 'discovery' ? '✧ Discovery' : '↻ Replay'}</span><time class="run-time">${new Date(r.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time></div><p>Member savings inquiry</p><div class="run-row"><span class="status ${cls}">${label}</span><span class="run-time">${esc(r.scenario)}</span></div><div class="run-meta"><span>${esc(r.id.slice(0, 8))}</span><span>${r.modelCalls} model calls</span></div></button>`;
    })
    .join('');
  document.querySelectorAll('[data-run]').forEach(
    (b) =>
      (b.onclick = () => {
        if (selectedId !== b.dataset.run) {
          handoffSignature = '';
          selectedId = b.dataset.run;
          lease = null;
          observation = null;
          lastScreenshot = '';
        }
        render();
      }),
  );
}
function renderTimeline(r) {
  $('#timeline-tab').innerHTML = r
    ? r.events
        .map(
          (e) =>
            `<div class="log-event"><span class="log-seq">${String(e.seq).padStart(2, '0')}</span><div><b class="${e.actor === 'human' ? 'human-label' : ''}">${esc(pretty(e.type))}</b><p>${[e.actor, e.stepId, e.target, e.heading, e.code, e.reason].filter(Boolean).map(esc).join(' · ')}</p></div><time>${new Date(e.time).toLocaleTimeString()}</time></div>`,
        )
        .join('')
    : '<p class="muted">A run’s verified actions and checkpoints will appear here.</p>';
}
function renderArtifact(r) {
  const c = r?.mode === 'discovery' ? r.capability : r?.capability || catalog[0];
  $('#artifact-tab').innerHTML = c
    ? `<div class="artifact-meta"><span>${esc(c.id)} · v${esc(c.version)}</span><button id="download-artifact" class="button subtle">Download JSON ↓</button></div><p class="muted">${c.provenance.kind === 'llm-discovery' ? 'Recorded from a genuine model-driven run.' : 'Hand-authored starter example. Run discovery to record your own.'}</p><pre class="code-view">${esc(JSON.stringify(c, null, 2))}</pre>`
    : '<p class="muted">A successful discovery saves the executable capability here.</p>';
  const b = $('#download-artifact');
  if (b)
    b.onclick = () => {
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(c, null, 2)], { type: 'application/json' }),
      );
      const a = document.createElement('a');
      a.href = url;
      a.download = c.id + '.json';
      a.click();
      URL.revokeObjectURL(url);
    };
}
function renderResult(r) {
  const box = $('#result-panel');
  box.hidden = !r?.result;
  if (!r?.result) return;
  box.classList.toggle('error', r.result.status === 'failure');
  if (r.result.status === 'success') {
    const out = r.result.outputs;
    box.innerHTML = `<h3>CHECKPOINT VERIFIED · OUTPUTS RETURNED</h3><div class="result-grid"><div><small>AVAILABLE BALANCE</small><b>${out.availableBalance ? new Intl.NumberFormat('en-US', { style: 'currency', currency: out.availableBalance.currency }).format(out.availableBalance.minorUnits / 100) : '—'}</b></div><div><small>ACCOUNT STATUS</small><b>${esc(out.accountStatus || '—')}</b></div></div>`;
  } else {
    const advice = {
      MODEL_WORKSPACE_REQUIRED:
        'Set the workspace ID belonging to your Anthropic key in the local .env file, then start a new discovery.',
      MODEL_WORKSPACE_NOT_FOUND:
        'The API key cannot access the configured workspace. Use a matching workspace ID or workspace-scoped key.',
      MODEL_CREDITS_REQUIRED:
        'Add API credits in the Claude Console account that owns this key, then retry discovery.',
      MODEL_KEY_MISSING: 'Add an authorized model API key to the local .env file.',
    }[r.result.code];
    box.innerHTML = `<h3>${esc(r.result.status === 'business_outcome' ? 'EXPECTED BUSINESS OUTCOME' : 'EXECUTION STOPPED')}</h3><p>${esc(pretty(r.result.code))}</p><p>At ${esc(r.result.stepId)}${r.result.observed ? ' · Observed: ' + esc(r.result.observed) : ''}</p>${advice ? '<p>' + esc(advice) + '</p>' : ''}`;
  }
}
function renderHandoff(r) {
  const box = $('#handoff-panel');
  box.hidden = !r?.intervention;
  if (!r?.intervention) {
    handoffSignature = '';
    return;
  }
  const signature = JSON.stringify([
    r.id,
    r.status,
    r.epoch,
    !!lease,
    observation?.checkpoint,
    observation?.controls.map((c) => c.id),
  ]);
  if (signature === handoffSignature) return;
  handoffSignature = signature;
  const owned = lease && r.status === 'human_owned' && lease.epoch === r.epoch;
  box.innerHTML = `<h3>${owned ? 'You control this live session' : 'An operator is needed'}</h3><p>${esc(pretty(r.intervention.code))} · ${esc(r.intervention.observed)}<br>${r.intervention.expected ? 'To resume, reach: ' + esc(r.intervention.expected.heading) : 'Resolve the blocked state, then return control.'}</p><div class="handoff-buttons">${r.status === 'awaiting_human' ? '<button id="claim" class="button primary">Take control →</button>' : ''}${owned ? '<button id="resume" class="button primary">Return control & resume</button>' : ''}<button id="cancel-run" class="button secondary">Stop run</button></div>${owned ? '<div id="operator-controls" class="operator-controls"></div>' : ''}`;
  if ($('#claim'))
    $('#claim').onclick = async () => {
      try {
        lease = await api(`/runs/${r.id}/claim`, {});
        await refresh();
        await updateObservation();
      } catch (e) {
        toast(e.message);
      }
    };
  if ($('#resume'))
    $('#resume').onclick = async () => {
      try {
        await api(`/runs/${r.id}/resume`, lease);
        lease = null;
        await refresh();
      } catch (e) {
        toast(e.message);
      }
    };
  $('#cancel-run').onclick = async () => {
    try {
      await api(`/runs/${r.id}/cancel`, {});
      lease = null;
      await refresh();
    } catch (e) {
      toast(e.message);
    }
  };
  if (owned && observation) {
    $('#operator-controls').innerHTML = observation.controls
      .filter(
        (c) =>
          !c.readable &&
          !['Transfer funds', 'Close account', 'Submit payment'].includes(c.target.name),
      )
      .map((c) =>
        c.writable
          ? `<label class="field">${esc(c.target.name)}<input id="manual-value" placeholder="10002" maxlength="5"><button class="button secondary" data-control="${c.id}" data-fill="true">Fill field</button></label>`
          : `<button class="button secondary" data-control="${c.id}">${esc(c.target.name)}</button>`,
      )
      .join('');
    document
      .querySelectorAll('[data-control]')
      .forEach(
        (b) =>
          (b.onclick = () =>
            humanAction(b.dataset.control, b.dataset.fill ? $('#manual-value').value : undefined)),
      );
  }
}
async function humanAction(controlId, value) {
  if (!lease || !selectedId) return;
  try {
    await api(`/runs/${selectedId}/action`, {
      ...lease,
      controlId,
      ...(value !== undefined ? { value } : {}),
    });
    await updateObservation();
    await refresh();
    lastScreenshot = '';
  } catch (e) {
    toast(e.message);
  }
}
async function updateObservation() {
  const r = selected();
  if (!r || r.status === 'completed') return;
  try {
    observation = await api(`/runs/${r.id}/observation`);
    renderHandoff(r);
  } catch {
    /* Closed between requests. */
  }
}
function render() {
  renderList();
  const r = selected();
  const [cls, label] = r ? state(r) : ['neutral', 'READY'];
  $('#detail-status').className = 'status ' + cls;
  $('#detail-status').textContent = label;
  $('#detail-title').textContent = r
    ? r.mode === 'discovery'
      ? r.status === 'completed'
        ? r.result?.status === 'success'
          ? 'Discovered member inquiry'
          : 'Discovery stopped'
        : 'Discovering member inquiry'
      : 'Member savings inquiry'
    : 'Member savings inquiry';
  $('#ownership').textContent =
    r?.status === 'human_owned'
      ? '● Human owns session'
      : r?.status === 'awaiting_human'
        ? '○ Automation paused'
        : r?.status === 'running'
          ? '● Automation owns session'
          : 'Policy enforced';
  $('#detail-actions').innerHTML =
    r?.status === 'completed' && r.capability
      ? '<button id="replay-this" class="button secondary">Replay ↻</button>'
      : r && ['queued', 'running'].includes(r.status)
        ? '<button id="stop-active" class="button secondary">Stop run</button>'
        : '';
  if ($('#stop-active'))
    $('#stop-active').onclick = async () => {
      try {
        await api(`/runs/${r.id}/cancel`, {});
        await refresh();
      } catch (error) {
        toast(error.message);
      }
    };
  if ($('#replay-this')) $('#replay-this').onclick = () => openRun('replay');
  $('#session-caption').textContent = r
    ? `${r.status === 'completed' ? 'Final session frame' : 'Live browser'} · ${r.modelCalls} model calls · ${r.stepId}`
    : 'Each run gets its own browser context.';
  $('#session-image-wrap').classList.toggle('human', !!lease && r?.status === 'human_owned');
  renderTimeline(r);
  renderArtifact(r);
  renderResult(r);
  renderHandoff(r);
  if (r) {
    const stamp =
      r.status === 'completed' ? r.id + '-final' : r.id + '-' + Math.floor(Date.now() / 1500);
    if (stamp !== lastScreenshot) {
      lastScreenshot = stamp;
      $('#session-image').src = `/api/runs/${r.id}/screenshot?v=${stamp}`;
    }
  } else {
    $('#session-image').hidden = true;
    $('#session-placeholder').hidden = false;
  }
}
function renderCatalog() {
  const unique = [...catalog];
  for (const r of runs)
    if (
      r.mode === 'discovery' &&
      r.status === 'completed' &&
      r.result?.status === 'success' &&
      r.capability &&
      !unique.some((c) => c.provenance.runId === r.id)
    )
      unique.unshift(r.capability);
  $('#catalog').innerHTML = unique
    .map(
      (c, i) =>
        `<article class="catalog-item"><div class="catalog-head"><div><span class="status success">${c.provenance.kind === 'llm-discovery' ? 'DISCOVERED' : 'EXAMPLE'}</span><h2>${esc(c.id)}</h2><p>${esc(c.description)}</p></div><button class="button primary" data-catalog="${i}">Replay capability ↻</button></div><div class="catalog-contract"><div><h3>INPUT CONTRACT</h3>${c.inputs.map((f) => `<p>${esc(f.name)}: ${esc(f.type)} · private</p>`).join('')}</div><div><h3>OUTPUT CONTRACT</h3>${c.outputs.map((f) => `<p>${esc(f.name)}: ${esc(f.type)}</p>`).join('')}</div><div><h3>EXECUTION</h3><p>${c.steps.length} guarded steps · v${esc(c.version)}</p><p>Success: ${esc(c.success.heading)}</p></div></div><div class="catalog-provenance">${esc(c.provenance.provider)} / ${esc(c.provenance.model)} · ${esc(c.provenance.kind)}</div></article>`,
    )
    .join('');
  document.querySelectorAll('[data-catalog]').forEach(
    (b) =>
      (b.onclick = () => {
        const c = unique[Number(b.dataset.catalog)];
        selectedId =
          runs.find((r) => r.capability?.provenance.runId === c.provenance.runId)?.id ?? null;
        showPage('operations');
        openRun('replay', c);
      }),
  );
  $('#cap-count').textContent = String(unique.length);
  $('#metric-capabilities').innerHTML = `${unique.length}<span>ready to replay</span>`;
}
async function refresh() {
  if (busy) return;
  busy = true;
  try {
    runs = await api('/runs');
    if (!selectedId && runs[0]) selectedId = runs[0].id;
    render();
    renderCatalog();
    if (lease) await updateObservation();
  } catch (e) {
    if (!config) toast(e.message);
  } finally {
    busy = false;
  }
}
$('#new-run').onclick = () => openRun();
$('#quick-replay').onclick = () => openRun();
$('#close-dialog').onclick = () => $('#run-dialog').close();
document
  .querySelectorAll('[data-page]')
  .forEach((b) => (b.onclick = () => showPage(b.dataset.page)));
document.querySelectorAll('[data-tab]').forEach(
  (b) =>
    (b.onclick = () => {
      selectedTab = b.dataset.tab;
      document
        .querySelectorAll('[data-tab]')
        .forEach((t) => t.classList.toggle('selected', t === b));
      for (const name of ['session', 'timeline', 'artifact'])
        $('#' + name + '-tab').hidden = name !== selectedTab;
    }),
);
$('#run-form').elements.mode.forEach(
  (input) =>
    (input.onchange = () => {
      $('#goal-field').hidden = $('#run-form').elements.mode.value !== 'discovery';
    }),
);
$('#run-form').onsubmit = async (e) => {
  e.preventDefault();
  const form = e.target,
    button = form.querySelector('[type=submit]');
  button.disabled = true;
  $('#form-error').hidden = true;
  const data = new FormData(form);
  const body = {
    mode: data.get('mode'),
    targetUrl: data.get('targetUrl'),
    params: { memberId: data.get('memberId') },
    scenario: data.get('scenario'),
    variant: data.get('variant'),
  };
  if (body.mode === 'discovery') body.goal = data.get('goal');
  else if (runCapability) body.capability = runCapability;
  try {
    const result = await api('/runs', body);
    selectedId = result.id;
    lease = null;
    lastScreenshot = '';
    $('#run-dialog').close();
    showPage('operations');
    await refresh();
  } catch (error) {
    $('#form-error').textContent = error.message;
    $('#form-error').hidden = false;
  } finally {
    button.disabled = false;
  }
};
$('#session-image').onload = () => {
  $('#session-image').hidden = false;
  $('#session-placeholder').hidden = true;
};
$('#session-image').onerror = () => {
  lastScreenshot = '';
};
$('#session-image').onclick = (e) => {
  if (!lease || !observation || selected()?.status !== 'human_owned') return;
  const rect = e.target.getBoundingClientRect(),
    x = ((e.clientX - rect.left) * 1120) / rect.width,
    y = ((e.clientY - rect.top) * 760) / rect.height;
  const c = observation.controls.find(
    (c) =>
      c.bounds &&
      x >= c.bounds.x &&
      x <= c.bounds.x + c.bounds.width &&
      y >= c.bounds.y &&
      y <= c.bounds.y + c.bounds.height,
  );
  if (c && !c.writable && !c.readable) humanAction(c.id);
};
(async () => {
  try {
    [config, catalog] = await Promise.all([api('/config'), api('/capabilities')]);
    $('#provider-status').textContent = config.provider
      ? `${pretty(config.provider)} configured · ${config.model}`
      : 'Replay available · add a model key for discovery';
    await refresh();
  } catch (e) {
    toast(e.message);
  }
  setInterval(refresh, 1500);
})();
