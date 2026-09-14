'use strict';

(() => {
  const store = new EventTarget();
  store.token = null;
  store.config = null;
  store.places = [];
  store.tags = [];
  store.filter = { tags: [], match: 'any' };
  store.route = null;
  store.pendingEmail = null;
  store.pendingLocation = null;
  store.selectedPlaceId = null;

  function setState(patch) {
    Object.assign(store, patch);
    store.dispatchEvent(new CustomEvent('change', {
      detail: { changed: Object.keys(patch) }
    }));
  }

  function messageFrom(body) {
    if (!body) {
      return null;
    }
    if (typeof body.error === 'string') {
      return body.error;
    }
    if (body.errors && typeof body.errors === 'object') {
      const messages = Object.values(body.errors);
      if (messages.length > 0) {
        return messages.join(' ');
      }
    }
    return null;
  }

  async function apiFetch(url, options) {
    const response = await fetch(url, options);

    if (response.status === 204) {
      return null;
    }

    let body = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }

    if (!response.ok) {
      const error = new Error(messageFrom(body) || 'Request failed (' + response.status + ')');
      error.status = response.status;
      error.body = body;
      throw error;
    }

    return body;
  }

  async function authedFetch(url, options) {
    const opts = options || {};
    const headers = Object.assign({}, opts.headers, {
      Authorization: 'Bearer ' + store.token
    });

    try {
      return await apiFetch(url, Object.assign({}, opts, { headers }));
    } catch (error) {
      if (error.status === 401) {
        destroyMap();
        clearSignedInViews();
        setState({
          token: null,
          pendingEmail: null,
          pendingLocation: null,
          selectedPlaceId: null,
          places: [],
          tags: [],
          filter: { tags: [], match: 'any' }
        });
        showToast('Your session has ended. Please sign in again.', 'error');
        go('#/login');
      }
      throw error;
    }
  }

  function authedSendJSON(url, method, body) {
    return authedFetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
  }

  function setBusy(button, busy, label) {
    button.disabled = busy;
    if (!busy) {
      button.classList.remove('is-loading');
      button.removeAttribute('aria-busy');
      button.textContent = label;
      return;
    }

    button.classList.add('is-loading');
    button.setAttribute('aria-busy', 'true');

    const spinner = document.createElement('span');
    spinner.className = 'spinner';
    const announcement = document.createElement('span');
    announcement.className = 'visually-hidden';
    announcement.textContent = 'Working';
    button.replaceChildren(spinner, announcement);
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
  const topBarZone = document.getElementById('topBarZone');
  const mapMenuZone = document.getElementById('mapMenuZone');
  let firstRender = true;

  const conditionalSurfaces = ['viewMapEmpty', 'tagsEmpty'];

  function hideAll() {
    for (const view of Object.values(views)) {
      if (view.id) {
        const node = document.getElementById(view.id);
        if (node) {
          node.hidden = true;
        }
      }
    }
    for (const id of conditionalSurfaces) {
      document.getElementById(id).hidden = true;
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

    const isFullScreen = view.kind === 'screen';
    topBarZone.hidden = isFullScreen;
    mapMenuZone.hidden = isFullScreen;

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

    onRouteEntered(route);
    focusView(node);
    firstRender = false;
  }

  const PUBLIC_VIEWS = ['splash', 'login', 'register', 'verify'];

  function onHashChange() {
    const route = parse(window.location.hash || '#/');
    if (!route) {
      window.location.replace('#/map');
      return;
    }
    if (!store.token && !PUBLIC_VIEWS.includes(route.view)) {
      window.location.replace('#/login');
      return;
    }
    setState({ route });
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

  function navigate(hash) {
    if (currentlyDirty()) {
      pendingHash = hash;
      openDialog(leaveDialog);
      return;
    }
    go(hash);
  }

  scrim.addEventListener('click', () => {
    navigate('#/map');
  });

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || document.querySelector('dialog[open]')) {
      return;
    }
    const view = store.route && views[store.route.view];
    if (!view || view.kind !== 'sheet') {
      return;
    }
    event.preventDefault();
    navigate('#/map');
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

  function renderPasswordRules(policy) {
    const list = document.getElementById('passwordRules');
    const template = document.getElementById('ruleTemplate');
    const rules = [{ key: 'length', text: 'At least ' + policy.min_length + ' characters' }];

    if (policy.require_number) {
      rules.push({ key: 'number', text: 'A number' });
    }
    if (policy.require_lowercase) {
      rules.push({ key: 'lowercase', text: 'A lower case letter' });
    }
    if (policy.require_uppercase) {
      rules.push({ key: 'uppercase', text: 'An upper case letter' });
    }
    if (policy.require_symbol) {
      rules.push({ key: 'symbol', text: 'A symbol' });
    }
    rules.push({ key: 'match', text: 'Both passwords match' });

    list.replaceChildren();
    rules.forEach((rule) => {
      const item = template.content.cloneNode(true);
      const li = item.querySelector('.rule');
      li.setAttribute('data-rule', rule.key);
      li.querySelector('.rule__text').textContent = rule.text;
      list.appendChild(item);
    });
  }

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

  async function loadMe() {
    const me = await authedFetch('/api/config/me');
    setState({ config: me });
    if (/^#[0-9a-f]{6}$/i.test(me.tag.default_color)) {
      document.documentElement.style.setProperty('--tag-color-default', me.tag.default_color);
    }
  }

  const loginForm = document.getElementById('loginForm');
  const loginSubmit = document.getElementById('loginSubmit');

  loginForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    setBusy(loginSubmit, true);

    try {
      const result = await apiFetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: document.getElementById('loginEmail').value.trim(),
          password: document.getElementById('loginPassword').value
        })
      });
      setState({ token: result.token });
      await enterApp();
    } catch (error) {
      showToast(error.message, 'error');
    } finally {
      setBusy(loginSubmit, false, 'Sign in');
    }
  });

  const registerForm = document.getElementById('registerForm');
  const registerEmail = document.getElementById('registerEmail');
  const registerPassword = document.getElementById('registerPassword');
  const registerConfirm = document.getElementById('registerConfirm');
  const registerSubmit = document.getElementById('registerSubmit');

  function checkPasswordRules() {
    const policy = store.config?.password;
    if (!policy) {
      return;
    }

    const value = registerPassword.value;
    const met = {
      length: value.length >= policy.min_length,
      number: /[0-9]/.test(value),
      lowercase: /[a-z]/.test(value),
      uppercase: /[A-Z]/.test(value),
      symbol: /[^A-Za-z0-9]/.test(value),
      match: value.length > 0 && value === registerConfirm.value
    };

    let allMet = true;
    for (const rule of document.querySelectorAll('#passwordRules .rule')) {
      const passed = met[rule.dataset.rule];
      rule.dataset.met = passed ? 'true' : 'false';
      rule.querySelector('.rule__state').textContent = passed ? 'met' : 'not met';
      if (!passed) {
        allMet = false;
      }
    }
    registerSubmit.disabled = !allMet;
  }

  registerPassword.addEventListener('input', checkPasswordRules);
  registerConfirm.addEventListener('input', checkPasswordRules);

  registerForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    setBusy(registerSubmit, true);
    const email = registerEmail.value.trim();

    try {
      await apiFetch('/api/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password: registerPassword.value })
      });
      setState({ pendingEmail: email });

      if (store.config.auto_verify_new_accounts) {
        showToast('Account created. You can sign in now.');
        go('#/login');
      } else {
        startCooldown();
        go('#/verify');
      }
    } catch (error) {
      showToast(error.message, 'error');
    } finally {
      setBusy(registerSubmit, false, 'Create account');
      checkPasswordRules();
    }
  });

  const RESEND_COOLDOWN_SECONDS = 60;
  const verifyResend = document.getElementById('verifyResend');
  let cooldownEndsAt = 0;
  let cooldownTimer = null;

  function tickCooldown() {
    const secondsLeft = Math.ceil((cooldownEndsAt - Date.now()) / 1000);
    if (secondsLeft <= 0) {
      window.clearInterval(cooldownTimer);
      cooldownTimer = null;
      verifyResend.disabled = false;
      verifyResend.textContent = 'Resend email';
      return;
    }
    verifyResend.textContent = 'Resend in ' + secondsLeft + 's';
  }

  function runCooldown() {
    verifyResend.disabled = true;
    window.clearInterval(cooldownTimer);
    tickCooldown();
    cooldownTimer = window.setInterval(tickCooldown, 1000);
  }

  function startCooldown() {
    cooldownEndsAt = Date.now() + RESEND_COOLDOWN_SECONDS * 1000;
    runCooldown();
  }

  function resumeCooldown() {
    if (cooldownEndsAt > Date.now()) {
      runCooldown();
      return;
    }
    verifyResend.disabled = !store.pendingEmail;
    verifyResend.textContent = 'Resend email';
  }

  function stopCooldown() {
    window.clearInterval(cooldownTimer);
    cooldownTimer = null;
  }

  verifyResend.addEventListener('click', async () => {
    if (!store.pendingEmail) {
      return;
    }
    startCooldown();
    try {
      await apiFetch('/api/resend-verification', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: store.pendingEmail })
      });
      showToast('Verification email sent.');
    } catch (error) {
      showToast(error.message, 'error');
    }
  });

  document.getElementById('logoutButton').addEventListener('click', () => {
    destroyMap();
    clearSignedInViews();
    setState({
      token: null,
      pendingEmail: null,
      pendingLocation: null,
      places: [],
      tags: [],
      filter: { tags: [], match: 'any' }
    });
    go('#/login');
    loadConfig();
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

  const MAP_STYLE = 'https://tiles.openfreemap.org/styles/bright';
  const MAP_CENTER = [-74.0135, 40.7054];
  const MAP_ZOOM = 12;

  let map = null;
  let markers = [];
  let bouncedPlaceId = null;

  function initMap() {
    if (map) {
      return;
    }
    map = new maplibregl.Map({
      container: 'map',
      style: MAP_STYLE,
      center: MAP_CENTER,
      zoom: MAP_ZOOM
    });

    let centreAtPressStart = null;
    map.on('movestart', () => {
      centreAtPressStart = map.getCenter();
    });

    map.on('click', (event) => {
      const centreNow = map.getCenter();
      const mapMoved = centreAtPressStart !== null &&
        (centreAtPressStart.lng !== centreNow.lng || centreAtPressStart.lat !== centreNow.lat);
      centreAtPressStart = null;

      if (!store.route || store.route.view !== 'addPrompt') {
        if (!mapMoved && store.selectedPlaceId) {
          setState({ selectedPlaceId: null });
        }
        return;
      }
      setState({
        pendingLocation: {
          latitude: event.lngLat.lat,
          longitude: event.lngLat.lng
        }
      });
      go('#/add/form');
    });
  }

  function setMapCursor(cursor) {
    if (map) {
      map.getCanvas().style.cursor = cursor;
    }
  }

  function clearMarkers() {
    for (const marker of markers) {
      marker.remove();
    }
    markers = [];
  }

  function destroyMap() {
    clearMarkers();
    if (map) {
      map.remove();
      map = null;
    }
  }

  function openPlace(placeId) {
    go('#/place/' + placeId);
  }

  function renderMarkers() {
    if (!map) {
      return;
    }
    clearMarkers();

    const template = document.getElementById('markerTemplate');

    for (const place of store.places) {
      const element = template.content.cloneNode(true).firstElementChild;
      const button = element.querySelector('.marker');
      const emoji = element.querySelector('.marker__emoji');

      if (/^#[0-9a-f]{6}$/i.test(place.primary_color || '')) {
        button.style.color = place.primary_color;
      }
      emoji.textContent = place.primary_emoji || '';
      button.setAttribute('aria-label', place.name);

      if (place.id === store.selectedPlaceId) {
        button.classList.add('marker--selected');
        if (store.selectedPlaceId !== bouncedPlaceId) {
          button.classList.add('marker--bounce');
          bouncedPlaceId = store.selectedPlaceId;
        }
      }
      button.addEventListener('click', (event) => {
        event.stopPropagation();
        openPlace(place.id);
      });

      markers.push(
        new maplibregl.Marker({ element })
          .setLngLat([place.longitude, place.latitude])
          .addTo(map)
      );
    }
  }

  function renderMapEmptyState() {
    const empty = document.getElementById('viewMapEmpty');
    const isFiltered = store.filter.tags.length > 0;

    document.getElementById('mapEmptyTitle').textContent =
      isFiltered ? 'Nothing matches' : 'No places yet';
    document.getElementById('mapEmptyText').textContent =
      isFiltered
        ? 'No place carries the tags you picked. Try removing one.'
        : 'Add one.';

    empty.hidden = !(store.route && store.route.view === 'map' && store.places.length === 0);
  }

  async function fetchPlaces(filter) {
    const params = new URLSearchParams();
    if (filter && filter.tags.length > 0) {
      params.set('tags', filter.tags.join(','));
      params.set('match', filter.match);
    }
    const query = params.toString();
    const places = await authedFetch('/api/places' + (query ? '?' + query : ''));
    setState({ places });
  }










  const addPlaceForm = document.getElementById('addPlaceForm');
  const addPlaceName = document.getElementById('addPlaceName');
  const addPlaceNote = document.getElementById('addPlaceNote');
  const addPlaceSave = document.getElementById('addPlaceSave');

  addPlaceName.addEventListener('input', () => {
    addPlaceSave.disabled = addPlaceName.value.trim() === '';
  });

  addPlaceForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!store.pendingLocation) {
      return;
    }
    setBusy(addPlaceSave, true);

    try {
      const place = await authedSendJSON('/api/places', 'POST', {
        name: addPlaceName.value.trim(),
        description: addPlaceNote.value.trim(),
        latitude: store.pendingLocation.latitude,
        longitude: store.pendingLocation.longitude
      });

      await fetchPlaces(store.filter);
      setState({ pendingLocation: null });
      showToast('Place saved.');
      go('#/place/' + place.id);
    } catch (error) {
      showToast(error.message, 'error');
    } finally {
      setBusy(addPlaceSave, false, 'Save place');
      addPlaceSave.disabled = addPlaceName.value.trim() === '';
    }
  });

  function placeUrl(placeId, suffix) {
    return '/api/places/' + encodeURIComponent(placeId) + (suffix || '');
  }

  function clearPlaceView() {
    document.getElementById('placeTitle').textContent = '';
    document.getElementById('placeDesc').textContent = '';
    document.getElementById('placeTags').replaceChildren();
  }

  function renderPlaceView(place, tags) {
    document.getElementById('placeTitle').textContent = place.name;
    document.getElementById('placeDesc').textContent = place.description || '';
    document.getElementById('placeEditLink')
      .setAttribute('href', '#/place/' + place.id + '/edit');

    const list = document.getElementById('placeTags');
    const template = document.getElementById('chipTemplate');
    list.replaceChildren();

    for (const tag of tags) {
      const item = template.content.cloneNode(true);
      const chip = item.querySelector('.chip');

      if (/^#[0-9a-f]{6}$/i.test(tag.color || '')) {
        chip.style.background = tag.color;
      }
      item.querySelector('.chip__emoji').textContent = tag.emoji || '';
      item.querySelector('.chip__label').textContent = tag.name;
      list.appendChild(item);
    }
  }

  let placeBeingLoaded = null;

  async function loadPlace(placeId) {
    clearPlaceView();
    placeBeingLoaded = placeId;

    try {
      const [place, tags] = await Promise.all([
        authedFetch(placeUrl(placeId)),
        authedFetch(placeUrl(placeId, '/tags'))
      ]);
      if (placeBeingLoaded !== placeId) {
        return;
      }
      renderPlaceView(place, tags);
    } catch (error) {
      if (placeBeingLoaded !== placeId) {
        return;
      }
      showToast(error.message, 'error');
      go('#/map');
    }
  }

  const editPlaceForm = document.getElementById('editPlaceForm');
  const editPlaceName = document.getElementById('editPlaceName');
  const editPlaceNote = document.getElementById('editPlaceNote');
  const editPlaceSave = document.getElementById('editPlaceSave');
  const editPlaceDelete = document.getElementById('editPlaceDelete');
  const assignedTagsList = document.getElementById('assignedTags');
  const allTagsList = document.getElementById('allTags');

  const MINUS_PATH = 'M6 12h12';
  const PLUS_PATH = 'M12 6v12M6 12h12';

  let editPlaceId = null;
  let editPlaceSaved = { name: '', description: '' };
  let editPlacePrimaryTagId = null;
  let editPlaceAssigned = [];
  let editPlaceAll = [];
  let editPlaceBusy = false;
  let editPlaceRefocus = null;

  function isEditPlaceDirty() {
    return editPlaceId !== null && (
      editPlaceName.value.trim() !== editPlaceSaved.name ||
      editPlaceNote.value.trim() !== editPlaceSaved.description
    );
  }

  registerGuard('editPlace', isEditPlaceDirty);

  function placeTagUrl(tagId) {
    return placeUrl(editPlaceId, '/tags/' + encodeURIComponent(tagId));
  }

  function buildEditChip(tag, isAssigned) {
    const item = document.getElementById('editChipTemplate').content.cloneNode(true);
    const chip = item.querySelector('.chip');
    const action = item.querySelector('.chip__action');
    const star = item.querySelector('.chip__star');
    const isPrimary = tag.id === editPlacePrimaryTagId;

    if (/^#[0-9a-f]{6}$/i.test(tag.color || '')) {
      chip.style.background = tag.color;
    }
    item.querySelector('.chip__emoji').textContent = tag.emoji || '';
    item.querySelector('.chip__label').textContent = tag.name;

    action.querySelector('path').setAttribute('d', isAssigned ? MINUS_PATH : PLUS_PATH);
    action.setAttribute('aria-label', (isAssigned ? 'Unassign ' : 'Assign ') + tag.name);
    action.disabled = editPlaceBusy;
    action.dataset.tagId = tag.id;
    action.dataset.control = 'action';
    action.addEventListener('click', () => toggleAssigned(tag, isAssigned));

    star.setAttribute('aria-pressed', isPrimary ? 'true' : 'false');
    star.setAttribute('aria-label',
      (isPrimary ? 'Clear ' : 'Make ') + tag.name + ' the primary tag');
    star.disabled = editPlaceBusy;
    star.dataset.tagId = tag.id;
    star.dataset.control = 'star';
    star.addEventListener('click', () => togglePrimary(tag, isPrimary, isAssigned));

    return item;
  }

  function renderEditPlaceTags() {
    assignedTagsList.replaceChildren();
    allTagsList.replaceChildren();

    const assignedIds = new Set(editPlaceAssigned.map((tag) => tag.id));

    for (const tag of editPlaceAssigned) {
      assignedTagsList.appendChild(buildEditChip(tag, true));
    }
    for (const tag of editPlaceAll) {
      if (!assignedIds.has(tag.id)) {
        allTagsList.appendChild(buildEditChip(tag, false));
      }
    }

    if (editPlaceRefocus && !editPlaceBusy) {
      const controls = document.querySelectorAll('#assignedTags [data-tag-id], #allTags [data-tag-id]');
      for (const control of controls) {
        if (control.dataset.tagId === editPlaceRefocus.tagId &&
          control.dataset.control === editPlaceRefocus.control) {
          control.focus();
          break;
        }
      }
      editPlaceRefocus = null;
    }
  }

  async function loadEditPlaceTags(resetFields) {
    const [place, assigned, all] = await Promise.all([
      authedFetch(placeUrl(editPlaceId)),
      authedFetch(placeUrl(editPlaceId, '/tags')),
      authedFetch('/api/tags/counts')
    ]);

    editPlacePrimaryTagId = place.primary_tag_id;
    editPlaceAssigned = assigned;
    editPlaceAll = all;
    setState({ tags: all });

    if (resetFields) {
      editPlaceName.value = place.name;
      editPlaceNote.value = place.description || '';
      editPlaceSaved = { name: place.name, description: place.description || '' };
    }
    renderEditPlaceTags();
  }

  async function runTagAction(work, refocus) {
    if (editPlaceBusy) {
      return;
    }
    editPlaceBusy = true;
    editPlaceRefocus = refocus;
    renderEditPlaceTags();

    try {
      await work();
      await loadEditPlaceTags(false);
      await fetchPlaces(store.filter);
    } catch (error) {
      showToast(error.message, 'error');
    } finally {
      editPlaceBusy = false;
      renderEditPlaceTags();
    }
  }

  function toggleAssigned(tag, isAssigned) {
    runTagAction(
      () => authedFetch(placeTagUrl(tag.id), { method: isAssigned ? 'DELETE' : 'PUT' }),
      { tagId: tag.id, control: 'action' }
    );
  }

  function togglePrimary(tag, isPrimary, isAssigned) {
    runTagAction(async () => {
      if (isPrimary) {
        await authedFetch(placeUrl(editPlaceId, '/primary-tag'), { method: 'DELETE' });
        return;
      }
      if (!isAssigned) {
        await authedFetch(placeTagUrl(tag.id), { method: 'PUT' });
      }
      await authedFetch(
        placeUrl(editPlaceId, '/primary-tag/' + encodeURIComponent(tag.id)),
        { method: 'PUT' }
      );
    }, { tagId: tag.id, control: 'star' });
  }

  async function loadEditPlace(placeId) {
    editPlaceId = placeId;
    editPlaceName.value = '';
    editPlaceNote.value = '';
    editPlaceSaved = { name: '', description: '' };
    editPlacePrimaryTagId = null;
    editPlaceAssigned = [];
    editPlaceAll = [];
    editPlaceBusy = false;
    editPlaceRefocus = null;
    renderEditPlaceTags();

    try {
      await loadEditPlaceTags(true);
    } catch (error) {
      if (editPlaceId !== placeId) {
        return;
      }
      showToast(error.message, 'error');
      go('#/map');
    }
  }

  async function deleteCurrentPlace() {
    const placeId = editPlaceId;
    setBusy(editPlaceSave, true);
    editPlaceDelete.disabled = true;

    try {
      await authedFetch(placeUrl(placeId), { method: 'DELETE' });

      editPlaceId = null;
      await fetchPlaces(store.filter);
      showToast('Place deleted.');
      go('#/map');
    } catch (error) {
      showToast(error.message, 'error');
    } finally {
      setBusy(editPlaceSave, false, 'Save');
      editPlaceDelete.disabled = false;
    }
  }

  editPlaceDelete.addEventListener('click', () => {
    const name = editPlaceName.value.trim();
    confirmAction({
      title: 'Delete this place?',
      text: (name || 'This place') + ' will be removed from your map. This cannot be undone.',
      accept: 'Delete',
      onConfirm: deleteCurrentPlace
    });
  });

  editPlaceForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    setBusy(editPlaceSave, true);

    try {
      const name = editPlaceName.value.trim();
      const description = editPlaceNote.value.trim();
      await authedSendJSON(placeUrl(editPlaceId), 'PUT', { name, description });

      editPlaceSaved = { name, description };
      await fetchPlaces(store.filter);
      showToast('Place saved.');
      go('#/place/' + editPlaceId);
    } catch (error) {
      showToast(error.message, 'error');
    } finally {
      setBusy(editPlaceSave, false, 'Save');
    }
  });

  const tagRowsList = document.getElementById('tagRows');
  const tagsEmpty = document.getElementById('tagsEmpty');
  const editTagForm = document.getElementById('editTagForm');
  const editTagTitle = document.getElementById('editTagTitle');
  const editTagName = document.getElementById('editTagName');
  const editTagEmoji = document.getElementById('editTagEmoji');
  const editTagColor = document.getElementById('editTagColor');
  const editTagPreview = document.getElementById('editTagPreview');
  const editTagPreviewEmoji = document.getElementById('editTagPreviewEmoji');
  const editTagPreviewLabel = document.getElementById('editTagPreviewLabel');
  const editTagSave = document.getElementById('editTagSave');
  const editTagDelete = document.getElementById('editTagDelete');

  const NEW_TAG = 'new';

  let editTagId = null;
  let editTagSaved = { name: '', emoji: '', color: '' };

  function tagUrl(tagId) {
    return '/api/tags/' + encodeURIComponent(tagId);
  }

  async function renderTagRows() {
    tagRowsList.replaceChildren();
    tagsEmpty.hidden = true;

    const tags = await authedFetch('/api/tags/counts');
    setState({ tags });
    const template = document.getElementById('tagRowTemplate');
    for (const tag of tags) {
      const item = template.content.cloneNode(true);
      const chip = item.querySelector('.chip');

      if (/^#[0-9a-f]{6}$/i.test(tag.color || '')) {
        chip.style.background = tag.color;
      }
      item.querySelector('.chip__emoji').textContent = tag.emoji || '';
      item.querySelector('.chip__label').textContent = tag.name;
      item.querySelector('.tag-row__count').textContent = tag.assignment_count;
      item.querySelector('.tag-row').setAttribute('href', '#/tags/' + tag.id);
      tagRowsList.appendChild(item);
    }

    tagsEmpty.hidden = tags.length > 0;
  }

  function graphemeCount(value) {
    if (typeof Intl.Segmenter !== 'function') {
      return value.length === 0 ? 0 : 1;
    }
    const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
    return [...segmenter.segment(value)].length;
  }

  function isEditTagDirty() {
    return editTagId !== null && (
      editTagName.value.trim() !== editTagSaved.name ||
      editTagEmoji.value.trim() !== editTagSaved.emoji ||
      editTagColor.value !== editTagSaved.color
    );
  }

  registerGuard('editTag', isEditTagDirty);

  function renderTagPreview() {
    const color = editTagColor.value;
    if (/^#[0-9a-f]{6}$/i.test(color)) {
      editTagPreview.style.background = color;
    }
    editTagPreviewEmoji.textContent = editTagEmoji.value.trim();
    editTagPreviewLabel.textContent = editTagName.value.trim();

    const emoji = editTagEmoji.value.trim();
    const emojiOk = emoji === '' || graphemeCount(emoji) === 1;
    editTagSave.disabled = editTagName.value.trim() === '' || !emojiOk;
  }

  editTagName.addEventListener('input', renderTagPreview);
  editTagEmoji.addEventListener('input', renderTagPreview);
  editTagColor.addEventListener('input', renderTagPreview);

  function tagDefaultColor() {
    return getComputedStyle(document.documentElement)
      .getPropertyValue('--tag-color-default')
      .trim();
  }

  function clearEditTagFields() {
    editTagName.value = '';
    editTagEmoji.value = '';
    editTagColor.value = tagDefaultColor();
    editTagSaved = { name: '', emoji: '', color: editTagColor.value };
    renderTagPreview();
  }

  async function loadEditTag(tagId) {
    editTagId = tagId;
    clearEditTagFields();
    const isNew = tagId === NEW_TAG;

    editTagTitle.textContent = isNew ? 'Add a tag' : 'Edit tag';
    editTagDelete.hidden = isNew;
    editTagSave.textContent = isNew ? 'Add tag' : 'Save tag';

    if (isNew) {
      return;
    }

    try {
      const tags = await authedFetch('/api/tags/counts');
      if (editTagId !== tagId) {
        return;
      }
      setState({ tags });

      const tag = tags.find((candidate) => candidate.id === tagId);
      if (!tag) {
        showToast('Not found.', 'error');
        go('#/tags');
        return;
      }

      editTagName.value = tag.name;
      editTagEmoji.value = tag.emoji || '';
      editTagColor.value = tag.color;
      editTagSaved = {
        name: editTagName.value.trim(),
        emoji: editTagEmoji.value.trim(),
        color: editTagColor.value
      };
      renderTagPreview();
    } catch (error) {
      if (editTagId !== tagId) {
        return;
      }
      showToast(error.message, 'error');
      go('#/tags');
    }
  }

  editTagForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const isNew = editTagId === NEW_TAG;
    const label = isNew ? 'Add tag' : 'Save tag';
    setBusy(editTagSave, true);

    try {
      const payload = {
        name: editTagName.value.trim(),
        emoji: editTagEmoji.value.trim(),
        color: editTagColor.value
      };
      if (isNew) {
        await authedSendJSON('/api/tags', 'POST', payload);
      } else {
        await authedSendJSON(tagUrl(editTagId), 'PUT', payload);
      }

      editTagSaved = { name: payload.name, emoji: payload.emoji, color: payload.color };

      await fetchPlaces(store.filter);
      showToast(isNew ? 'Tag added.' : 'Tag saved.');
      go('#/tags');
    } catch (error) {
      showToast(error.message, 'error');
    } finally {
      setBusy(editTagSave, false, label);
      renderTagPreview();
    }
  });

  async function deleteCurrentTag() {
    const tagId = editTagId;
    setBusy(editTagSave, true);
    editTagDelete.disabled = true;

    try {
      await authedFetch(tagUrl(tagId), { method: 'DELETE' });

      editTagId = null;

      const remaining = store.filter.tags.filter((id) => id !== tagId);
      if (remaining.length !== store.filter.tags.length) {
        setState({ filter: { tags: remaining, match: store.filter.match } });
      } else {
        await fetchPlaces(store.filter);
      }
      showToast('Tag deleted.');
      go('#/tags');
    } catch (error) {
      showToast(error.message, 'error');
    } finally {
      setBusy(editTagSave, false, 'Save tag');
      editTagDelete.disabled = false;
    }
  }

  editTagDelete.addEventListener('click', () => {
    const name = editTagName.value.trim() || 'This tag';
    const tag = store.tags.find((candidate) => candidate.id === editTagId);
    const count = tag && typeof tag.assignment_count === 'number' ? tag.assignment_count : null;
    const scope = count === null
      ? ' will be removed from every place that uses it.'
      : ' will be removed from ' + count + (count === 1 ? ' place.' : ' places.');

    confirmAction({
      title: 'Delete this tag?',
      text: name + scope + ' This cannot be undone.',
      accept: 'Delete',
      onConfirm: deleteCurrentTag
    });
  });

  const filterChips = document.getElementById('filterChips');

  async function fetchTags() {
    const tags = await authedFetch('/api/tags/counts');
    setState({ tags });
  }

  function renderFilterChips() {
    const template = document.getElementById('filterChipTemplate');
    const selected = new Set(store.filter.tags);

    filterChips.replaceChildren();

    const ordered = [...store.tags].sort((a, b) => b.assignment_count - a.assignment_count);

    for (const tag of ordered) {
      const item = template.content.cloneNode(true);
      const chip = item.querySelector('.chip');

      if (/^#[0-9a-f]{6}$/i.test(tag.color || '')) {
        chip.style.background = tag.color;
      }
      item.querySelector('.chip__emoji').textContent = tag.emoji || '';
      item.querySelector('.chip__label').textContent = tag.name;
      item.querySelector('.chip__count').textContent = tag.assignment_count;
      chip.setAttribute('aria-pressed', selected.has(tag.id) ? 'true' : 'false');
      chip.addEventListener('click', () => toggleFilterTag(tag.id));
      filterChips.appendChild(item);
    }
  }

  function toggleFilterTag(tagId) {
    const tags = store.filter.tags.includes(tagId)
      ? store.filter.tags.filter((id) => id !== tagId)
      : [...store.filter.tags, tagId];
    setState({ filter: { tags, match: store.filter.match } });
  }

  const DRAG_THRESHOLD = 5;
  let dragging = false;
  let dragMoved = false;
  let dragStartX = 0;
  let dragStartScroll = 0;

  filterChips.addEventListener('pointerdown', (event) => {
    if (event.pointerType !== 'mouse') {
      return;
    }
    dragging = true;
    dragMoved = false;
    dragStartX = event.clientX;
    dragStartScroll = filterChips.scrollLeft;
  });

  filterChips.addEventListener('pointermove', (event) => {
    if (!dragging) {
      return;
    }
    const delta = event.clientX - dragStartX;
    if (!dragMoved) {
      if (Math.abs(delta) <= DRAG_THRESHOLD) {
        return;
      }
      dragMoved = true;
      filterChips.setPointerCapture(event.pointerId);
      filterChips.classList.add('is-dragging');
    }
    filterChips.scrollLeft = dragStartScroll - delta;
  });

  function endFilterDrag(event) {
    if (!dragging) {
      return;
    }
    dragging = false;
    filterChips.classList.remove('is-dragging');
    if (event.pointerId !== undefined && filterChips.hasPointerCapture(event.pointerId)) {
      filterChips.releasePointerCapture(event.pointerId);
    }
  }

  filterChips.addEventListener('pointerup', endFilterDrag);
  filterChips.addEventListener('pointercancel', endFilterDrag);

  filterChips.addEventListener('click', (event) => {
    if (dragMoved) {
      event.preventDefault();
      event.stopPropagation();
      dragMoved = false;
    }
  }, true);

  function clearSignedInViews() {
    clearPlaceView();
    clearEditTagFields();
    editPlaceName.value = '';
    editPlaceNote.value = '';
    assignedTagsList.replaceChildren();
    allTagsList.replaceChildren();
    addPlaceForm.reset();
    tagRowsList.replaceChildren();
    tagsEmpty.hidden = true;
    filterChips.replaceChildren();
  }

  function onRouteEntered(route) {
    if (route.view === 'login') {
      loginForm.reset();
    }

    if (route.view === 'register') {
      registerForm.reset();
      checkPasswordRules();
    }

    if (route.view === 'verify') {
      resumeCooldown();
    } else {
      stopCooldown();
    }

    if (route.view === 'place') {
      loadPlace(route.params.placeId);
    } else {
      placeBeingLoaded = null;
    }

    if (route.view === 'editPlace') {
      loadEditPlace(route.params.placeId);
    } else {
      editPlaceId = null;
    }

    if (route.view === 'tags') {
      renderTagRows().catch((error) => showToast(error.message, 'error'));
    }

    if (route.view === 'editTag') {
      loadEditTag(route.params.tagId);
    } else {
      editTagId = null;
    }

    const viewedPlaceId = (route.view === 'place' || route.view === 'editPlace')
      ? route.params.placeId
      : null;
    if (viewedPlaceId && viewedPlaceId !== store.selectedPlaceId) {
      setState({ selectedPlaceId: viewedPlaceId });
    }

    setMapCursor(route.view === 'addPrompt' ? 'crosshair' : '');

    if (route.view === 'addPlace') {
      if (!store.pendingLocation) {
        go('#/add');
        return;
      }
      addPlaceForm.reset();
      addPlaceSave.disabled = true;
    }

    if (route.view !== 'addPrompt' && route.view !== 'addPlace' && store.pendingLocation) {
      setState({ pendingLocation: null });
    }

    if (route.view === 'map' && map) {
      map.resize();
    }
  }

  async function enterApp() {
    await loadMe();
    initMap();
    setMapCursor('');
    await Promise.all([fetchPlaces(store.filter), fetchTags()]);
    go('#/map');
  }

  store.addEventListener('change', (event) => {
    if (event.detail.changed.indexOf('route') !== -1) {
      render();
      renderMapEmptyState();
    }
    if (event.detail.changed.indexOf('places') !== -1) {
      renderMarkers();
      renderMapEmptyState();
    }
    if (event.detail.changed.indexOf('selectedPlaceId') !== -1) {
      renderMarkers();
    }
    if (event.detail.changed.indexOf('tags') !== -1) {
      renderFilterChips();
    }
    if (event.detail.changed.indexOf('filter') !== -1) {
      renderFilterChips();
      fetchPlaces(store.filter).catch((error) => showToast(error.message, 'error'));
    }
  });
  window.addEventListener('hashchange', onHashChange);
  onHashChange();

  async function loadConfig() {
    try {
      const config = await apiFetch('/api/config');
      setState({ config });
      renderPasswordRules(config.password);
    } catch (error) {
      showToast('Could not load app configuration.', 'error');
    }
  }

  async function handleVerifyLink() {
    const token = new URLSearchParams(window.location.search).get('verify');
    if (!token) {
      return false;
    }

    window.history.replaceState(null, '', window.location.pathname + window.location.hash);

    try {
      await apiFetch('/api/verify-email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token })
      });
      showToast('Your email is verified. You can sign in now.');
      go('#/login');
    } catch (error) {
      showToast(error.message, 'error');
      go(error.status === 410 ? '#/verify' : '#/login');
    }
    return true;
  }

  async function boot() {
    await loadConfig();
    const cameFromEmail = await handleVerifyLink();
    if (!cameFromEmail && store.route.view === 'splash') {
      go(store.token ? '#/map' : '#/login');
    }
  }

  boot();

  window.wanderer = {
    store,
    setState,
    apiFetch,
    authedFetch,
    authedSendJSON,
    go,
    registerGuard,
    confirmAction,
    showToast
  };

})();
