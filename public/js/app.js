'use strict';

(() => {
  const store = new EventTarget();
  store.token = null;
  store.config = null;
  store.places = [];
  store.tags = [];
  store.filter = [];
  store.route = null;

  function setState(patch) {
    Object.assign(store, patch);
    store.dispatchEvent(new CustomEvent('change', {
      detail: { changed: Object.keys(patch) }
    }));
  }

  const views = {
    splash: { id: 'viewSplash', kind: 'screen' },
    login: { id: 'viewLogin', kind: 'screen' },
    register: { id: 'viewRegister', kind: 'screen' },
    verify: { id: 'viewVerify', kind: 'screen' },
    photos: {
      id: 'viewPhotos', kind: 'screen',
      back: (p) => '#/place/' + p.placeId
    },
    map: { id: null, kind: 'map' },
    place: { id: 'viewPlace', kind: 'sheet', scrim: true },
    addPrompt: { id: 'viewAddPrompt', kind: 'sheet', scrim: false },
    addPlace: { id: 'viewAddPlace', kind: 'sheet', scrim: true },
    editPlace: {
      id: 'viewEditPlace', kind: 'sheet', scrim: true,
      back: (p) => '#/place/' + p.placeId
    },
    profile: { id: 'viewProfile', kind: 'sheet', scrim: true },
    tags: { id: 'viewTags', kind: 'sheet', scrim: true },
    editTag: {
      id: 'viewEditTag', kind: 'sheet', scrim: true,
      back: () => '#/tags'
    },
    account: { id: 'viewAccountMenu', kind: 'panel' }
  };

  const routes = [
    { pattern: /^#\/?$/, view: 'splash', keys: [] },
    { pattern: /^#\/login$/, view: 'login', keys: [] },
    { pattern: /^#\/register$/, view: 'register', keys: [] },
    { pattern: /^#\/verify$/, view: 'verify', keys: [] },
    { pattern: /^#\/map$/, view: 'map', keys: [] },
    { pattern: /^#\/add$/, view: 'addPrompt', keys: [] },
    { pattern: /^#\/add\/form$/, view: 'addPlace', keys: [] },
    { pattern: /^#\/place\/([^/]+)\/edit$/, view: 'editPlace', keys: ['placeId'] },
    { pattern: /^#\/place\/([^/]+)\/photos$/, view: 'photos', keys: ['placeId'] },
    { pattern: /^#\/place\/([^/]+)$/, view: 'place', keys: ['placeId'] },
    { pattern: /^#\/tags\/([^/]+)$/, view: 'editTag', keys: ['tagId'] },
    { pattern: /^#\/tags$/, view: 'tags', keys: [] },
    { pattern: /^#\/profile$/, view: 'profile', keys: [] },
    { pattern: /^#\/account$/, view: 'account', keys: [] }
  ];

  function parse(hash) {
    for (const route of routes) {
      const match = hash.match(route.pattern);
      if (match) {
        const params = Object.fromEntries(
          route.keys.map((key, index) => [key, match[index + 1]])
        );
        return { view: route.view, params };
      }
    }
    return null;
  }

  const app = document.getElementById('app');
  const scrim = document.getElementById('scrim');
  const avatarButton = document.getElementById('avatarButton');
  let firstRender = true;

  function hideAll() {
    for (const view of Object.values(views)) {
      if (view.id) {
        const node = document.getElementById(view.id);
        if (node) {
          node.hidden = true;
        }
      }
    }
  }

  function focusView(node) {
    if (firstRender || !node) {
      return;
    }
    const target = node.querySelector('[tabindex="-1"]') || node;
    if (!target.hasAttribute('tabindex')) {
      target.setAttribute('tabindex', '-1');
    }
    target.focus();
  }

  function render() {
    const route = store.route;
    const view = views[route.view];
    const node = view.id ? document.getElementById(view.id) : null;

    hideAll();

    app.classList.toggle('is-sheet-open', view.kind === 'sheet' && view.scrim === true);
    scrim.hidden = !(view.kind === 'sheet' && view.scrim === true);
    avatarButton.setAttribute('aria-expanded', view.kind === 'panel' ? 'true' : 'false');

    if (node) {
      node.hidden = false;
      const back = node.querySelector('[data-back]');
      if (back && view.back) {
        back.setAttribute('href', view.back(route.params));
      }
    }

    focusView(node);
    firstRender = false;
  }

  function onHashChange() {
    const route = parse(window.location.hash || '#/');
    if (!route) {
      window.location.replace('#/map');
      return;
    }
    setState({ route: route });
  }

  function go(hash) {
    window.location.hash = hash;
  }

  function openDialog(dialog) {
    dialog.returnValue = '';
    dialog.showModal();
  }

  const guards = {};
  const leaveDialog = document.getElementById('leaveDialog');
  let pendingHash = null;

  function registerGuard(viewName, isDirty) {
    guards[viewName] = isDirty;
  }

  function currentlyDirty() {
    const name = store.route && store.route.view;
    return Boolean(name && guards[name] && guards[name]());
  }

  document.addEventListener('click', (event) => {
    const link = event.target.closest('a[href^="#/"]');
    if (!link || !currentlyDirty()) {
      return;
    }
    event.preventDefault();
    pendingHash = link.getAttribute('href');
    openDialog(leaveDialog);
  });

  leaveDialog.addEventListener('close', () => {
    const target = pendingHash;
    pendingHash = null;
    if (leaveDialog.returnValue === 'confirm' && target) {
      go(target);
    }
  });

  const confirmDialog = document.getElementById('confirmDialog');
  let onConfirm = null;

  function confirmAction(options) {
    document.getElementById('confirmTitle').textContent = options.title;
    document.getElementById('confirmText').textContent = options.text || '';
    document.getElementById('confirmAcceptLabel').textContent = options.accept || 'Delete';

    const subject = document.getElementById('confirmSubject');
    subject.hidden = !options.subject;
    if (options.subject) {
      document.getElementById('confirmSubjectName').textContent = options.subject;
    }

    onConfirm = options.onConfirm || null;
    openDialog(confirmDialog);
  }

  confirmDialog.addEventListener('close', () => {
    const callback = onConfirm;
    onConfirm = null;
    if (confirmDialog.returnValue === 'confirm' && callback) {
      callback();
    }
  });

  const toast = document.getElementById('toast');
  const toastText = document.getElementById('toastText');
  const toastClose = document.getElementById('toastClose');
  let toastTimer = null;

  function showToast(message, kind) {
    const isError = kind === 'error';
    toastText.textContent = message;
    toast.setAttribute('role', isError ? 'alert' : 'status');
    toastClose.hidden = !isError;
    toast.hidden = false;

    window.clearTimeout(toastTimer);
    if (!isError) {
      toastTimer = window.setTimeout(() => {
        toast.hidden = true;
      }, 4000);
    }
  }

  toastClose.addEventListener('click', () => {
    toast.hidden = true;
  });

  avatarButton.addEventListener('click', (event) => {
    event.stopPropagation();
    go(store.route && store.route.view === 'account' ? '#/map' : '#/account');
  });

  document.addEventListener('click', (event) => {
    if (store.route && store.route.view === 'account' &&
      !event.target.closest('#viewAccountMenu') &&
      !event.target.closest('#avatarButton')) {
      go('#/map');
    }
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && store.route && store.route.view === 'account') {
      go('#/map');
      avatarButton.focus();
    }
  });

  store.addEventListener('change', (event) => {
    if (event.detail.changed.indexOf('route') !== -1) {
      render();
    }
  });
  window.addEventListener('hashchange', onHashChange);
  onHashChange();

  window.wanderer = {
    store,
    setState,
    go,
    registerGuard: registerGuard,
    confirmAction: confirmAction,
    showToast: showToast
  };

})();
