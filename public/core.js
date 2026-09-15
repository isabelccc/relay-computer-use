/* A UI-only fixture. There is deliberately no member-data HTTP API. */
const root = document.getElementById('workspace');
const scenario = sessionStorage.getItem('scenario') || 'normal';
const variant = sessionStorage.getItem('variant') || 'base';
const members = {
  10001: { name: 'Avery Example', balance: '$4,825.50', status: 'Active' },
  10002: { name: 'Jordan Sample', balance: '$12,340.75', status: 'Active' },
};
let memberId = '';
let interrupted = false;
const field = (label, value) => `<label>${label} <input readonly value="${value}"></label>`;
function show(title, body) {
  root.innerHTML = `<span class="tag">MEMBER SERVICES</span><h1>${title}</h1>${body}`;
}
function button(label, fn, cls = '') {
  const b = document.createElement('button');
  b.textContent = label;
  b.className = cls;
  b.addEventListener('click', fn);
  root.append(b);
  return b;
}
function search() {
  show(
    'Member search',
    '<p>Find a member to view their account information.</p><table><tr><td><label>Member ID <input inputmode="numeric" maxlength="5" autocomplete="off" placeholder="Five-digit member number"></label></td></tr></table><p class="muted">Training members: 10001 · 10002</p>',
  );
  button('Search', () => {
    memberId = root.querySelector('input').value;
    if (!/^\d{5}$/.test(memberId)) {
      show('Member not found', '<div class="empty">Enter a valid five-digit member number.</div>');
      button('Back to search', search);
      return;
    }
    loadResults();
  });
}
function loadResults() {
  if (scenario === 'slow') {
    show('Loading', '<p>Retrieving member records…</p>');
    setTimeout(results, 900);
    return;
  }
  if (scenario === 'transient' && !interrupted) {
    interrupted = true;
    show(
      'Temporary interruption',
      '<div class="notice">The service is temporarily unavailable. Your request has not been processed.</div>',
    );
    button('Try again', results);
    return;
  }
  if (scenario === 'permission') {
    show('Permission denied', '<div class="empty">Your role does not permit member inquiry.</div>');
    return;
  }
  if (scenario === 'app-error') {
    show(
      'Application error',
      '<div class="empty">The core service could not complete this request.</div>',
    );
    return;
  }
  results();
}
function results() {
  const member = members[memberId];
  if (!member || scenario === 'not-found') {
    show(
      'Member not found',
      '<div class="empty">No matching member. Check the supplied identifier.</div>',
    );
    button('Back to search', search);
    return;
  }
  show(
    'Search results',
    `<p>One matching record</p><table><tr><th>Member</th><th>Relationship</th><th>Status</th></tr><tr><td>${member.name}</td><td>Personal banking</td><td>Active</td></tr></table>`,
  );
  button('Open member', overview);
  if (scenario === 'ambiguous')
    button('Open member', () => show('Application error', '<p>Wrong record selected.</p>'));
}
function overview() {
  if (scenario === 'session' && !interrupted) {
    interrupted = true;
    show(
      'Session expired',
      '<div class="notice">Your operator session requires reauthentication. Restore the training session to continue.</div>',
    );
    button('Restore session', overview);
    return;
  }
  if (scenario === 'dialog' && !interrupted) {
    interrupted = true;
    show(
      'Operator acknowledgement',
      '<div role="dialog" aria-label="Operator acknowledgement" class="notice">A staff member must acknowledge this servicing notice before continuing.</div>',
    );
    button('Acknowledge', overview);
    return;
  }
  show(
    'Member overview',
    `<p>${members[memberId].name}</p><table><tr><th>Relationship</th><th>Branch</th><th>Service level</th></tr><tr><td>Personal banking</td><td>Training branch</td><td>Standard</td></tr></table>`,
  );
  button('View accounts', accounts);
}
function accounts() {
  show(
    'Member accounts',
    '<p>Select an account to inspect its current balance.</p><table><tr><th>Account</th><th>Currency</th><th>Status</th></tr><tr><td>Primary savings</td><td>USD</td><td>Active</td></tr><tr><td>Everyday checking</td><td>USD</td><td>Active</td></tr></table>',
  );
  button('Open savings', savings);
}
function savings() {
  show(
    scenario === 'drift' ? 'Account workspace' : 'Savings account',
    `<p>Primary savings · Current account information</p><table><tr><td>${field('Account type', 'Savings')}</td></tr><tr><td>${field('Available balance', members[memberId].balance)}</td></tr><tr><td>${field('Account status', members[memberId].status)}</td></tr></table><p class="muted">Information is synthetic and provided for automation testing only.</p>`,
  );
  button('Back to search', search, 'secondary');
  button(
    'Transfer funds',
    () => {
      show('Application error', '<p>Unsafe transaction control invoked.</p>');
    },
    'danger',
  );
}
if (variant === 'alternate') {
  document.body.style.fontFamily = 'Georgia, serif';
  document.body.style.padding = '46px';
}
search();
