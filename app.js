/**
 * TORNEO MESBG — MOTOR DE GESTIÓN DE TORNEOS
 */

(function () {
  const STORAGE_KEY = 'mesbg_torneo_state_v2';
  const ROOMS_REGISTRY_KEY = 'mesbg_rooms_registry_v1';
  const OWNED_ROOMS_KEY = 'mesbg_owned_rooms_v1';
  const RECENT_ROOMS_KEY = 'mesbg_recent_rooms_v1';
  const VOTER_IDENTITY_KEY = 'mesbg_voter_identity_v1';
  const DEVICE_ID_KEY = 'mesbg_device_id_v1';
  const FIREBASE_URL_STORAGE_KEY = 'mesbg_firebase_db_url';
  const ADMIN_SESSION_KEY = 'mesbg_admin_unlocked';
  const RESERVED_PROTO_KEYS = new Set([
    '__proto__',
    'prototype',
    'constructor',
    'toString',
    'valueOf',
    'hasOwnProperty'
  ]);

  // Estado central de la aplicación
  let state = buildCleanInitialState();
  let isAdminMode = false;
  let searchFilterQuery = '';
  let cloudEventSource = null;
  let votesEventSource = null;
  let registrationsEventSource = null;
  let cloudPollTimer = null;
  let isApplyingRemoteUpdate = false;
  let timerIntervalId = null;
  let lastAutoPromptedRegRoom = '';
  const warned15MinByRound = {};
  const warnedExpiredByRound = {};

  function getMyDeviceId() {
    try {
      let id = localStorage.getItem(DEVICE_ID_KEY);
      if (!id || id.length < 8) {
        id =
          typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
            ? crypto.randomUUID()
            : 'dev_' + Math.random().toString(36).slice(2) + '_' + Date.now().toString(36);
        localStorage.setItem(DEVICE_ID_KEY, id);
      }
      return id;
    } catch (e) {
      return 'dev_fallback';
    }
  }

  function sanitizeTextField(raw, maxLen = 44) {
    return String(raw || '')
      .replace(/[\u0000-\u001F\u007F<>]/g, '')
      .trim()
      .slice(0, maxLen);
  }

  function sanitizeFirebaseKey(raw) {
    const clean = sanitizeTextField(raw, 44).replace(/[.#$/[\]\s]+/g, '_');
    if (!clean) return '';
    if (RESERVED_PROTO_KEYS.has(clean) || RESERVED_PROTO_KEYS.has(clean.toLowerCase())) {
      return `player_${clean}`;
    }
    return clean;
  }

  function getMyPlayerIdentity(roomCode) {
    const code = String(roomCode || state.roomCode || '').trim().toUpperCase();
    if (!code) return { key: '', name: '', army: '', isSpectator: false };
    try {
      const key = localStorage.getItem(`${VOTER_IDENTITY_KEY}_${code}`) || '';
      const name = localStorage.getItem(`${VOTER_IDENTITY_KEY}_NAME_${code}`) || '';
      const army = localStorage.getItem(`${VOTER_IDENTITY_KEY}_ARMY_${code}`) || '';
      if (key === '__SPECTATOR__') {
        return { key: '__SPECTATOR__', name: '', army: '', isSpectator: true };
      }
      const resolvedName =
        name ||
        (key && state.registrations && state.registrations[key] && state.registrations[key].name) ||
        (state.players || []).find((p) => sanitizeFirebaseKey(p) === key) ||
        '';
      const resolvedArmy =
        army ||
        (resolvedName && state.playerArmies && state.playerArmies[resolvedName]) ||
        (key && state.registrations && state.registrations[key] && state.registrations[key].army) ||
        '';
      return {
        key: resolvedName ? sanitizeFirebaseKey(resolvedName) : key,
        name: resolvedName,
        army: resolvedArmy,
        isSpectator: false
      };
    } catch (e) {
      return { key: '', name: '', army: '', isSpectator: false };
    }
  }

  function setMyPlayerIdentity(roomCode, name, army, isSpectator = false) {
    const code = String(roomCode || state.roomCode || '').trim().toUpperCase();
    if (!code) return;
    try {
      if (isSpectator) {
        localStorage.setItem(`${VOTER_IDENTITY_KEY}_${code}`, '__SPECTATOR__');
        localStorage.removeItem(`${VOTER_IDENTITY_KEY}_NAME_${code}`);
        localStorage.removeItem(`${VOTER_IDENTITY_KEY}_ARMY_${code}`);
      } else {
        const cleanName = String(name || '').trim();
        const cleanArmy = String(army || '').trim();
        const key = sanitizeFirebaseKey(cleanName);
        localStorage.setItem(`${VOTER_IDENTITY_KEY}_${code}`, key);
        localStorage.setItem(`${VOTER_IDENTITY_KEY}_NAME_${code}`, cleanName);
        localStorage.setItem(`${VOTER_IDENTITY_KEY}_ARMY_${code}`, cleanArmy);
      }
    } catch (e) {
      // Ignorar
    }
    updatePlayerIdentityPillUI();
  }

  let lastNotifiedSeatingKey = '';

  function isPlayerInEntity(entityName, playerName) {
    const eLower = String(entityName || '').trim().toLowerCase();
    const pLower = String(playerName || '').trim().toLowerCase();
    if (!eLower || !pLower || eLower === 'bye') return false;
    if (eLower === pLower) return true;
    const parts = eLower
      .split(/\s*[()&+/]\s*|\s+y\s+/i)
      .map((s) => s.trim())
      .filter(Boolean);
    return parts.includes(pLower);
  }

  function isPlayerInMatch(match, playerName) {
    if (!match || !playerName) return false;
    return isPlayerInEntity(match.p1?.name, playerName) || isPlayerInEntity(match.p2?.name, playerName);
  }

  function isEntityDropped(entityName) {
    if (!entityName || entityName === 'BYE') return false;
    const clean = String(entityName).trim();
    if (state.droppedPlayers && state.droppedPlayers[clean]) return true;
    const regKey = sanitizeFirebaseKey(clean);
    if (state.registrations && state.registrations[regKey] && state.registrations[regKey].dropped) {
      return true;
    }
    if (state.mode === 'pairs' && state.registrations && typeof state.registrations === 'object') {
      const anyPartDropped = Object.values(state.registrations).some(
        (r) => r && r.dropped && r.name && isPlayerInEntity(clean, r.name)
      );
      if (anyPartDropped) return true;
    }
    return false;
  }

  function getEntityArmy(entityName) {
    if (!entityName || entityName === 'BYE') return '';
    if (state.playerArmies && state.playerArmies[entityName]) {
      return String(state.playerArmies[entityName]).trim();
    }
    if (state.registrations && typeof state.registrations === 'object') {
      const key = sanitizeFirebaseKey(entityName);
      if (state.registrations[key] && state.registrations[key].army) {
        return String(state.registrations[key].army).trim();
      }
      const found = Object.values(state.registrations).find(
        (r) => r && r.name && r.name.toLowerCase() === String(entityName).toLowerCase()
      );
      if (found && found.army) return String(found.army).trim();
    }
    return '';
  }

  function syncUrlWithRoomCode(roomCode) {
    if (!roomCode) return;
    try {
      const cleanCode = String(roomCode).trim().toUpperCase();
      const url = new URL(window.location.href);
      if (url.searchParams.get('code') !== cleanCode) {
        url.searchParams.set('code', cleanCode);
        window.history.replaceState({}, '', `${url.pathname}?${url.searchParams.toString()}`);
      }
    } catch (e) {
      // Ignorar
    }
  }

  // =========================================================================
  // 1. INICIALIZACIÓN, CÓDIGO COMPANION Y PERSISTENCIA DEL ESTADO
  // =========================================================================

  function generateRoomCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    for (let i = 0; i < 6; i++) {
      code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return code;
  }

  function getOwnedRooms() {
    try {
      const list = JSON.parse(localStorage.getItem(OWNED_ROOMS_KEY) || '[]');
      return Array.isArray(list) ? list : [];
    } catch (e) {
      return [];
    }
  }

  function markRoomAsOwned(roomCode) {
    if (!roomCode) return;
    try {
      const list = getOwnedRooms();
      if (!list.includes(roomCode)) {
        list.push(roomCode);
        localStorage.setItem(OWNED_ROOMS_KEY, JSON.stringify(list));
      }
    } catch (e) {
      // Ignorar
    }
  }

  function isRoomOwnedByMe(roomCode) {
    if (!roomCode) return false;
    return getOwnedRooms().includes(roomCode);
  }

  function getRecentRooms() {
    try {
      const list = JSON.parse(localStorage.getItem(RECENT_ROOMS_KEY) || '[]');
      return Array.isArray(list) ? list : [];
    } catch (e) {
      return [];
    }
  }

  function addOrUpdateRecentRoom(tournamentState) {
    if (!tournamentState || !tournamentState.roomCode) return;
    try {
      const code = tournamentState.roomCode.toUpperCase();
      const name = tournamentState.tournamentName || 'Torneo MESBG';
      const finished = !!tournamentState.tournamentFinished;
      let list = getRecentRooms().filter((item) => item && item.code !== code);
      list.unshift({
        code,
        name,
        finished,
        updatedAt: Date.now()
      });
      if (list.length > 6) {
        list = list.slice(0, 6);
      }
      localStorage.setItem(RECENT_ROOMS_KEY, JSON.stringify(list));
    } catch (e) {
      // Ignorar
    }
  }

  function removeRecentRoom(code) {
    if (!code) return;
    try {
      const clean = code.toUpperCase();
      const list = getRecentRooms().filter((item) => item && item.code !== clean);
      localStorage.setItem(RECENT_ROOMS_KEY, JSON.stringify(list));
    } catch (e) {
      // Ignorar
    }
  }

  function isValidTournamentPayload(data) {
    return Boolean(
      data &&
      typeof data === 'object' &&
      typeof data.roomCode === 'string' &&
      data.roomCode.trim().length >= 4 &&
      typeof data.tournamentName === 'string' &&
      !('voter' in data) &&
      !('paintVote' in data)
    );
  }

  function normalizeState(s, fallbackRoomCode) {
    const fixedCode = (
      (s && typeof s.roomCode === 'string' && s.roomCode.trim()) ||
      fallbackRoomCode ||
      (state && state.roomCode) ||
      generateRoomCode()
    ).toUpperCase();

    if (!s || typeof s !== 'object') return buildCleanInitialState(fixedCode);
    s.roomCode = fixedCode;
    s.tournamentName = s.tournamentName || 'Torneo MESBG';
    s.mode = s.mode || 'individual';
    s.scoringSystem = s.scoringSystem || 'expanded';
    s.totalRounds = Math.max(1, Number(s.totalRounds) || 4);
    s.totalTables = Math.max(1, Number(s.totalTables) || 6);
    s.teamCount = Math.max(2, Number(s.teamCount) || 4);
    s.membersPerTeam = Math.max(2, Number(s.membersPerTeam) || 4);
    s.tablesPerTeam = Math.max(1, Number(s.tablesPerTeam) || 4);
    s.activeRound = Math.max(1, Number(s.activeRound) || 1);
    s.tournamentFinished = !!s.tournamentFinished;
    s.registrationOpen = s.registrationOpen !== undefined ? !!s.registrationOpen : true;
    s.votingPaintOpen = !!s.votingPaintOpen;
    s.votingFairPlayOpen = !!s.votingFairPlayOpen;
    s.votes = s.votes && typeof s.votes === 'object' ? s.votes : {};
    s.playerArmies = s.playerArmies && typeof s.playerArmies === 'object' ? s.playerArmies : {};
    s.droppedPlayers = s.droppedPlayers && typeof s.droppedPlayers === 'object' ? s.droppedPlayers : {};
    s.registrations = s.registrations && typeof s.registrations === 'object' ? s.registrations : {};
    s.removedRegistrationKeys = Array.isArray(s.removedRegistrationKeys) ? s.removedRegistrationKeys : [];
    s.players = Array.isArray(s.players) ? s.players : [];
    s.teams = Array.isArray(s.teams)
      ? s.teams.map((t, i) => ({
          name: t && t.name ? t.name : `Equipo_${i + 1}`,
          members: Array.isArray(t && t.members) ? t.members : []
        }))
      : createDefaultTeams(s.teamCount, s.membersPerTeam);
    s.tableGroups = Array.isArray(s.tableGroups)
      ? s.tableGroups.map((g, i) => ({
          name: g && g.name ? g.name : `Grupo_${i + 1}`,
          tables: Array.isArray(g && g.tables) ? g.tables : []
        }))
      : createTableGroups(s.totalTables, s.tablesPerTeam);

    if (!Array.isArray(s.rounds)) {
      s.rounds = [];
    }
    for (let r = 1; r <= s.totalRounds; r++) {
      let rObj = s.rounds.find((x) => x && Number(x.round) === r);
      if (!rObj) {
        rObj = {
          round: r,
          paired: false,
          finished: false,
          podiumUpdated: false,
          teamClashes: [],
          matches: [],
          timer: {
            durationMinutes: 90,
            remainingMs: 90 * 60 * 1000,
            endTime: null,
            running: false
          }
        };
        s.rounds.push(rObj);
      } else {
        rObj.matches = Array.isArray(rObj.matches) ? rObj.matches : [];
        rObj.teamClashes = Array.isArray(rObj.teamClashes) ? rObj.teamClashes : [];
        if (!rObj.timer || typeof rObj.timer !== 'object') {
          rObj.timer = {
            durationMinutes: 90,
            remainingMs: 90 * 60 * 1000,
            endTime: null,
            running: false
          };
        } else {
          rObj.timer.durationMinutes = Math.max(1, Number(rObj.timer.durationMinutes) || 90);
          rObj.timer.remainingMs =
            typeof rObj.timer.remainingMs === 'number'
              ? Math.max(0, rObj.timer.remainingMs)
              : rObj.timer.durationMinutes * 60 * 1000;
          rObj.timer.running = !!rObj.timer.running;
          rObj.timer.endTime = rObj.timer.running ? Number(rObj.timer.endTime) || null : null;
        }
      }
    }
    s.rounds.sort((a, b) => Number(a.round) - Number(b.round));
    return s;
  }

  function ensureConsistency() {
    state = normalizeState(state);
  }

  function saveRoomToLocalRegistry(tournamentState) {
    if (!tournamentState || !tournamentState.roomCode) return;
    try {
      const reg = JSON.parse(localStorage.getItem(ROOMS_REGISTRY_KEY) || '{}');
      reg[tournamentState.roomCode] = tournamentState;
      localStorage.setItem(ROOMS_REGISTRY_KEY, JSON.stringify(reg));
      addOrUpdateRecentRoom(tournamentState);
    } catch (e) {
      console.warn('No se pudo actualizar registro local de salas:', e);
    }
  }

  function getRoomFromLocalRegistry(roomCode) {
    if (!roomCode) return null;
    try {
      const reg = JSON.parse(localStorage.getItem(ROOMS_REGISTRY_KEY) || '{}');
      return reg[roomCode.toUpperCase()] || null;
    } catch (e) {
      return null;
    }
  }

  function buildCleanInitialState(customRoomCode) {
    const totalRounds = 4;
    const totalTables = 6;
    const teamCount = 4;
    const membersPerTeam = 4;
    const tablesPerTeam = 4;
    const roomCode = (customRoomCode || generateRoomCode()).toUpperCase();

    const rounds = [];
    for (let r = 1; r <= totalRounds; r++) {
      rounds.push({
        round: r,
        paired: false,
        finished: false,
        podiumUpdated: false,
        teamClashes: [],
        matches: [],
        timer: {
          durationMinutes: 90,
          remainingMs: 90 * 60 * 1000,
          endTime: null,
          running: false
        }
      });
    }

    return {
      roomCode,
      tournamentName: 'Torneo MESBG',
      mode: 'individual', // 'individual' | 'pairs' | 'teams'
      scoringSystem: 'expanded', // 'expanded' (5/4/2/1/0/-1) | 'classic' (3/1/0)
      totalRounds,
      totalTables,
      teamCount,
      membersPerTeam,
      tablesPerTeam,
      activeRound: 1,
      tournamentFinished: false,
      registrationOpen: true,
      votingPaintOpen: false,
      votingFairPlayOpen: false,
      votes: {},
      playerArmies: {},
      droppedPlayers: {},
      registrations: {},
      removedRegistrationKeys: [],
      players: [],
      teams: createDefaultTeams(teamCount, membersPerTeam),
      tableGroups: createTableGroups(16, tablesPerTeam),
      rounds,
      updatedAt: Date.now()
    };
  }

  function createDefaultTeams(teamCount, membersPerTeam) {
    const sampleNames = [
      'Montaraces_del_Norte',
      'Guardia_de_Gondor',
      'Jinetes_de_Rohan',
      'Huestes_de_Mordor',
      'Elfos_de_Rivendel',
      'Enanos_de_Erebor'
    ];
    const teams = [];
    for (let i = 0; i < teamCount; i++) {
      const tName = sampleNames[i] || `Equipo_${i + 1}`;
      const members = [];
      for (let j = 1; j <= membersPerTeam; j++) {
        members.push(`${tName.split('_')[0]}_Jugador_${j}`);
      }
      teams.push({ name: tName, members });
    }
    return teams;
  }

  function createTableGroups(totalTables, tablesPerTeam) {
    const groups = [];
    for (let i = 1; i <= totalTables; i += tablesPerTeam) {
      const end = Math.min(i + tablesPerTeam - 1, totalTables);
      const gName = `Mesas_${i}_a_${end}`;
      const tables = [];
      for (let t = i; t <= end; t++) {
        tables.push(`Mesa ${t}`);
      }
      groups.push({ name: gName, tables });
    }
    return groups;
  }

  function saveState() {
    if (!state.roomCode) {
      state.roomCode = generateRoomCode();
    }
    state.updatedAt = Date.now();
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      saveRoomToLocalRegistry(state);
    } catch (e) {
      console.warn('No se pudo guardar en localStorage:', e);
    }
    if (isAdminMode && !isApplyingRemoteUpdate) {
      pushStateToCloud();
    }
  }

  function loadState() {
    let urlCodeParam = '';
    try {
      const params = new URLSearchParams(window.location.search);
      const dbParam = params.get('db');
      if (dbParam && dbParam.startsWith('https://')) {
        localStorage.setItem(FIREBASE_URL_STORAGE_KEY, dbParam.replace(/\/+$/, ''));
      }
      const codeParam = params.get('code');
      if (codeParam && codeParam.trim()) {
        urlCodeParam = codeParam.trim().toUpperCase();
      }
    } catch (e) {
      // Ignorar
    }

    // Si el usuario entra mediante un link con ?code=XXXXXX
    if (urlCodeParam) {
      const localMatch = getRoomFromLocalRegistry(urlCodeParam);
      if (localMatch && typeof localMatch === 'object' && isValidTournamentPayload(localMatch)) {
        state = normalizeState(localMatch, urlCodeParam);
      } else {
        state = buildCleanInitialState(urlCodeParam);
        state.updatedAt = 0; // Para que pullStateFromCloud tome siempre los datos reales de Firebase
      }
      isAdminMode = isRoomOwnedByMe(urlCodeParam);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      syncUrlWithRoomCode(state.roomCode);
      return;
    }

    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object' && isValidTournamentPayload(parsed)) {
          if (!parsed.roomCode) {
            parsed.roomCode = generateRoomCode();
            markRoomAsOwned(parsed.roomCode);
          }
          state = normalizeState(parsed, parsed.roomCode);
          saveRoomToLocalRegistry(state);
          // Si este navegador no tiene ninguna sala propia aún y no entró con ?code, es dueño de su sala inicial
          if (getOwnedRooms().length === 0) {
            markRoomAsOwned(state.roomCode);
          }
          isAdminMode = isRoomOwnedByMe(state.roomCode);
          syncUrlWithRoomCode(state.roomCode);
          return;
        }
      }
    } catch (e) {
      console.warn('Error leyendo localStorage:', e);
    }

    state = buildCleanInitialState();
    markRoomAsOwned(state.roomCode);
    isAdminMode = true;
    syncUrlWithRoomCode(state.roomCode);
    saveState();
  }

  // =========================================================================
  // 1B. SINCRONIZACIÓN EN TIEMPO REAL POR CÓDIGO DE SALA (COMPANION + FIREBASE)
  // =========================================================================

  const DEFAULT_FIREBASE_DB_URL = 'https://torneomesbg-default-rtdb.firebaseio.com';
  let isPushingToCloud = false;
  let pendingPushRequested = false;
  let sseReconnectTimer = null;

  function getFirebaseDbUrl() {
    const fromConfig =
      window.MESBG_CLOUD_CONFIG && window.MESBG_CLOUD_CONFIG.FIREBASE_DB_URL
        ? window.MESBG_CLOUD_CONFIG.FIREBASE_DB_URL.trim()
        : '';
    const fromLocal = (localStorage.getItem(FIREBASE_URL_STORAGE_KEY) || '').trim();
    const candidate = (fromConfig || fromLocal || DEFAULT_FIREBASE_DB_URL).replace(/\/+$/, '');
    if (candidate.startsWith('https://') && (candidate.includes('firebaseio.com') || candidate.includes('firebasedatabase.app'))) {
      return candidate;
    }
    return DEFAULT_FIREBASE_DB_URL;
  }

  function getRoomCloudEndpoint(roomCode) {
    const dbUrl = getFirebaseDbUrl();
    const code = (roomCode || state.roomCode || 'DEFAULT').toUpperCase();
    if (!dbUrl) return '';
    return `${dbUrl}/torneos/${code}.json`;
  }

  function getRoomVotesEndpoint(roomCode) {
    const dbUrl = getFirebaseDbUrl();
    const code = (roomCode || state.roomCode || 'DEFAULT').toUpperCase();
    if (!dbUrl) return '';
    return `${dbUrl}/votos_torneos/${code}.json`;
  }

  function getRoomRegistrationsEndpoint(roomCode) {
    const dbUrl = getFirebaseDbUrl();
    const code = (roomCode || state.roomCode || 'DEFAULT').toUpperCase();
    if (!dbUrl) return '';
    return `${dbUrl}/inscripciones_torneos/${code}.json`;
  }

  function getAdminPin() {
    return (window.MESBG_CLOUD_CONFIG && window.MESBG_CLOUD_CONFIG.ADMIN_PIN) || 'deazul2026';
  }

  function updateLiveSyncBadge(statusText, isOnline) {
    const badge = document.getElementById('liveSyncBadge');
    if (!badge) return;
    if (isOnline && state && state.tournamentFinished && statusText.startsWith('🟢')) {
      badge.textContent = `🔒 ${state.roomCode} • CERRADO`;
    } else {
      badge.textContent = statusText;
    }
    badge.classList.toggle('online', !!isOnline);
  }

  function updatePlayerIdentityPillUI() {
    const pill = document.getElementById('btnPlayerIdentityPill');
    if (!pill) return;
    const myId = getMyPlayerIdentity(state.roomCode);
    if (myId.name) {
      const armySuffix = myId.army ? ` • ${myId.army}` : '';
      pill.textContent = `🪖 ${myId.name}${armySuffix}`;
      pill.classList.add('is-identified');
    } else if (state && state.tournamentFinished) {
      pill.textContent = '🔒 Torneo Cerrado';
      pill.classList.remove('is-identified');
    } else if (myId.isSpectator) {
      pill.textContent = '👁️ Espectador (Inscribirme)';
      pill.classList.remove('is-identified');
    } else {
      pill.textContent = '🪖 Inscribirme';
      pill.classList.remove('is-identified');
    }
  }

  function maybePromptPlayerRegistration() {
    updatePlayerIdentityPillUI();
    if (isAdminMode) return;
    if (state && state.tournamentFinished) return;
    const code = String(state.roomCode || '').trim().toUpperCase();
    if (!code || code.length < 4) return;

    const myId = getMyPlayerIdentity(code);
    if (myId.name || myId.isSpectator) return;

    if (lastAutoPromptedRegRoom === code) return;
    const modalEl = document.getElementById('elvenModal');
    if (modalEl && !modalEl.classList.contains('hidden')) return;

    lastAutoPromptedRegRoom = code;
    openPlayerRegistrationModal();
  }

  let isJoiningRoom = false;

  async function fetchWithTimeout(url, options = {}, timeoutMs = 8000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(url, {
        ...options,
        cache: 'no-store',
        signal: controller.signal
      });
    } finally {
      clearTimeout(timer);
    }
  }

  async function fetchWithRetry(url, options = {}, timeoutMs = 8000, maxRetries = 2) {
    let lastErr = null;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const res = await fetchWithTimeout(url, options, timeoutMs);
        if (res.ok || (res.status >= 400 && res.status < 500)) {
          return res;
        }
        lastErr = new Error(`HTTP ${res.status}`);
      } catch (err) {
        lastErr = err;
      }
      if (attempt < maxRetries) {
        await new Promise((r) => setTimeout(r, 600 * (attempt + 1)));
      }
    }
    throw lastErr || new Error('Network error');
  }

  function isUserTypingInElement(containerId) {
    const active = document.activeElement;
    if (!active) return false;
    const tag = (active.tagName || '').toUpperCase();
    if (tag !== 'INPUT' && tag !== 'TEXTAREA' && tag !== 'SELECT') return false;
    if (!containerId) return true;
    const container = document.getElementById(containerId);
    return Boolean(container && container.contains(active));
  }

  function hasTournamentMeaningfulData(tState) {
    if (!tState || typeof tState !== 'object') return false;
    if (Array.isArray(tState.players) && tState.players.length > 0) return true;
    if (tState.registrations && Object.keys(tState.registrations).length > 0) return true;
    if (tState.mode === 'teams' && Array.isArray(tState.teams) && tState.teams.length > 0) return true;
    if (
      Array.isArray(tState.rounds) &&
      tState.rounds.some(
        (r) =>
          (Array.isArray(r.matches) && r.matches.length > 0) ||
          (Array.isArray(r.teamClashes) && r.teamClashes.length > 0)
      )
    ) {
      return true;
    }
    return false;
  }

  async function pushStateToCloud() {
    const endpoint = getRoomCloudEndpoint(state.roomCode);
    if (!endpoint) return;

    if (isPushingToCloud) {
      pendingPushRequested = true;
      return;
    }

    isPushingToCloud = true;
    try {
      do {
        pendingPushRequested = false;
        const currentEndpoint = getRoomCloudEndpoint(state.roomCode);
        if (!currentEndpoint) break;

        updateLiveSyncBadge(`🔄 ${state.roomCode}`, true);
        // Guardar el estado del torneo en /torneos/{code} sin duplicar /votos_torneos ni /inscripciones_torneos
        const payloadToPush = { ...state };
        delete payloadToPush.votes;
        delete payloadToPush.registrations;

        const res = await fetchWithRetry(currentEndpoint, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payloadToPush)
        });
        if (res.ok) {
          updateLiveSyncBadge(`🟢 ${state.roomCode}`, true);
        } else {
          updateLiveSyncBadge('⚠️ ERROR NUBE', false);
        }
      } while (pendingPushRequested);
    } catch (err) {
      console.warn('Error al sincronizar con Firebase:', err);
      updateLiveSyncBadge('⚠️ SIN CONEXIÓN', false);
    } finally {
      isPushingToCloud = false;
    }
  }

  async function submitPlayerRegistrationToCloud(playerName, playerArmy, explicitRoomCode) {
    if (state && state.tournamentFinished) return false;
    const code = String(explicitRoomCode || state.roomCode || '').trim().toUpperCase();
    const cleanName = sanitizeTextField(playerName, 40);
    const cleanArmy = sanitizeTextField(playerArmy, 50);
    if (!code || code.length < 4 || !cleanName) return false;

    const regKey = sanitizeFirebaseKey(cleanName);
    if (!regKey) return false;

    const myDevId = getMyDeviceId();
    const existingReg = state.registrations && state.registrations[regKey];
    if (
      !isAdminMode &&
      existingReg &&
      existingReg.deviceId &&
      existingReg.deviceId !== myDevId
    ) {
      return false;
    }

    const regObj = {
      name: cleanName,
      army: cleanArmy,
      deviceId: existingReg && existingReg.deviceId ? existingReg.deviceId : myDevId,
      joinedAt: existingReg && existingReg.joinedAt ? existingReg.joinedAt : Date.now(),
      dropped: !!(existingReg && existingReg.dropped),
      droppedAtRound: existingReg && existingReg.droppedAtRound ? existingReg.droppedAtRound : null,
      matchReports:
        existingReg && existingReg.matchReports && typeof existingReg.matchReports === 'object'
          ? existingReg.matchReports
          : {}
    };

    if (!state.registrations || typeof state.registrations !== 'object') {
      state.registrations = {};
    }
    if (!state.playerArmies || typeof state.playerArmies !== 'object') {
      state.playerArmies = {};
    }
    if (Array.isArray(state.removedRegistrationKeys)) {
      state.removedRegistrationKeys = state.removedRegistrationKeys.filter((k) => k !== regKey);
    }

    state.registrations[regKey] = regObj;
    if (cleanArmy) {
      state.playerArmies[cleanName] = cleanArmy;
    }

    if (
      state.mode === 'individual' &&
      !state.players.some((p) => String(p).toLowerCase() === cleanName.toLowerCase())
    ) {
      state.players.push(cleanName);
      state.totalTables = Math.max(state.totalTables, Math.ceil(state.players.length / 2));
    }

    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      saveRoomToLocalRegistry(state);
    } catch (e) {
      // Ignorar
    }

    const dbUrl = getFirebaseDbUrl();
    if (!dbUrl) return true;
    const regEndpoint = `${dbUrl}/inscripciones_torneos/${code}/${encodeURIComponent(regKey)}.json`;
    try {
      const res = await fetchWithRetry(regEndpoint, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(regObj)
      });
      if (!res.ok) return false;
      if (isAdminMode) {
        saveState();
      }
      return true;
    } catch (err) {
      console.warn('Error al guardar inscripción en Firebase:', err);
      updateLiveSyncBadge('⚠️ SIN CONEXIÓN', false);
      return false;
    }
  }

  async function submitPlayerDropStatusToCloud(playerName, isDropped, explicitRoomCode) {
    if (state && state.tournamentFinished) return false;
    const code = String(explicitRoomCode || state.roomCode || '').trim().toUpperCase();
    const cleanName = sanitizeTextField(playerName, 40);
    if (!code || !cleanName) return false;

    const regKey = sanitizeFirebaseKey(cleanName);
    if (!regKey) return false;

    if (!state.registrations || typeof state.registrations !== 'object') {
      state.registrations = {};
    }
    if (!state.droppedPlayers || typeof state.droppedPlayers !== 'object') {
      state.droppedPlayers = {};
    }

    const existingReg = state.registrations[regKey] || {};
    const regObj = {
      name: cleanName,
      army: existingReg.army || getEntityArmy(cleanName) || '',
      deviceId: existingReg.deviceId || getMyDeviceId(),
      joinedAt: Number(existingReg.joinedAt) || Date.now(),
      dropped: !!isDropped,
      droppedAtRound: isDropped ? state.activeRound : null,
      droppedAt: Date.now(),
      matchReports:
        existingReg.matchReports && typeof existingReg.matchReports === 'object'
          ? existingReg.matchReports
          : {}
    };

    state.registrations[regKey] = regObj;
    state.droppedPlayers[cleanName] = !!isDropped;

    const dbUrl = getFirebaseDbUrl();
    if (!dbUrl) return true;
    const regEndpoint = `${dbUrl}/inscripciones_torneos/${code}/${encodeURIComponent(regKey)}.json`;
    try {
      const res = await fetchWithRetry(regEndpoint, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(regObj)
      });
      if (!res.ok) return false;
      if (isAdminMode) {
        saveState();
      }
      return true;
    } catch (err) {
      console.warn('Error al actualizar estado Drop en Firebase:', err);
      return false;
    }
  }

  async function submitPlayerMatchReportToCloud(roundNum, matchIdx, p1Vp, p2Vp, p1Surrender, p2Surrender) {
    if (state && state.tournamentFinished) return false;
    const code = String(state.roomCode || '').trim().toUpperCase();
    const rObj = (state.rounds || []).find((r) => Number(r.round) === Number(roundNum));
    if (!rObj || rObj.finished || !rObj.matches || !rObj.matches[matchIdx]) return false;

    const match = rObj.matches[matchIdx];
    const myId = getMyPlayerIdentity(code);
    const reporterName = sanitizeTextField(myId.name || (isAdminMode ? 'Organizador' : ''), 40);
    if (!reporterName) return false;
    if (!isAdminMode && !isPlayerInMatch(match, reporterName)) return false;

    const now = Date.now();
    const cleanP1Vp = Math.max(0, Math.min(100, Number(p1Vp) || 0));
    const cleanP2Vp = Math.max(0, Math.min(100, Number(p2Vp) || 0));

    match.p1.vp = cleanP1Vp;
    match.p2.vp = cleanP2Vp;
    match.p1.surrender = !!p1Surrender;
    match.p2.surrender = !!p2Surrender;
    match.p1.manualTp = false;
    match.p2.manualTp = false;
    recalculateMatch(match, match.p1.surrender || match.p2.surrender ? 'forfeit' : 'vp');
    match.reportedBy = reporterName;
    match.lastAppliedReportAt = now;

    if (isAdminMode) {
      saveState();
      return true;
    }

    const regKey = sanitizeFirebaseKey(reporterName);
    if (!state.registrations || typeof state.registrations !== 'object') {
      state.registrations = {};
    }
    const existingReg = state.registrations[regKey] || {};
    const matchReports =
      existingReg.matchReports && typeof existingReg.matchReports === 'object'
        ? { ...existingReg.matchReports }
        : {};

    const reportKey = `R${roundNum}_M${matchIdx}`;
    matchReports[reportKey] = {
      round: Number(roundNum),
      matchIdx: Number(matchIdx),
      table: String(match.table || ''),
      p1Name: String(match.p1.name || ''),
      p2Name: String(match.p2.name || ''),
      p1Vp: cleanP1Vp,
      p2Vp: cleanP2Vp,
      p1Surrender: !!p1Surrender,
      p2Surrender: !!p2Surrender,
      reportedBy: reporterName,
      reportedAt: now
    };

    const regObj = {
      name: reporterName,
      army: existingReg.army || myId.army || getEntityArmy(reporterName) || '',
      deviceId: existingReg.deviceId || getMyDeviceId(),
      joinedAt: Number(existingReg.joinedAt) || now,
      dropped: !!existingReg.dropped,
      droppedAtRound: existingReg.droppedAtRound || null,
      matchReports
    };

    state.registrations[regKey] = regObj;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      saveRoomToLocalRegistry(state);
    } catch (e) {
      // Ignorar
    }

    const dbUrl = getFirebaseDbUrl();
    if (!dbUrl) return true;
    const regEndpoint = `${dbUrl}/inscripciones_torneos/${code}/${encodeURIComponent(regKey)}.json`;
    try {
      const res = await fetchWithRetry(regEndpoint, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(regObj)
      });
      return res.ok;
    } catch (err) {
      console.warn('Error al enviar reporte de mesa a Firebase:', err);
      updateLiveSyncBadge('⚠️ SIN CONEXIÓN', false);
      return false;
    }
  }

  async function deletePlayerRegistrationFromCloud(playerName, explicitRoomCode) {
    const code = String(explicitRoomCode || state.roomCode || '').trim().toUpperCase();
    const cleanName = sanitizeTextField(playerName, 40);
    const regKey = sanitizeFirebaseKey(cleanName);
    if (!code || !regKey) return;

    if (state.registrations && state.registrations[regKey]) {
      delete state.registrations[regKey];
    }
    if (!Array.isArray(state.removedRegistrationKeys)) {
      state.removedRegistrationKeys = [];
    }
    if (!state.removedRegistrationKeys.includes(regKey)) {
      state.removedRegistrationKeys.push(regKey);
    }

    const dbUrl = getFirebaseDbUrl();
    if (!dbUrl) return;
    const regEndpoint = `${dbUrl}/inscripciones_torneos/${code}/${encodeURIComponent(regKey)}.json`;
    try {
      await fetchWithRetry(regEndpoint, { method: 'DELETE' });
    } catch (err) {
      console.warn('Error al eliminar inscripción en Firebase:', err);
    }
  }

  async function pullRegistrationsFromCloud(explicitRoomCode, skipRender = false) {
    const code = String(explicitRoomCode || state.roomCode || '').trim().toUpperCase();
    const regEndpoint = getRoomRegistrationsEndpoint(code);
    if (!regEndpoint || !code) return false;

    try {
      const res = await fetchWithTimeout(regEndpoint);
      if (!res.ok) return false;
      const remoteRegs = await res.json();
      if (code !== state.roomCode) return false;

      const cleanRegs =
        remoteRegs && typeof remoteRegs === 'object' && !Array.isArray(remoteRegs) ? remoteRegs : {};
      const removedSet = new Set(Array.isArray(state.removedRegistrationKeys) ? state.removedRegistrationKeys : []);

      let rosterChanged = false;
      if (!state.playerArmies || typeof state.playerArmies !== 'object') {
        state.playerArmies = {};
      }
      if (!state.droppedPlayers || typeof state.droppedPlayers !== 'object') {
        state.droppedPlayers = {};
      }

      const prevRegsJson = JSON.stringify(state.registrations || {});
      const nextRegistrations = {};
      const allIncomingReports = [];

      Object.entries(cleanRegs).forEach(([key, item]) => {
        if (!item || typeof item !== 'object' || removedSet.has(key) || RESERVED_PROTO_KEYS.has(key)) return;
        const pName = sanitizeTextField(item.name, 40);
        const pArmy = sanitizeTextField(item.army, 50);
        if (!pName) return;

        // Si las inscripciones están cerradas, no aceptar altas nuevas externas que no estuvieran ya en la sala
        const wasAlreadyKnown =
          (state.registrations && state.registrations[key]) ||
          (state.players || []).some((p) => isPlayerInEntity(p, pName));
        if (state.registrationOpen === false && !wasAlreadyKnown) {
          return;
        }

        const isDropped = !!item.dropped;
        const prevDropped = !!state.droppedPlayers[pName];
        if (prevDropped !== isDropped) {
          state.droppedPlayers[pName] = isDropped;
          rosterChanged = true;
        }

        const itemReports =
          item.matchReports && typeof item.matchReports === 'object' && !Array.isArray(item.matchReports)
            ? item.matchReports
            : {};

        Object.values(itemReports).forEach((rep) => {
          if (rep && typeof rep === 'object' && Number(rep.reportedAt) > 0) {
            allIncomingReports.push({ ...rep, reporterVerifiedName: pName });
          }
        });

        nextRegistrations[key] = {
          name: pName,
          army: pArmy,
          deviceId: item.deviceId ? String(item.deviceId).slice(0, 64) : '',
          joinedAt: Number(item.joinedAt) || Date.now(),
          dropped: isDropped,
          droppedAtRound: item.droppedAtRound || null,
          matchReports: itemReports
        };
        if (pArmy) {
          state.playerArmies[pName] = pArmy;
        }

        // En modo Individual, si la inscripción está abierta, incorporar automáticamente al jugador a la lista
        if (
          state.mode === 'individual' &&
          state.registrationOpen !== false &&
          !state.players.some((p) => String(p).toLowerCase() === pName.toLowerCase())
        ) {
          state.players.push(pName);
          state.totalTables = Math.max(state.totalTables, Math.ceil(state.players.length / 2));
          rosterChanged = true;
        }
      });

      // Aplicar reportes de resultados enviados por los jugadores desde sus mesas (ordenados cronológicamente)
      if (!state.tournamentFinished && allIncomingReports.length > 0) {
        allIncomingReports.sort((a, b) => Number(a.reportedAt) - Number(b.reportedAt));
        allIncomingReports.forEach((rep) => {
          const rObj = (state.rounds || []).find((r) => Number(r.round) === Number(rep.round));
          if (!rObj || rObj.finished || !Array.isArray(rObj.matches)) return;

          const targetMatch = rObj.matches.find(
            (m, idx) =>
              (rep.p1Name &&
                rep.p2Name &&
                String(m.p1?.name).toLowerCase() === String(rep.p1Name).toLowerCase() &&
                String(m.p2?.name).toLowerCase() === String(rep.p2Name).toLowerCase()) ||
              (typeof rep.matchIdx === 'number' && idx === rep.matchIdx && String(m.table) === String(rep.table))
          );

          if (!targetMatch) return;
          if (!isPlayerInMatch(targetMatch, rep.reporterVerifiedName)) return;

          const repTime = Number(rep.reportedAt || 0);
          const currentMatchTime = Number(targetMatch.lastAppliedReportAt || 0);
          if (repTime > currentMatchTime) {
            targetMatch.p1.vp = Math.max(0, Math.min(100, Number(rep.p1Vp) || 0));
            targetMatch.p2.vp = Math.max(0, Math.min(100, Number(rep.p2Vp) || 0));
            targetMatch.p1.surrender = !!rep.p1Surrender;
            targetMatch.p2.surrender = !!rep.p2Surrender;
            targetMatch.p1.manualTp = false;
            targetMatch.p2.manualTp = false;
            recalculateMatch(
              targetMatch,
              targetMatch.p1.surrender || targetMatch.p2.surrender ? 'forfeit' : 'vp'
            );
            targetMatch.reportedBy = rep.reporterVerifiedName;
            targetMatch.lastAppliedReportAt = repTime;
            rosterChanged = true;
          }
        });
      }

      state.registrations = nextRegistrations;
      const nextRegsJson = JSON.stringify(state.registrations);
      const changed = prevRegsJson !== nextRegsJson || rosterChanged;

      if (changed) {
        if (isAdminMode && rosterChanged) {
          saveState();
        } else {
          localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
          saveRoomToLocalRegistry(state);
        }
        if (!skipRender) {
          renderSidebarStatus();
          if (!isUserTypingInElement('view-setup')) {
            renderSetupView();
          }
          if (!isUserTypingInElement('roundMatchesContainer')) {
            renderRoundsView();
          }
          renderPodiumView();
        }
      }
      updatePlayerIdentityPillUI();
      return changed;
    } catch (e) {
      return false;
    }
  }

  async function submitPlayerVoteToCloud(voterKey, voteObj, explicitRoomCode) {
    if (state && state.tournamentFinished) return false;
    const code = String(explicitRoomCode || state.roomCode || '').trim().toUpperCase();
    if (!code || code.length < 4) return false;

    if (!state.votes || typeof state.votes !== 'object') {
      state.votes = {};
    }
    state.votes[voterKey] = voteObj;

    const dbUrl = getFirebaseDbUrl();
    if (!dbUrl) return true;
    // Guardar en nodo independiente /votos_torneos/{code}/{voterKey} para NUNCA disparar eventos sobre /torneos/{code}
    const voteEndpoint = `${dbUrl}/votos_torneos/${code}/${encodeURIComponent(voterKey)}.json`;
    try {
      const res = await fetchWithRetry(voteEndpoint, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(voteObj)
      });
      return res.ok;
    } catch (err) {
      console.warn('Error al guardar voto en Firebase:', err);
      updateLiveSyncBadge('⚠️ SIN CONEXIÓN', false);
      return false;
    }
  }

  async function pullVotesFromCloud(explicitRoomCode, skipRender = false) {
    const code = String(explicitRoomCode || state.roomCode || '').trim().toUpperCase();
    const votesEndpoint = getRoomVotesEndpoint(code);
    if (!votesEndpoint || !code) return false;

    try {
      const res = await fetchWithTimeout(votesEndpoint);
      if (!res.ok) return false;
      const remoteVotes = await res.json();
      if (code !== state.roomCode) return false;

      const cleanVotes =
        remoteVotes && typeof remoteVotes === 'object' && !Array.isArray(remoteVotes) ? remoteVotes : {};

      if (JSON.stringify(state.votes || {}) !== JSON.stringify(cleanVotes)) {
        state.votes = cleanVotes;
        if (!skipRender) {
          renderSpecialAwardsCards();
        }
        return true;
      }
      return false;
    } catch (e) {
      return false;
    }
  }

  async function pullStateFromCloud() {
    if (isPushingToCloud) return false;

    const currentCode = state.roomCode;
    const endpoint = getRoomCloudEndpoint(currentCode);
    if (!endpoint) {
      updateLiveSyncBadge(`⚪ ${currentCode}`, false);
      return false;
    }

    try {
      const res = await fetchWithTimeout(endpoint);
      if (!res.ok) {
        updateLiveSyncBadge('⚠️ ERROR NUBE', false);
        return false;
      }
      const remoteData = await res.json();
      if (isPushingToCloud || state.roomCode !== currentCode) return false;

      if (isValidTournamentPayload(remoteData) && String(remoteData.roomCode).toUpperCase() === currentCode) {
        const preservedVotes = { ...(state.votes || {}) };
        const preservedRegs = { ...(state.registrations || {}) };
        const preservedArmies = { ...(state.playerArmies || {}), ...(remoteData.playerArmies || {}) };
        const cleanRemote = normalizeState(remoteData, currentCode);
        cleanRemote.roomCode = currentCode;
        cleanRemote.votes = preservedVotes;
        cleanRemote.registrations = preservedRegs;
        cleanRemote.playerArmies = preservedArmies;

        const localTime = Number(state.updatedAt || 0);
        const remoteTime = Number(cleanRemote.updatedAt || 0);

        const localHasData = hasTournamentMeaningfulData(state);
        const remoteHasData = hasTournamentMeaningfulData(cleanRemote);

        // Nunca permitir que un estado remoto vacío sobrescriba un torneo con jugadores/partidas salvo formateo explícito
        const canAcceptRemote = !localHasData || remoteHasData || !!remoteData.explicitReset;
        let stateReplaced = false;

        if (!isAdminMode) {
          if (remoteTime !== localTime && canAcceptRemote) {
            isApplyingRemoteUpdate = true;
            state = cleanRemote;
            stateReplaced = true;
            isApplyingRemoteUpdate = false;
          }
        } else {
          if (remoteTime > localTime && canAcceptRemote) {
            isApplyingRemoteUpdate = true;
            state = cleanRemote;
            stateReplaced = true;
            isApplyingRemoteUpdate = false;
          }
        }

        // Sincronizar inscripciones y votos en paralelo antes de renderizar
        const [regsChanged, votesChanged] = await Promise.all([
          pullRegistrationsFromCloud(currentCode, true),
          pullVotesFromCloud(currentCode, true)
        ]);

        if (stateReplaced || regsChanged) {
          localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
          saveRoomToLocalRegistry(state);
          renderSidebarStatus();
          if (!isUserTypingInElement('view-setup')) {
            renderSetupView();
          }
          if (!isUserTypingInElement('roundMatchesContainer')) {
            renderRoundsView();
          }
          renderPodiumView();
        } else if (votesChanged) {
          renderSpecialAwardsCards();
        }

        maybePromptPlayerRegistration();
        updateLiveSyncBadge(`🟢 ${state.roomCode}`, true);
        return true;
      }

      await Promise.all([
        pullRegistrationsFromCloud(currentCode, false),
        pullVotesFromCloud(currentCode, false)
      ]);

      // Si la sala aún no existe en Firebase y este navegador es el organizador, publicarla automáticamente
      if (isAdminMode && state && Array.isArray(state.rounds)) {
        await pushStateToCloud();
        return true;
      }
      maybePromptPlayerRegistration();
      updateLiveSyncBadge(`🟢 ${state.roomCode}`, true);
      return false;
    } catch (err) {
      console.warn('Error en pullStateFromCloud:', err);
      updateLiveSyncBadge('⚠️ SIN CONEXIÓN', false);
      return false;
    }
  }

  async function joinTournamentByCode(rawCode) {
    if (isJoiningRoom) return;
    const code = (rawCode || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (code.length < 4) {
      showToast('⚠️ Ingresa un código de torneo válido (ej: M8K4R2).');
      return;
    }

    isJoiningRoom = true;
    const btnJoin = document.getElementById('btnJoinRoomCode');
    const inpJoin = document.getElementById('inputJoinRoomCode');
    if (btnJoin) btnJoin.disabled = true;

    try {
      const endpoint = getRoomCloudEndpoint(code);
      if (endpoint) {
        showToast(`🔍 Buscando torneo "${code}" en vivo...`);
        try {
          const res = await fetchWithTimeout(endpoint);
          if (res.ok) {
            const remoteData = await res.json();
            if (isValidTournamentPayload(remoteData)) {
              isApplyingRemoteUpdate = true;
              state = normalizeState(remoteData, code);
              state.roomCode = code;
              isAdminMode = isRoomOwnedByMe(code);
              lastAutoPromptedRegRoom = '';
              syncUrlWithRoomCode(code);
              await Promise.all([
                pullRegistrationsFromCloud(code, true),
                pullVotesFromCloud(code, true)
              ]);
              localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
              saveRoomToLocalRegistry(state);
              if (inpJoin) inpJoin.value = '';
              applyRoleModeUI();
              switchTab(isAdminMode ? 'setup' : 'rounds');
              startCloudRealtimeSync();
              isApplyingRemoteUpdate = false;
              showToast(
                isAdminMode
                  ? `Conectado como Organizador a tu torneo "${state.tournamentName}" (ID: ${code}).`
                  : `Conectado como Jugador al torneo "${state.tournamentName}" (ID: ${code}).`
              );
              maybePromptPlayerRegistration();
              return;
            }
          }
        } catch (e) {
          console.warn('Error buscando sala en Firebase:', e);
        }
      }

      // Buscar en el registro local del navegador (útil en modo local o entre pestañas)
      const localRoom = getRoomFromLocalRegistry(code);
      if (localRoom && typeof localRoom === 'object' && isValidTournamentPayload(localRoom)) {
        isApplyingRemoteUpdate = true;
        state = normalizeState(localRoom, code);
        state.roomCode = code;
        isAdminMode = isRoomOwnedByMe(code);
        lastAutoPromptedRegRoom = '';
        syncUrlWithRoomCode(code);
        localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
        if (inpJoin) inpJoin.value = '';
        applyRoleModeUI();
        switchTab(isAdminMode ? 'setup' : 'rounds');
        startCloudRealtimeSync();
        isApplyingRemoteUpdate = false;
        showToast(
          isAdminMode
            ? `Torneo "${state.tournamentName}" (ID: ${code}) cargado como Organizador.`
            : `Torneo "${state.tournamentName}" (ID: ${code}) cargado como Jugador.`
        );
        maybePromptPlayerRegistration();
        return;
      }

      showToast(`⚠️ No se encontró ningún torneo activo con el código "${code}".`);
    } finally {
      isJoiningRoom = false;
      if (btnJoin) btnJoin.disabled = false;
    }
  }

  function handleSseEvent(ev) {
    if (isPushingToCloud) return;
    try {
      const payload = JSON.parse(ev.data);
      if (!payload || typeof payload !== 'object') return;
      const path = payload.path || '/';
      const data = payload.data;

      // Ignorar cualquier evento parcial; solo procesar raíz '/' con payload de torneo válido para la sala actual
      if (path !== '/' || !isValidTournamentPayload(data)) {
        return;
      }

      const currentCode = state.roomCode;
      if (String(data.roomCode || '').toUpperCase() !== currentCode) {
        return;
      }

      const preservedVotes = { ...(state.votes || {}) };
      const preservedRegs = { ...(state.registrations || {}) };
      const preservedArmies = { ...(state.playerArmies || {}), ...(data.playerArmies || {}) };
      const cleanRemote = normalizeState(data, currentCode);
      cleanRemote.roomCode = currentCode;
      cleanRemote.votes = preservedVotes;
      cleanRemote.registrations = preservedRegs;
      cleanRemote.playerArmies = preservedArmies;

      const remoteTime = Number(cleanRemote.updatedAt || 0);
      const localTime = Number(state.updatedAt || 0);

      const localHasData = hasTournamentMeaningfulData(state);
      const remoteHasData = hasTournamentMeaningfulData(cleanRemote);

      const canAcceptRemote = !localHasData || remoteHasData || !!data.explicitReset;

      if (!isAdminMode) {
        if (remoteTime !== localTime && canAcceptRemote) {
          isApplyingRemoteUpdate = true;
          state = cleanRemote;
          localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
          saveRoomToLocalRegistry(state);
          renderAll();
          isApplyingRemoteUpdate = false;
          maybePromptPlayerRegistration();
        }
      } else {
        if (remoteTime > localTime && canAcceptRemote) {
          isApplyingRemoteUpdate = true;
          state = cleanRemote;
          localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
          saveRoomToLocalRegistry(state);
          renderAll();
          isApplyingRemoteUpdate = false;
        }
      }
      updateLiveSyncBadge(`🟢 ${state.roomCode}`, true);
    } catch (e) {
      // Ignorar errores de parseo SSE
    }
  }

  function scheduleSseRecovery(streamObj) {
    if (sseReconnectTimer) clearTimeout(sseReconnectTimer);
    sseReconnectTimer = setTimeout(() => {
      if (streamObj && streamObj.readyState === EventSource.CLOSED) {
        startCloudRealtimeSync();
      } else {
        pullStateFromCloud();
      }
    }, 3500);
  }

  function startCloudRealtimeSync() {
    if (cloudEventSource) {
      cloudEventSource.close();
      cloudEventSource = null;
    }
    if (votesEventSource) {
      votesEventSource.close();
      votesEventSource = null;
    }
    if (registrationsEventSource) {
      registrationsEventSource.close();
      registrationsEventSource = null;
    }
    if (cloudPollTimer) {
      clearInterval(cloudPollTimer);
      cloudPollTimer = null;
    }
    if (sseReconnectTimer) {
      clearTimeout(sseReconnectTimer);
      sseReconnectTimer = null;
    }

    const endpoint = getRoomCloudEndpoint(state.roomCode);
    const votesEndpoint = getRoomVotesEndpoint(state.roomCode);
    const regsEndpoint = getRoomRegistrationsEndpoint(state.roomCode);
    if (!endpoint) {
      updateLiveSyncBadge(`⚪ ${state.roomCode}`, false);
      return;
    }

    pullStateFromCloud();

    try {
      const sse = new EventSource(endpoint);
      sse.addEventListener('put', handleSseEvent);
      sse.addEventListener('patch', handleSseEvent);
      sse.onerror = () => scheduleSseRecovery(sse);
      cloudEventSource = sse;
    } catch (e) {
      console.warn('SSE no disponible, usando polling:', e);
    }

    if (votesEndpoint) {
      try {
        const vSse = new EventSource(votesEndpoint);
        const onVoteEvent = () => pullVotesFromCloud(state.roomCode);
        vSse.addEventListener('put', onVoteEvent);
        vSse.addEventListener('patch', onVoteEvent);
        vSse.onerror = () => scheduleSseRecovery(vSse);
        votesEventSource = vSse;
      } catch (e) {
        // Ignorar
      }
    }

    if (regsEndpoint) {
      try {
        const rSse = new EventSource(regsEndpoint);
        const onRegEvent = () => pullRegistrationsFromCloud(state.roomCode);
        rSse.addEventListener('put', onRegEvent);
        rSse.addEventListener('patch', onRegEvent);
        rSse.onerror = () => scheduleSseRecovery(rSse);
        registrationsEventSource = rSse;
      } catch (e) {
        // Ignorar
      }
    }

    cloudPollTimer = setInterval(pullStateFromCloud, 5000);
  }

  function applyRoleModeUI() {
    document.body.classList.toggle('spectator-mode', !isAdminMode);
    const btn = document.getElementById('btnToggleAdminMode');
    if (btn) {
      btn.textContent = isAdminMode ? 'Organizador' : 'Jugador';
      btn.classList.toggle('is-admin', isAdminMode);
    }

    if (!isAdminMode) {
      const setupView = document.getElementById('view-setup');
      if (setupView && setupView.classList.contains('active')) {
        switchTab('rounds');
      }
    }
  }

  // =========================================================================
  // 2. REGLAS Y CÁLCULO DE PUNTUACIÓN
  // =========================================================================

  /**
   * Penalización de Pintura:
   * -1 en individual/parejas, -2 en equipos (4vs4)
   */
  function calcPaintPenalty(paintVal) {
    const clean = (paintVal || '').trim().toLowerCase();
    if (clean === 'n') {
      return state.mode === 'teams' ? -2 : -1;
    }
    return 0;
  }

  /**
   * Penalización de Atraso:
   * 10-20 min o > 20 min resta -1 punto
   */
  function calcDelayPenalty(delayVal) {
    if (delayVal === '10 - 20 min' || delayVal === '> 20 min') {
      return -1;
    }
    return 0;
  }

  /**
   * Validador de Error por Atraso > 20 min sin Abandono de Partida
   */
  function hasDelayError(playerObj) {
    return playerObj.delay === '> 20 min' && !playerObj.abandonMatch;
  }

  /**
   * Puntos de Escenario por defecto ante abandono/rendición del rival o BYE
   */
  function getDefaultScenarioVp() {
    if (state.scoringSystem === 'expanded') {
      return 10;
    }
    return state.mode === 'individual' ? 6 : 12;
  }

  /**
   * Cálculo de Puntos de Torneo según Resultado (V/E/D), Diferencia de PV y Rendición
   * 10.1 Sistema de Puntos Extendido:
   * - Victoria Absoluta: +5 puntos (puntuar al menos 10 VPs más que tu oponente, Dif >= 10)
   * - Victoria Ajustada: +4 puntos (cualquier otra victoria, Dif < 10)
   * - Empate: +2 puntos
   * - Derrota Ajustada: +1 punto (perder sin que la diferencia de VPs sea 10 o más, Dif < 10)
   * - Derrota Absoluta: 0 puntos (perder si la diferencia de VPs es 10 o más, Dif >= 10)
   */
  function calcAutoTournamentPoints(result, vpDiff, surrendered) {
    const res = (result || '').toUpperCase();
    if (!res) return 0;

    const absDiff = Math.abs(Number(vpDiff || 0));

    if (state.scoringSystem === 'classic') {
      if (res === 'V') return 3;
      if (res === 'E') return 1;
      if (res === 'D') return surrendered ? -1 : 0;
      return 0;
    }

    // Escala Extendida (5 / 4 / 2 / 1 / 0)
    if (res === 'V') {
      return absDiff >= 10 ? 5 : 4;
    }
    if (res === 'E') {
      return 2;
    }
    if (res === 'D') {
      if (surrendered) return 0;
      return absDiff < 10 ? 1 : 0;
    }
    return 0;
  }

  /**
   * Recalcula una mesa aplicando las reglas de puntuación
   */
  function recalculateMatch(match, triggerSource) {
    const p1 = match.p1;
    const p2 = match.p2;

    const anyForfeit =
      p1.surrender ||
      p1.abandonMatch ||
      p1.abandonTournament ||
      p2.surrender ||
      p2.abandonMatch ||
      p2.abandonTournament;

    // Si es un BYE automático
    if (p2.name === 'BYE' || p1.name === 'BYE') {
      const defaultVp = getDefaultScenarioVp();
      if (p2.name === 'BYE') {
        p1.result = 'V';
        p2.result = 'D';
        p1.vp = defaultVp;
        p2.vp = 0;
      } else {
        p2.result = 'V';
        p1.result = 'D';
        p2.vp = defaultVp;
        p1.vp = 0;
      }
      p1.manualTp = false;
      p2.manualTp = false;
    } else if (anyForfeit) {
      const p1Forfeit = p1.surrender || p1.abandonMatch || p1.abandonTournament;
      const p2Forfeit = p2.surrender || p2.abandonMatch || p2.abandonTournament;
      const defaultVp = getDefaultScenarioVp();

      if (p1Forfeit && p2Forfeit) {
        p1.result = 'D';
        p2.result = 'D';
        p1.vp = 0;
        p2.vp = 0;
      } else if (p1Forfeit) {
        p1.result = 'D';
        p2.result = 'V';
        p1.vp = 0;
        if (triggerSource === 'forfeit' || p2.vp === 0) {
          p2.vp = defaultVp;
        }
      } else if (p2Forfeit) {
        p2.result = 'D';
        p1.result = 'V';
        p2.vp = 0;
        if (triggerSource === 'forfeit' || p1.vp === 0) {
          p1.vp = defaultVp;
        }
      }
      p1.manualTp = false;
      p2.manualTp = false;
    } else if (triggerSource === 'vp') {
      if (p1.vp > p2.vp) {
        p1.result = 'V';
        p2.result = 'D';
      } else if (p2.vp > p1.vp) {
        p2.result = 'V';
        p1.result = 'D';
      } else {
        p1.result = 'E';
        p2.result = 'E';
      }
      p1.manualTp = false;
      p2.manualTp = false;
    }

    const diff1 = Number(p1.vp || 0) - Number(p2.vp || 0);
    const diff2 = Number(p2.vp || 0) - Number(p1.vp || 0);

    if (!p1.manualTp) {
      p1.tp = calcAutoTournamentPoints(p1.result, diff1, p1.surrender);
    }
    if (!p2.manualTp) {
      p2.tp = calcAutoTournamentPoints(p2.result, diff2, p2.surrender);
    }
  }

  /**
   * Obtiene la lista de entidades competitivas para el Podio y el Resumen:
   * - En modo 'individual' o 'pairs': la lista de `state.players`.
   * - En modo 'teams': los nombres de los equipos en `state.teams`.
   */
  function getCompetitorEntities() {
    if (state.mode === 'teams') {
      return state.teams.map((t) => t.name);
    }
    return state.players;
  }

  /**
   * Construye la Matriz Histórica interna para evitar repetir rivales y mesas en el emparejamiento suizo.
   */
  function buildVarMatrix() {
    const entities = getCompetitorEntities();
    const matrix = {};

    entities.forEach((name) => {
      matrix[name] = {
        name,
        tablesByRound: {},
        opponentsByRound: {}
      };
    });

    state.rounds.forEach((rObj) => {
      const r = rObj.round;
      if (state.mode === 'teams') {
        (rObj.teamClashes || []).forEach((clash) => {
          if (clash.team1 && matrix[clash.team1]) {
            matrix[clash.team1].tablesByRound[r] = clash.tableGroup || '';
            matrix[clash.team1].opponentsByRound[r] = clash.team2 || '';
          }
          if (clash.team2 && matrix[clash.team2]) {
            matrix[clash.team2].tablesByRound[r] = clash.tableGroup || '';
            matrix[clash.team2].opponentsByRound[r] = clash.team1 || '';
          }
        });
      } else {
        (rObj.matches || []).forEach((m) => {
          const n1 = m.p1.name;
          const n2 = m.p2.name;
          if (n1 && matrix[n1]) {
            matrix[n1].tablesByRound[r] = m.table || '';
            matrix[n1].opponentsByRound[r] = n2 || '';
          }
          if (n2 && matrix[n2]) {
            matrix[n2].tablesByRound[r] = m.table || '';
            matrix[n2].opponentsByRound[r] = n1 || '';
          }
        });
      }
    });

    return matrix;
  }

  /**
   * Calcula la tabla de posiciones y el desglose ronda por ronda
   */
  function calculateStandings(upToRound = state.totalRounds) {
    const entities = getCompetitorEntities();
    const statsMap = {};

    entities.forEach((name) => {
      statsMap[name] = {
        name,
        abandoned: isEntityDropped(name),
        grossTp: 0,
        penalties: 0,
        finalTp: 0,
        vpDiff: 0,
        vpFavor: 0,
        perRound: {}
      };
      for (let r = 1; r <= state.totalRounds; r++) {
        statsMap[name].perRound[r] = {
          played: false,
          result: '',
          tp: 0,
          vp: 0,
          diff: 0,
          paintPen: 0,
          delayPen: 0,
          abandoned: false
        };
      }
    });

    state.rounds.forEach((rObj) => {
      const r = rObj.round;
      if (r > upToRound) return;

      (rObj.matches || []).forEach((m) => {
        const sides = [
          { me: m.p1, opp: m.p2, teamName: m.team1 },
          { me: m.p2, opp: m.p1, teamName: m.team2 }
        ];

        sides.forEach(({ me, opp, teamName }) => {
          const key = state.mode === 'teams' ? teamName : me.name;
          if (!key || !statsMap[key]) return;

          const entry = statsMap[key];
          const rStat = entry.perRound[r];

          const paintPen = calcPaintPenalty(me.paint);
          const delayPen = calcDelayPenalty(me.delay);
          const vp = Number(me.vp || 0);
          const diff = vp - Number(opp.vp || 0);
          if (me.result && !me.manualTp) {
            me.tp = calcAutoTournamentPoints(me.result, diff, me.surrender);
          }
          const tp = Number(me.tp || 0);

          rStat.played = true;
          rStat.result = state.mode === 'teams' ? `${rStat.result}${me.result || ''}` : me.result || '';
          rStat.tp += tp;
          rStat.vp += vp;
          rStat.diff += diff;
          rStat.paintPen += paintPen;
          rStat.delayPen += delayPen;

          if (me.abandonTournament) {
            rStat.abandoned = true;
            entry.abandoned = true;
          }

          entry.grossTp += tp;
          entry.penalties += paintPen + delayPen;
          entry.vpFavor += vp;
          entry.vpDiff += diff;
        });
      });
    });

    const list = Object.values(statsMap).map((item) => {
      item.finalTp = item.grossTp + item.penalties;
      return item;
    });

    // Ordenamiento multicriterio:
    // 1. No Abandono (activos primero)
    // 2. Puntos de Torneo Final DESC
    // 3. Diferencia de Puntos de Victoria DESC
    // 4. Puntos de Victoria a Favor DESC
    list.sort((a, b) => {
      if (a.abandoned !== b.abandoned) return a.abandoned ? 1 : -1;
      if (b.finalTp !== a.finalTp) return b.finalTp - a.finalTp;
      if (b.vpDiff !== a.vpDiff) return b.vpDiff - a.vpDiff;
      if (b.vpFavor !== a.vpFavor) return b.vpFavor - a.vpFavor;
      return a.name.localeCompare(b.name);
    });

    return list;
  }

  // =========================================================================
  // 3. ALGORITMO DE EMPAREJAMIENTO SUIZO Y SORTEO DE MESAS
  // =========================================================================

  function shuffleArray(arr) {
    const copy = [...arr];
    for (let i = copy.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy;
  }

  function generatePairingsForRound(roundNum) {
    const varMatrix = buildVarMatrix();

    let activeList = [];
    if (roundNum === 1) {
      activeList = shuffleArray(getCompetitorEntities().filter((name) => !isEntityDropped(name)));
    } else {
      const prevStandings = calculateStandings(roundNum - 1);
      activeList = prevStandings.filter((s) => !s.abandoned && !isEntityDropped(s.name)).map((s) => s.name);
    }

    if (activeList.length % 2 !== 0) {
      activeList.push('BYE');
    }

    function havePlayedBefore(a, b) {
      if (a === 'BYE' || b === 'BYE') return false;
      const rec = varMatrix[a];
      if (!rec) return false;
      for (let r = 1; r < roundNum; r++) {
        if (rec.opponentsByRound[r] === b) return true;
      }
      return false;
    }

    const used = new Array(activeList.length).fill(false);
    const pairs = [];

    function backtrack() {
      let firstIdx = -1;
      for (let i = 0; i < activeList.length; i++) {
        if (!used[i]) {
          firstIdx = i;
          break;
        }
      }
      if (firstIdx === -1) return true;

      used[firstIdx] = true;
      const p1 = activeList[firstIdx];

      for (let j = firstIdx + 1; j < activeList.length; j++) {
        if (!used[j] && !havePlayedBefore(p1, activeList[j])) {
          used[j] = true;
          pairs.push([p1, activeList[j]]);
          if (backtrack()) return true;
          pairs.pop();
          used[j] = false;
        }
      }

      used[firstIdx] = false;
      return false;
    }

    const successNoRepeat = backtrack();

    if (!successNoRepeat) {
      pairs.length = 0;
      used.fill(false);
      for (let i = 0; i < activeList.length; i++) {
        if (used[i]) continue;
        used[i] = true;
        let matchedJ = -1;
        for (let j = i + 1; j < activeList.length; j++) {
          if (!used[j] && !havePlayedBefore(activeList[i], activeList[j])) {
            matchedJ = j;
            break;
          }
        }
        if (matchedJ === -1) {
          for (let j = i + 1; j < activeList.length; j++) {
            if (!used[j]) {
              matchedJ = j;
              break;
            }
          }
        }
        if (matchedJ !== -1) {
          used[matchedJ] = true;
          pairs.push([activeList[i], activeList[matchedJ]]);
        }
      }
    }

    const availableTables = [];
    if (state.mode === 'teams') {
      state.tableGroups.forEach((g) => availableTables.push(g.name));
    } else {
      const maxT = Math.max(state.totalTables, pairs.length);
      for (let t = 1; t <= maxT; t++) {
        availableTables.push(`Mesa ${t}`);
      }
    }

    function hasPlayedOnTable(entity, tableName) {
      if (entity === 'BYE') return false;
      const rec = varMatrix[entity];
      if (!rec) return false;
      for (let r = 1; r < roundNum; r++) {
        if (rec.tablesByRound[r] === tableName) return true;
      }
      return false;
    }

    let chosenTables = shuffleArray(availableTables).slice(0, pairs.length);
    for (let attempt = 0; attempt < 2500; attempt++) {
      const candidate = shuffleArray(availableTables).slice(0, pairs.length);
      let conflict = false;
      for (let k = 0; k < pairs.length; k++) {
        const [p1, p2] = pairs[k];
        if (hasPlayedOnTable(p1, candidate[k]) || hasPlayedOnTable(p2, candidate[k])) {
          conflict = true;
          break;
        }
      }
      if (!conflict) {
        chosenTables = candidate;
        break;
      }
    }

    return pairs.map(([p1, p2], idx) => ({
      p1,
      p2,
      table: chosenTables[idx] || `Mesa ${idx + 1}`
    }));
  }

  // =========================================================================
  // 4. RENDERIZADO DE LA INTERFAZ Y EVENTOS
  // =========================================================================

  function showToast(msg) {
    const container = document.getElementById('toastContainer');
    const toast = document.createElement('div');
    toast.className = 'elven-toast';
    toast.textContent = msg;
    container.appendChild(toast);
    setTimeout(() => {
      toast.remove();
    }, 3400);
  }

  function switchTab(tabId) {
    document.querySelectorAll('.category-card').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.tab === tabId);
    });
    document.querySelectorAll('.tab-view').forEach((view) => {
      view.classList.toggle('active', view.id === `view-${tabId}`);
    });

    const titles = {
      setup: 'CONFIGURACIÓN E INSCRIPCIÓN',
      rounds: `RONDAS Y EMPAREJAMIENTOS (RONDA ${state.activeRound})`,
      podium: 'TABLA DE POSICIONES (PODIO)'
    };
    document.getElementById('topbarTitleText').textContent = titles[tabId] || 'TORNEO TIERRA MEDIA';

    renderAll();
  }

  function renderSidebarStatus() {
    const standings = calculateStandings();
    const activeCount = standings.filter((s) => !s.abandoned).length;
    const totalCount = standings.length;
    const completedRounds = state.rounds.filter(
      (r) => r.finished || (r.matches || []).some((m) => m.p1.result || m.p2.result)
    ).length;

    document.getElementById('sidebarTournamentName').textContent =
      (state.tournamentName || 'TORNEO MESBG').toUpperCase();
    const roomCodeEl = document.getElementById('activeRoomCodeDisplay');
    if (roomCodeEl) {
      roomCodeEl.textContent = state.roomCode || '------';
    }
    const minBadgeEl = document.getElementById('minimizedRoomCodeBadge');
    if (minBadgeEl) {
      minBadgeEl.textContent = state.roomCode || '------';
    }
    document.getElementById('statActivePlayers').textContent = `${activeCount} / ${totalCount}`;
    document.getElementById('statRounds').textContent = `${completedRounds} / ${state.totalRounds}`;
    document.getElementById('statTables').textContent = String(state.totalTables);
    document.getElementById('statLeader').textContent =
      standings.length > 0 && completedRounds > 0 ? standings[0].name : 'Sin datos';

    const modeNames = {
      individual: 'Duelos Individuales',
      pairs: 'Duelos por Parejas',
      teams: 'Duelos 4vs4'
    };
    const scoreNames = {
      expanded: 'Expandido',
      classic: 'Clásico'
    };
    document.getElementById('badgeCurrentMode').textContent =
      `${modeNames[state.mode]} • ${scoreNames[state.scoringSystem]}`;

    renderRecentRoomsList();
  }

  function renderRecentRoomsList() {
    const listEl = document.getElementById('recentRoomsList');
    const secEl = document.getElementById('recentRoomsSection');
    if (!listEl || !secEl) return;

    addOrUpdateRecentRoom(state);
    const rooms = getRecentRooms();
    if (rooms.length === 0) {
      secEl.classList.add('hidden');
      return;
    }
    secEl.classList.remove('hidden');

    listEl.innerHTML = rooms
      .map((item) => {
        const isCurrent = item.code === state.roomCode;
        const owned = isRoomOwnedByMe(item.code);
        const localSnap = getRoomFromLocalRegistry(item.code);
        const isFinished = isCurrent
          ? !!state.tournamentFinished
          : !!(item.finished || (localSnap && localSnap.tournamentFinished));
        return `
          <div class="recent-room-item ${isCurrent ? 'active-room' : ''} ${isFinished ? 'is-finished-room' : ''}">
            <button type="button" class="recent-room-btn" data-recent-code="${escapeHtml(item.code)}" title="Entrar a sala ${escapeHtml(item.code)}">
              <span class="recent-room-code">${escapeHtml(item.code)}</span>
              <span class="recent-room-name">${escapeHtml(item.name || 'Torneo MESBG')}</span>
              ${isFinished ? `<span class="recent-room-status is-finished">🔒 Finalizado</span>` : ''}
              <span class="recent-room-role ${owned ? 'is-owner' : ''}">${owned ? 'Organizador' : 'Jugador'}</span>
            </button>
            ${
              !isCurrent
                ? `<button type="button" class="recent-room-del" data-del-recent="${escapeHtml(item.code)}" title="Quitar de recientes">✕</button>`
                : ''
            }
          </div>
        `;
      })
      .join('');

    listEl.querySelectorAll('button[data-recent-code]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        const code = e.currentTarget.dataset.recentCode;
        if (code && code !== state.roomCode) {
          joinTournamentByCode(code);
        }
      });
    });

    listEl.querySelectorAll('button[data-del-recent]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const code = e.currentTarget.dataset.delRecent;
        removeRecentRoom(code);
        renderRecentRoomsList();
      });
    });
  }

  // =========================================================================
  // 4B. TEMPORIZADOR / RELOJ DE RONDA SINCRONIZADO EN VIVO
  // =========================================================================

  function getRoundRemainingMs(rObj) {
    if (!rObj || !rObj.timer) return 90 * 60 * 1000;
    if (rObj.timer.running && rObj.timer.endTime) {
      return Math.max(0, Number(rObj.timer.endTime) - Date.now());
    }
    return Math.max(0, Number(rObj.timer.remainingMs ?? 90 * 60 * 1000));
  }

  function formatTimerMs(ms) {
    const totalSec = Math.max(0, Math.ceil(ms / 1000));
    const hrs = Math.floor(totalSec / 3600);
    const mins = Math.floor((totalSec % 3600) / 60);
    const secs = totalSec % 60;
    const pad = (n) => String(n).padStart(2, '0');
    return `${pad(hrs)}:${pad(mins)}:${pad(secs)}`;
  }

  function playTimerAlertSound() {
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return;
      const ctx = new AudioCtx();
      [523.25, 659.25, 783.99].forEach((freq, idx) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(0.14, ctx.currentTime + idx * 0.16);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + idx * 0.16 + 0.35);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(ctx.currentTime + idx * 0.16);
        osc.stop(ctx.currentTime + idx * 0.16 + 0.36);
      });
    } catch (e) {
      // Ignorar si el navegador bloquea audio sin interacción
    }
  }

  function updateRoundTimerUI() {
    const rObj = (state.rounds || []).find((x) => Number(x.round) === Number(state.activeRound));
    if (!rObj) return;
    if (!rObj.timer) {
      rObj.timer = {
        durationMinutes: 90,
        remainingMs: 90 * 60 * 1000,
        endTime: null,
        running: false
      };
    }

    const remMs = getRoundRemainingMs(rObj);
    const isRunning = !!rObj.timer.running && remMs > 0;
    const isWarning15m = remMs > 0 && remMs <= 15 * 60 * 1000;
    const isExpired = remMs <= 0 && (rObj.timer.running || rObj.timer.remainingMs === 0);

    const displayEl = document.getElementById('roundTimerDisplay');
    const badgeEl = document.getElementById('roundTimerStatusBadge');
    const clockBox = document.getElementById('roundTimerClockBox');
    const alert15El = document.getElementById('roundTimer15MinAlert');
    const btnToggle = document.getElementById('btnToggleTimerRun');
    const inputMins = document.getElementById('inputTimerMinutes');

    if (displayEl) {
      displayEl.textContent = formatTimerMs(remMs);
    }

    if (inputMins && document.activeElement !== inputMins) {
      inputMins.value = rObj.timer.durationMinutes || 90;
    }

    if (clockBox) {
      clockBox.classList.toggle('warning-15m', isWarning15m);
      clockBox.classList.toggle('expired', isExpired);
    }

    if (alert15El) {
      alert15El.classList.toggle('hidden', !isWarning15m);
    }

    if (badgeEl) {
      badgeEl.className = 'timer-status-pill';
      if (isExpired) {
        badgeEl.textContent = 'TIEMPO FINALIZADO';
        badgeEl.classList.add('expired');
      } else if (isWarning15m && isRunning) {
        badgeEl.textContent = 'ÚLTIMOS 15 MIN';
        badgeEl.classList.add('warning');
      } else if (isRunning) {
        badgeEl.textContent = 'EN CURSO';
        badgeEl.classList.add('running');
      } else {
        badgeEl.textContent = 'EN PAUSA';
      }
    }

    if (btnToggle) {
      btnToggle.textContent = isRunning ? '⏸ Pausar' : '▶ Iniciar';
    }

    const roundKey = `${state.roomCode}_R${rObj.round}`;
    if (isRunning && isWarning15m && !warned15MinByRound[roundKey]) {
      warned15MinByRound[roundKey] = true;
      playTimerAlertSound();
      showToast(`⏳ ¡Atención! Quedan 15 minutos o menos en la Ronda ${rObj.round}.`);
    }

    if (rObj.timer.running && remMs <= 0 && !warnedExpiredByRound[roundKey]) {
      warnedExpiredByRound[roundKey] = true;
      rObj.timer.running = false;
      rObj.timer.remainingMs = 0;
      rObj.timer.endTime = null;
      playTimerAlertSound();
      showToast(`🔔 ¡El tiempo de la Ronda ${rObj.round} ha finalizado!`);
      if (isAdminMode) {
        saveState();
      }
    }
  }

  function startGlobalTimerTicker() {
    if (timerIntervalId) clearInterval(timerIntervalId);
    timerIntervalId = setInterval(updateRoundTimerUI, 1000);
  }

  function getRegisteredPlayersList() {
    const map = new Map();
    if (state.registrations && typeof state.registrations === 'object') {
      Object.entries(state.registrations).forEach(([key, val]) => {
        if (!val || !val.name) return;
        const cleanName = String(val.name).trim();
        const cleanArmy = String(val.army || (state.playerArmies && state.playerArmies[cleanName]) || '').trim();
        map.set(cleanName.toLowerCase(), {
          key,
          name: cleanName,
          army: cleanArmy,
          joinedAt: Number(val.joinedAt) || 0
        });
      });
    }
    if (state.mode === 'individual' && Array.isArray(state.players)) {
      state.players.forEach((pName) => {
        const cleanName = String(pName || '').trim();
        if (!cleanName) return;
        const lower = cleanName.toLowerCase();
        if (!map.has(lower)) {
          map.set(lower, {
            key: sanitizeFirebaseKey(cleanName),
            name: cleanName,
            army: getEntityArmy(cleanName),
            joinedAt: 0
          });
        }
      });
    }
    return Array.from(map.values());
  }

  function isPlayerAssignedInCurrentMode(playerName) {
    const lower = String(playerName || '').trim().toLowerCase();
    if (!lower) return false;
    if (state.mode === 'individual') {
      return (state.players || []).some((p) => String(p).trim().toLowerCase() === lower);
    }
    if (state.mode === 'pairs') {
      return (state.players || []).some((pairStr) =>
        String(pairStr)
          .split(/\s*[&+/]\s*|\s+y\s+/i)
          .map((s) => s.trim().toLowerCase())
          .includes(lower)
      );
    }
    if (state.mode === 'teams') {
      return (state.teams || []).some((t) =>
        (t.members || []).some((m) => String(m).trim().toLowerCase() === lower)
      );
    }
    return false;
  }

  function isMatchMine(match) {
    const myId = getMyPlayerIdentity(state.roomCode);
    const myName = String(myId.name || '').trim();
    if (!myName || !match) return false;
    if (isPlayerInMatch(match, myName)) return true;
    if (state.mode === 'teams') {
      return isPlayerInEntity(match.team1, myName) || isPlayerInEntity(match.team2, myName);
    }
    return false;
  }

  function renderSetupView() {
    updatePlayerIdentityPillUI();

    // Modalidad
    document.querySelectorAll('#modalityGrid .difficulty-card').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.mode === state.mode);
    });

    // Sistema de puntos
    document.querySelectorAll('#scoringSystemGrid .difficulty-card').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.scoring === state.scoringSystem);
    });

    // Inputs numéricos (proteger foco si el Organizador está escribiendo)
    const setValIfNotFocused = (id, val) => {
      const el = document.getElementById(id);
      if (el && document.activeElement !== el) {
        el.value = val;
      }
    };
    setValIfNotFocused('inputTournamentName', state.tournamentName);
    setValIfNotFocused('inputTotalRounds', state.totalRounds);
    setValIfNotFocused('inputTotalTables', state.totalTables);
    setValIfNotFocused('inputTeamCount', state.teamCount);
    setValIfNotFocused('inputMembersPerTeam', state.membersPerTeam);
    setValIfNotFocused('inputTablesPerTeam', state.tablesPerTeam);

    // Estado de Inscripciones Abiertas / Cerradas
    const regOpen = state.registrationOpen !== false;
    const btnToggleReg = document.getElementById('btnToggleRegistrationOpen');
    if (btnToggleReg) {
      btnToggleReg.textContent = regOpen ? '🟢 Inscripciones Abiertas' : '🔒 Inscripciones Cerradas';
      btnToggleReg.classList.toggle('btn-voting-active', regOpen);
    }
    const regCaption = document.getElementById('registrationStatusCaption');
    if (regCaption) {
      regCaption.innerHTML = regOpen
        ? `🟢 <strong>Inscripciones abiertas:</strong> Al entrar con el código <strong>${escapeHtml(
            state.roomCode
          )}</strong>, cada jugador se identifica con su <strong>Nombre / Nick</strong> y su <strong>Ejército</strong>.`
        : `🔒 <strong>Inscripciones cerradas:</strong> Los nuevos visitantes solo podrán vincularse a un jugador ya inscrito o mirar como espectadores.`;
    }

    const regPool = getRegisteredPlayersList();
    const poolBox = document.getElementById('registeredPoolBox');
    const poolCountLabel = document.getElementById('poolCountLabel');
    const poolChipsEl = document.getElementById('registeredPoolChips');
    if (poolBox && poolChipsEl && poolCountLabel) {
      const showPool = regPool.length > 0 || state.mode === 'pairs' || state.mode === 'teams';
      poolBox.classList.toggle('hidden', !showPool);
      poolCountLabel.textContent = String(regPool.length);

      if (regPool.length === 0) {
        poolChipsEl.innerHTML = `<span class="helper-caption">Aún no hay jugadores inscritos con el código ${escapeHtml(
          state.roomCode
        )}. Comparte el link o inscríbelos arriba.</span>`;
      } else {
        poolChipsEl.innerHTML = regPool
          .map((item) => {
            const assigned = isPlayerAssignedInCurrentMode(item.name);
            const dropped = isEntityDropped(item.name);
            return `
              <span class="pool-player-chip ${assigned ? 'is-assigned' : ''}" title="${
              dropped
                ? 'Jugador retirado (Drop)'
                : assigned
                ? 'Ya asignado en el torneo'
                : 'Disponible para emparejar / asignar'
            }">
                <strong>${escapeHtml(item.name)}</strong>
                ${item.army ? `<span class="pool-chip-army">🛡️ ${escapeHtml(item.army)}</span>` : ''}
                ${dropped ? `<span class="drop-pill-tag">🏳️ DROP</span>` : ''}
                <button type="button" class="pool-chip-remove" data-remove-pool-player="${escapeHtml(
                  item.name
                )}" title="Eliminar inscripción de ${escapeHtml(item.name)}">✕</button>
              </span>
            `;
          })
          .join('');

        poolChipsEl.querySelectorAll('button[data-remove-pool-player]').forEach((btn) => {
          btn.addEventListener('click', async (e) => {
            const pName = e.currentTarget.dataset.removePoolPlayer;
            if (!pName) return;
            state.players = state.players.filter((p) => String(p).toLowerCase() !== pName.toLowerCase());
            await deletePlayerRegistrationFromCloud(pName, state.roomCode);
            saveState();
            renderSetupView();
            renderSidebarStatus();
          });
        });
      }
    }

    const isTeams = state.mode === 'teams';
    const isPairs = state.mode === 'pairs';
    document.querySelectorAll('.team-only-field').forEach((el) => {
      el.classList.toggle('hidden', !isTeams);
    });
    document.getElementById('individualRosterBlock').classList.toggle('hidden', isTeams);
    document.getElementById('teamsRosterBlock').classList.toggle('hidden', !isTeams);

    const rosterTitleEl = document.getElementById('rosterBlockTitleLabel');
    if (rosterTitleEl) {
      rosterTitleEl.textContent = isPairs
        ? 'LISTA DE PAREJAS FORMADAS (2 VS 2)'
        : 'LISTA DE PARTICIPANTES INSCRITOS';
    }

    const pairsBuilderEl = document.getElementById('pairsOrganizerBuilder');
    if (pairsBuilderEl) {
      pairsBuilderEl.classList.toggle('hidden', !isPairs);
      if (isPairs) {
        const sel1 = document.getElementById('selectPairMember1');
        const sel2 = document.getElementById('selectPairMember2');
        const unassigned = regPool.filter((r) => !isPlayerAssignedInCurrentMode(r.name));
        const assigned = regPool.filter((r) => isPlayerAssignedInCurrentMode(r.name));
        const orderedPool = [...unassigned, ...assigned];

        const buildOpts = (placeholder) =>
          [
            `<option value="">${placeholder}</option>`,
            ...orderedPool.map((r) => {
              const armyTxt = r.army ? ` (${r.army})` : '';
              const statusTxt = isPlayerAssignedInCurrentMode(r.name) ? ' [Ya en pareja]' : '';
              return `<option value="${escapeHtml(r.name)}">${escapeHtml(r.name + armyTxt + statusTxt)}</option>`;
            })
          ].join('');

        if (sel1) sel1.innerHTML = buildOpts('-- Selecciona Jugador 1 --');
        if (sel2) sel2.innerHTML = buildOpts('-- Selecciona Jugador 2 --');
      }
    }

    if (!isTeams) {
      document.getElementById('rosterCountLabel').textContent = String(state.players.length);
      document.getElementById('requiredTablesLabel').textContent = String(
        Math.ceil(state.players.length / 2)
      );

      const listEl = document.getElementById('playersRosterList');
      listEl.innerHTML = '';
      state.players.forEach((pName, idx) => {
        const currentArmy = getEntityArmy(pName);
        const div = document.createElement('div');
        div.className = 'roster-item with-army';
        div.innerHTML = `
          <span class="roster-num">${idx + 1}</span>
          <input type="text" value="${escapeHtml(pName)}" data-player-idx="${idx}" aria-label="Jugador ${idx + 1}" placeholder="Nombre / Pareja" />
          <input type="text" class="roster-army-input" value="${escapeHtml(currentArmy)}" data-army-idx="${idx}" aria-label="Ejército ${idx + 1}" placeholder="Ejército / Facción" />
          <button class="roster-remove-btn" data-remove-idx="${idx}" title="Eliminar participante">✕</button>
        `;
        listEl.appendChild(div);
      });

      listEl.querySelectorAll('input[data-player-idx]').forEach((inp) => {
        inp.addEventListener('change', (e) => {
          const idx = Number(e.target.dataset.playerIdx);
          const oldName = state.players[idx];
          const newVal = e.target.value.trim();
          if (newVal) {
            if (oldName && state.playerArmies && state.playerArmies[oldName] && !state.playerArmies[newVal]) {
              state.playerArmies[newVal] = state.playerArmies[oldName];
            }
            state.players[idx] = newVal;
            saveState();
            renderSidebarStatus();
          }
        });
      });

      listEl.querySelectorAll('input[data-army-idx]').forEach((inp) => {
        inp.addEventListener('change', (e) => {
          const idx = Number(e.target.dataset.armyIdx);
          const pName = state.players[idx];
          const newArmy = e.target.value.trim();
          if (!pName) return;
          if (!state.playerArmies || typeof state.playerArmies !== 'object') {
            state.playerArmies = {};
          }
          state.playerArmies[pName] = newArmy;
          const regKey = sanitizeFirebaseKey(pName);
          if (state.registrations && state.registrations[regKey]) {
            state.registrations[regKey].army = newArmy;
            submitPlayerRegistrationToCloud(pName, newArmy, state.roomCode);
          }
          saveState();
          renderSetupView();
        });
      });

      listEl.querySelectorAll('button[data-remove-idx]').forEach((btn) => {
        btn.addEventListener('click', async (e) => {
          const idx = Number(e.currentTarget.dataset.removeIdx);
          const removedName = state.players[idx];
          state.players.splice(idx, 1);
          if (state.mode === 'individual' && removedName) {
            await deletePlayerRegistrationFromCloud(removedName, state.roomCode);
          }
          saveState();
          renderSetupView();
          renderSidebarStatus();
        });
      });
    } else {
      const container = document.getElementById('teamsRosterContainer');
      container.innerHTML = '';
      const poolOptionsHtml = [
        `<option value="">📥 Elegir inscrito...</option>`,
        ...regPool.map(
          (r) =>
            `<option value="${escapeHtml(r.name)}">${escapeHtml(
              r.name + (r.army ? ` (${r.army})` : '')
            )}</option>`
        )
      ].join('');

      state.teams.forEach((team, tIdx) => {
        const card = document.createElement('div');
        card.className = 'team-roster-card';
        const membersInputs = team.members
          .map((m, mIdx) => {
            const mArmy = getEntityArmy(m);
            return `
            <div class="roster-item" style="flex-direction:column; align-items:stretch; gap:4px;">
              <div class="team-member-row-grid">
                <span class="roster-num">${mIdx + 1}</span>
                <input type="text" value="${escapeHtml(m)}" data-team-idx="${tIdx}" data-member-idx="${mIdx}" />
                ${
                  regPool.length > 0
                    ? `<select class="team-pool-select" data-pick-team="${tIdx}" data-pick-member="${mIdx}" title="Asignar jugador inscrito en la sala">${poolOptionsHtml}</select>`
                    : ''
                }
              </div>
              ${
                mArmy
                  ? `<div style="padding-left:30px;"><span class="player-army-sub">🛡️ ${escapeHtml(mArmy)}</span></div>`
                  : ''
              }
            </div>
          `;
          })
          .join('');

        card.innerHTML = `
          <input type="text" class="team-header-input" value="${escapeHtml(team.name)}" data-team-name-idx="${tIdx}" />
          <div class="team-members-stack">${membersInputs}</div>
        `;
        container.appendChild(card);
      });

      container.querySelectorAll('input[data-team-name-idx]').forEach((inp) => {
        inp.addEventListener('change', (e) => {
          const tIdx = Number(e.target.dataset.teamNameIdx);
          state.teams[tIdx].name = e.target.value.trim().replace(/\s+/g, '_');
          saveState();
          renderSetupView();
        });
      });

      container.querySelectorAll('input[data-member-idx]').forEach((inp) => {
        inp.addEventListener('change', (e) => {
          const tIdx = Number(e.target.dataset.teamIdx);
          const mIdx = Number(e.target.dataset.memberIdx);
          state.teams[tIdx].members[mIdx] = e.target.value.trim();
          saveState();
          renderSetupView();
        });
      });

      container.querySelectorAll('select[data-pick-team]').forEach((sel) => {
        sel.addEventListener('change', (e) => {
          const pickedName = e.target.value;
          if (!pickedName) return;
          const tIdx = Number(e.target.dataset.pickTeam);
          const mIdx = Number(e.target.dataset.pickMember);
          state.teams[tIdx].members[mIdx] = pickedName;
          saveState();
          renderSetupView();
        });
      });
    }
  }

  function renderRoundsView() {
    if (state.activeRound > state.totalRounds) {
      state.activeRound = 1;
    }

    // Píldoras de selección de ronda
    const pillsContainer = document.getElementById('roundPillsContainer');
    pillsContainer.innerHTML = '';
    for (let r = 1; r <= state.totalRounds; r++) {
      const rObj = state.rounds.find((x) => x.round === r);
      const hasMatches = rObj && rObj.matches && rObj.matches.length > 0;
      const isFinished = !!(rObj && rObj.finished);
      const btn = document.createElement('button');
      btn.className = `round-pill-btn ${r === state.activeRound ? 'active' : ''} ${
        isFinished ? 'finished' : hasMatches ? 'has-data' : ''
      }`;
      btn.textContent = `Ronda ${r}`;
      btn.addEventListener('click', () => {
        state.activeRound = r;
        saveState();
        renderRoundsView();
      });
      pillsContainer.appendChild(btn);
    }

    let currentRoundObj = state.rounds.find((x) => x.round === state.activeRound);
    if (!currentRoundObj) {
      currentRoundObj = {
        round: state.activeRound,
        paired: false,
        finished: false,
        podiumUpdated: false,
        teamClashes: [],
        matches: []
      };
      state.rounds.push(currentRoundObj);
    }

    const completedMatches = (currentRoundObj.matches || []).filter(
      (m) => m.p1.result && m.p2.result
    ).length;
    const totalM = (currentRoundObj.matches || []).length;
    const stateLabel = currentRoundObj.finished ? ' • Ronda Finalizada ✓' : '';
    document.getElementById('roundStatusCaption').textContent =
      totalM > 0
        ? `Ronda ${state.activeRound} — ${completedMatches} de ${totalM} mesas con resultado registrado${stateLabel}`
        : `Ronda ${state.activeRound} — Sin emparejamientos generados aún. Presiona "Emparejar Rondas"`;

    updateRoundTimerUI();
    updateVotingControlUI();

    const btnFinalizeFromRounds = document.getElementById('btnFinalizeTournamentFromRounds');
    if (btnFinalizeFromRounds) {
      const lastRoundObj = state.rounds.find((x) => Number(x.round) === Number(state.totalRounds));
      const isLastRoundReady =
        Number(state.activeRound) === Number(state.totalRounds) ||
        (lastRoundObj && lastRoundObj.finished);
      btnFinalizeFromRounds.classList.toggle('hidden', !isLastRoundReady);
    }

    // Panel de Equipos
    const teamPanel = document.getElementById('teamRoundPairingPanel');
    teamPanel.classList.toggle('hidden', state.mode !== 'teams');
    if (state.mode === 'teams') {
      renderTeamClashesPanel(currentRoundObj);
    }

    // Tarjeta Gigante "Tu Asiento en esta Ronda" (Seatings Alert + Reporte de Resultado + Drop)
    renderPlayerSeatingHeroCard(currentRoundObj);

    // Renderizar tarjetas de mesas
    const container = document.getElementById('roundMatchesContainer');
    container.innerHTML = '';

    if (!currentRoundObj.matches || currentRoundObj.matches.length === 0) {
      container.innerHTML = `
        <div class="elven-block text-center" style="padding: 36px 20px;">
          <p style="font-family: var(--font-serif); color: var(--gold-bright); font-size: 1rem; margin-bottom: 8px;">
            NO HAY MESAS ASIGNADAS EN LA RONDA ${state.activeRound}
          </p>
          <p class="helper-caption">
            Haz clic en el botón dorado <strong>"EMPAREJAR RONDAS"</strong> para sortear o emparejar por sistema suizo según el Podio.
          </p>
        </div>
      `;
      return;
    }

    const allPlayerOptions =
      state.mode === 'teams'
        ? state.teams.flatMap((t) => t.members)
        : [...state.players, 'BYE'];

    const cleanFilter = (searchFilterQuery || '').trim().toLowerCase();

    // Si es un jugador identificado, ordenar su propia mesa primero en la vista
    const indexedMatches = currentRoundObj.matches.map((match, mIdx) => ({
      match,
      mIdx,
      mine: isMatchMine(match)
    }));
    if (!isAdminMode) {
      indexedMatches.sort((a, b) => (a.mine === b.mine ? a.mIdx - b.mIdx : a.mine ? -1 : 1));
    }

    indexedMatches.forEach(({ match, mIdx, mine }) => {
      if (cleanFilter) {
        const hay = `${match.table} ${match.p1.name} ${match.p2.name} ${getEntityArmy(match.p1.name)} ${getEntityArmy(
          match.p2.name
        )} ${match.team1 || ''} ${match.team2 || ''}`.toLowerCase();
        if (!hay.includes(cleanFilter)) return;
      }

      const card = document.createElement('div');
      card.className = `match-card ${mine ? 'my-player-match' : ''}`;

      const diff1 = Number(match.p1.vp || 0) - Number(match.p2.vp || 0);
      const diff2 = Number(match.p2.vp || 0) - Number(match.p1.vp || 0);
      const p1Pen = calcPaintPenalty(match.p1.paint) + calcDelayPenalty(match.p1.delay);
      const p2Pen = calcPaintPenalty(match.p2.paint) + calcDelayPenalty(match.p2.delay);

      const err1 = hasDelayError(match.p1);
      const err2 = hasDelayError(match.p2);
      const canReportThisMatch =
        (mine || isAdminMode) &&
        !currentRoundObj.finished &&
        !state.tournamentFinished &&
        match.p1.name !== 'BYE' &&
        match.p2.name !== 'BYE';

      card.innerHTML = `
        <div class="match-card-header">
          <div class="match-table-badge">
            <span>⚔️</span>
            <input type="text" class="match-table-input" value="${escapeHtml(match.table)}" data-m-idx="${mIdx}" data-field="table" />
            ${
              match.team1 && match.team2
                ? `<span class="helper-caption">(${escapeHtml(match.team1)} vs ${escapeHtml(match.team2)})</span>`
                : ''
            }
            ${mine ? `<span class="my-match-pill">⚔️ TU MESA</span>` : ''}
            ${
              match.reportedBy
                ? `<span class="match-reported-pill" title="Resultado enviado desde la mesa">📲 Reportado por ${escapeHtml(
                    match.reportedBy
                  )}</span>`
                : ''
            }
          </div>
          <div style="display:flex; align-items:center; gap:8px;">
            ${
              canReportThisMatch
                ? `<button type="button" class="btn-gold-cta btn-sm player-report-match-btn" data-report-match-idx="${mIdx}">
                    📲 ${match.p1.result && match.p2.result ? 'Editar Resultado' : 'Reportar Resultado'}
                  </button>`
                : ''
            }
            <button class="roster-remove-btn" data-delete-match="${mIdx}" title="Eliminar mesa">✕</button>
          </div>
        </div>

        <div class="table-responsive">
          <table class="match-table-grid">
            <thead>
              <tr>
                <th class="text-left">OPONENTES</th>
                <th>RESULTADO</th>
                <th>PT TORNEO</th>
                <th>PV ESCENARIO</th>
                <th class="text-left">DIF. PUNTOS</th>
              </tr>
            </thead>
            <tbody>
              ${renderPlayerMatchRow(match.p1, mIdx, 'p1', diff1, p1Pen, allPlayerOptions, match.team1)}
              ${renderPlayerMatchRow(match.p2, mIdx, 'p2', diff2, p2Pen, allPlayerOptions, match.team2)}
            </tbody>
          </table>
        </div>
        ${
          err1 || err2
            ? `<div class="delay-error-banner">
                <span>⚠️ <strong>ERROR DE REGLAMENTO:</strong> Un jugador con atraso <strong>&gt; 20 min</strong> debe marcar obligatoriamente <strong>Abandono Partida</strong>.</span>
              </div>`
            : ''
        }
      `;

      container.appendChild(card);
    });

    bindMatchCardEvents(container, currentRoundObj);
    updateVotingControlUI();
  }

  const openPenaltyMenus = new Set();

  function renderPlayerMatchRow(pObj, mIdx, side, diff, totalPen, allPlayerOptions, teamName) {
    const optionsHtml = allPlayerOptions
      .map(
        (name) =>
          `<option value="${escapeHtml(name)}" ${pObj.name === name ? 'selected' : ''}>${escapeHtml(
            name
          )}</option>`
      )
      .join('');

    const extraOption =
      pObj.name && !allPlayerOptions.includes(pObj.name)
        ? `<option value="${escapeHtml(pObj.name)}" selected>${escapeHtml(pObj.name)}</option>`
        : '';

    const diffClass = diff > 0 ? 'pos' : diff < 0 ? 'neg' : 'zero';
    const diffStr = diff > 0 ? `+${diff}` : String(diff);

    const menuKey = `${state.activeRound}_${mIdx}_${side}`;
    const isMenuOpen = openPenaltyMenus.has(menuKey);

    const incidentTags = [];
    if (totalPen < 0) incidentTags.push(`${totalPen} pt`);
    if (pObj.surrender) incidentTags.push('Rend.');
    if (pObj.abandonMatch) incidentTags.push('Ab.Part.');
    if (pObj.abandonTournament) incidentTags.push('Ab.Torn.');
    const hasIncident = incidentTags.length > 0;
    const toggleLabel = hasIncident ? `⚠️ ${incidentTags.join(' • ')}` : 'Penaliz.';
    const playerArmy = getEntityArmy(pObj.name);

    return `
      <tr>
        <td class="text-left">
          ${teamName ? `<span class="team-tag-small">${escapeHtml(teamName)}</span><br/>` : ''}
          <select class="player-select" data-m-idx="${mIdx}" data-side="${side}" data-field="name">
            ${extraOption}
            ${optionsHtml}
          </select>
          ${playerArmy ? `<br/><span class="player-army-sub">🛡️ ${escapeHtml(playerArmy)}</span>` : ''}
        </td>
        <td>
          <div class="result-btn-group">
            <button type="button" class="res-pill ${pObj.result === 'V' ? 'active-V' : ''}" data-m-idx="${mIdx}" data-side="${side}" data-res="V">V</button>
            <button type="button" class="res-pill ${pObj.result === 'E' ? 'active-E' : ''}" data-m-idx="${mIdx}" data-side="${side}" data-res="E">E</button>
            <button type="button" class="res-pill ${pObj.result === 'D' ? 'active-D' : ''}" data-m-idx="${mIdx}" data-side="${side}" data-res="D">D</button>
          </div>
        </td>
        <td>
          <input type="number" class="num-input-sm" value="${pObj.tp}" data-m-idx="${mIdx}" data-side="${side}" data-field="tp" />
        </td>
        <td>
          <input type="number" class="num-input-sm" value="${pObj.vp}" min="0" max="100" data-m-idx="${mIdx}" data-side="${side}" data-field="vp" />
        </td>
        <td class="diff-cell-with-menu">
          <div class="diff-and-trigger-wrap">
            <span class="diff-badge ${diffClass}">${diffStr}</span>
            <button type="button" class="penalty-drawer-toggle ${hasIncident ? 'has-incident' : ''} ${isMenuOpen ? 'open' : ''}" data-toggle-pen-menu="${menuKey}" title="Desplegar menú de Pintura, Atraso, Penalización y Abandono">
              <span>${escapeHtml(toggleLabel)}</span>
              <span class="drawer-chevron">${isMenuOpen ? '◂' : '▸'}</span>
            </button>
            ${
              isMenuOpen
                ? `<div class="penalty-side-drawer">
                    <div class="penalty-drawer-item">
                      <span class="penalty-drawer-label">PINTURA S/N</span>
                      <select class="mini-select" data-m-idx="${mIdx}" data-side="${side}" data-field="paint">
                        <option value="" ${pObj.paint === '' ? 'selected' : ''}>-</option>
                        <option value="s" ${pObj.paint === 's' ? 'selected' : ''}>Sí (0)</option>
                        <option value="n" ${pObj.paint === 'n' ? 'selected' : ''}>No (${state.mode === 'teams' ? '-2' : '-1'})</option>
                      </select>
                    </div>
                    <div class="penalty-drawer-item">
                      <span class="penalty-drawer-label">ATRASO</span>
                      <select class="mini-select" data-m-idx="${mIdx}" data-side="${side}" data-field="delay">
                        <option value="N/A" ${pObj.delay === 'N/A' ? 'selected' : ''}>N/A</option>
                        <option value="< 10 min" ${pObj.delay === '< 10 min' ? 'selected' : ''}>&lt; 10 min</option>
                        <option value="10 - 20 min" ${pObj.delay === '10 - 20 min' ? 'selected' : ''}>10 - 20 min (-1)</option>
                        <option value="> 20 min" ${pObj.delay === '> 20 min' ? 'selected' : ''}>&gt; 20 min (-1)</option>
                      </select>
                    </div>
                    <div class="penalty-drawer-item">
                      <span class="penalty-drawer-label">PENALIZ.</span>
                      <span class="penalty-badge ${totalPen < 0 ? 'negative' : ''}">${totalPen}</span>
                    </div>
                    <div class="penalty-drawer-item">
                      <span class="penalty-drawer-label">RENDICIÓN</span>
                      <input type="checkbox" ${pObj.surrender ? 'checked' : ''} data-m-idx="${mIdx}" data-side="${side}" data-field="surrender" title="Rendición S/N" />
                    </div>
                    <div class="penalty-drawer-item">
                      <span class="penalty-drawer-label">AB. PARTIDA</span>
                      <input type="checkbox" ${pObj.abandonMatch ? 'checked' : ''} data-m-idx="${mIdx}" data-side="${side}" data-field="abandonMatch" title="Abandono de Partida S/N" />
                    </div>
                    <div class="penalty-drawer-item">
                      <span class="penalty-drawer-label">AB. TORNEO</span>
                      <input type="checkbox" ${pObj.abandonTournament ? 'checked' : ''} data-m-idx="${mIdx}" data-side="${side}" data-field="abandonTournament" title="Abandono del Torneo S/N" />
                    </div>
                  </div>`
                : ''
            }
          </div>
        </td>
      </tr>
    `;
  }

  function triggerSeatingAlertNotification(roundNum, tableName, myName, oppName) {
    playTimerAlertSound();
    try {
      if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
        navigator.vibrate([220, 100, 220]);
      }
    } catch (e) {
      // Ignorar si el navegador bloquea vibración
    }
    if (!isAdminMode) {
      const roundsView = document.getElementById('view-rounds');
      if (roundsView && !roundsView.classList.contains('active')) {
        switchTab('rounds');
      }
    }
    showToast(`⚔️ ¡Ronda ${roundNum} emparejada! (${myName}) → ${tableName} vs ${oppName}`);
  }

  function renderPlayerSeatingHeroCard(currentRoundObj) {
    const slot = document.getElementById('playerSeatingHeroSlot');
    if (!slot) return;

    const myId = getMyPlayerIdentity(state.roomCode);

    if (!myId.name) {
      if (state.tournamentFinished) {
        slot.innerHTML = '';
        return;
      }

      slot.innerHTML = `
        <div class="seating-hero-card">
          <div class="seating-hero-top" style="margin-bottom:10px; padding-bottom:8px;">
            <span class="seating-eyebrow">🔔 TU ASIENTO EN ESTA RONDA</span>
            <span class="seating-record-pill">Ronda Activa: ${state.activeRound}</span>
          </div>
          <div style="display:flex; align-items:center; justify-content:space-between; gap:12px; flex-wrap:wrap;">
            <span class="helper-caption" style="flex:1; min-width:220px;">
              Inscríbete como participante en este dispositivo para ver en gigante tu <strong>Mesa Asignada</strong>, tu <strong>Rival</strong>, reportar resultados de tu mesa y recibir la alerta sonora de cada ronda.
            </span>
            <button type="button" class="btn-gold-cta btn-sm" id="btnOpenRegFromSeatingCard">
              🪖 Inscribirme en Sala
            </button>
          </div>
        </div>
      `;

      document.getElementById('btnOpenRegFromSeatingCard')?.addEventListener('click', () => {
        openPlayerRegistrationModal();
      });
      return;
    }

    const standings = calculateStandings();
    const myStandIdx = standings.findIndex((s) => isPlayerInEntity(s.name, myId.name));
    const myStand = myStandIdx !== -1 ? standings[myStandIdx] : null;
    const myRank = myStandIdx !== -1 ? myStandIdx + 1 : '-';
    const myTp = myStand ? myStand.finalTp : 0;
    const myDiff = myStand ? (myStand.vpDiff > 0 ? `+${myStand.vpDiff}` : String(myStand.vpDiff)) : '0';
    const myVp = myStand ? myStand.vpFavor : 0;
    const iAmDropped = isEntityDropped(myId.name);

    const matches = (currentRoundObj && currentRoundObj.matches) || [];
    const myMatchIdx = matches.findIndex((m) => isMatchMine(m));

    if (myMatchIdx === -1) {
      slot.innerHTML = `
        <div class="seating-hero-card">
          <div class="seating-hero-top" style="margin-bottom:8px; padding-bottom:8px;">
            <span class="seating-eyebrow">🪖 JUGADOR IDENTIFICADO: ${escapeHtml(myId.name)} ${
        myId.army ? `• 🛡️ ${escapeHtml(myId.army)}` : ''
      }</span>
            <span class="seating-record-pill">Posición: #${myRank}° • ${myTp} PT • Dif ${myDiff} • ${myVp} PV</span>
          </div>
          <div class="seating-actions-bar" style="border-top:none; padding-top:4px;">
            <span class="helper-caption">
              ${
                iAmDropped
                  ? '🏳️ <strong>Te has retirado (Drop)</strong> para las siguientes rondas. Tus puntos siguen registrados en el Podio.'
                  : `⏳ Aún no tienes mesa asignada en la Ronda ${state.activeRound}. Cuando el Organizador empareje la ronda aparecerá aquí tu mesa y rival.`
              }
            </span>
            ${
              !state.tournamentFinished
                ? `<button type="button" class="btn-elven-outline btn-sm btn-drop-player ${
                    iAmDropped ? 'is-dropped' : ''
                  }" id="btnToggleMyDropHero">
                    ${iAmDropped ? '↺ Cancelar Drop y Seguir Jugando' : '🏳️ Retirarme para Siguiente Ronda (Drop)'}
                  </button>`
                : ''
            }
          </div>
        </div>
      `;
      document.getElementById('btnToggleMyDropHero')?.addEventListener('click', toggleMyDropStatusFlow);
      return;
    }

    const myMatch = matches[myMatchIdx];
    const iAmP1 =
      isPlayerInEntity(myMatch.p1.name, myId.name) ||
      (state.mode === 'teams' && isPlayerInEntity(myMatch.team1, myId.name));
    const mySide = iAmP1 ? myMatch.p1 : myMatch.p2;
    const oppSide = iAmP1 ? myMatch.p2 : myMatch.p1;
    const myArmy = getEntityArmy(mySide.name) || myId.army;
    const oppArmy = getEntityArmy(oppSide.name);

    // Notificación sonora y visual automática cuando el Organizador publica el asiento de la ronda (Seatings Alert)
    const seatingKey = `${state.roomCode}_R${currentRoundObj.round}_${myMatch.table}_${mySide.name}_${oppSide.name}`;
    if (lastNotifiedSeatingKey !== seatingKey) {
      lastNotifiedSeatingKey = seatingKey;
      triggerSeatingAlertNotification(currentRoundObj.round, myMatch.table, mySide.name, oppSide.name);
    }

    const hasResult = Boolean(mySide.result && oppSide.result);
    const canReport =
      !currentRoundObj.finished &&
      !state.tournamentFinished &&
      myMatch.p1.name !== 'BYE' &&
      myMatch.p2.name !== 'BYE';

    slot.innerHTML = `
      <div class="seating-hero-card">
        <div class="seating-hero-top">
          <span class="seating-eyebrow">🔔 TU ASIENTO EN LA RONDA ${currentRoundObj.round}</span>
          <div style="display:flex; align-items:center; gap:8px; flex-wrap:wrap;">
            <span class="seating-record-pill">🏆 Lugar Actual: #${myRank}° • ${myTp} PT • Dif ${myDiff} • ${myVp} PV</span>
            <button type="button" class="btn-elven-outline btn-xs" id="btnTestSeatingAlertHero" title="Sonar alerta de asiento">
              🔔 Alerta
            </button>
          </div>
        </div>

        <div class="seating-hero-main">
          <div class="seating-table-box">
            <span class="seating-table-label">MESA ASIGNADA</span>
            <strong class="seating-table-number">${escapeHtml(myMatch.table)}</strong>
            ${
              hasResult
                ? `<span class="seating-score-summary">✓ Resultado Cargado</span>`
                : `<span class="helper-caption" style="margin-top:2px;">En juego</span>`
            }
          </div>

          <div class="seating-versus-grid">
            <div class="seating-combatant">
              <span class="seating-role-tag">🪖 TU BANDO</span>
              <strong class="seating-player-name">${escapeHtml(mySide.name)}</strong>
              ${myArmy ? `<div><span class="player-army-sub">🛡️ ${escapeHtml(myArmy)}</span></div>` : ''}
              ${
                hasResult
                  ? `<span class="seating-score-summary">${escapeHtml(mySide.result)} • ${mySide.tp} PT • ${mySide.vp} PV</span>`
                  : ''
              }
            </div>

            <div class="seating-vs-badge">VS</div>

            <div class="seating-combatant is-opponent">
              <span class="seating-role-tag">⚔️ TU RIVAL</span>
              <strong class="seating-player-name">${escapeHtml(oppSide.name)}</strong>
              ${oppArmy ? `<div><span class="player-army-sub">🛡️ ${escapeHtml(oppArmy)}</span></div>` : ''}
              ${
                hasResult
                  ? `<span class="seating-score-summary">${escapeHtml(oppSide.result)} • ${oppSide.tp} PT • ${oppSide.vp} PV</span>`
                  : ''
              }
            </div>
          </div>
        </div>

        <div class="seating-actions-bar">
          <div style="display:flex; align-items:center; gap:10px; flex-wrap:wrap;">
            ${
              canReport
                ? `<button type="button" class="btn-gold-cta btn-sm" id="btnOpenMyMatchReportHero">
                    📲 ${hasResult ? 'Editar Resultado de Mi Mesa' : 'Reportar Resultado de Mi Mesa'}
                  </button>`
                : ''
            }
            ${
              myMatch.reportedBy
                ? `<span class="match-reported-pill">📲 Reportado por ${escapeHtml(myMatch.reportedBy)}</span>`
                : ''
            }
            ${iAmDropped ? `<span class="drop-pill-tag">🏳️ Retirado para próxima ronda (Drop)</span>` : ''}
          </div>

          ${
            !state.tournamentFinished
              ? `<button type="button" class="btn-elven-outline btn-sm btn-drop-player ${
                  iAmDropped ? 'is-dropped' : ''
                }" id="btnToggleMyDropHero">
                  ${iAmDropped ? '↺ Cancelar Drop y Seguir Jugando' : '🏳️ Retirarme para Siguiente Ronda (Drop)'}
                </button>`
              : ''
          }
        </div>
      </div>
    `;

    document.getElementById('btnOpenMyMatchReportHero')?.addEventListener('click', () => {
      openPlayerMatchReportModal(currentRoundObj.round, myMatchIdx);
    });
    document.getElementById('btnToggleMyDropHero')?.addEventListener('click', toggleMyDropStatusFlow);
    document.getElementById('btnTestSeatingAlertHero')?.addEventListener('click', () => {
      triggerSeatingAlertNotification(currentRoundObj.round, myMatch.table, mySide.name, oppSide.name);
    });
  }

  function openPlayerMatchReportModal(roundNum, mIdx) {
    if (state.tournamentFinished) {
      showToast('🔒 El torneo ya fue finalizado oficialmente.');
      return;
    }
    const rObj = (state.rounds || []).find((r) => Number(r.round) === Number(roundNum));
    if (!rObj || rObj.finished || !rObj.matches || !rObj.matches[mIdx]) {
      showToast('🔒 Esta ronda ya fue cerrada por el Organizador.');
      return;
    }

    const match = rObj.matches[mIdx];
    const p1Army = getEntityArmy(match.p1.name);
    const p2Army = getEntityArmy(match.p2.name);

    openModal(
      `📲 Reportar Resultado — Ronda ${roundNum} • ${match.table}`,
      `
        <p style="margin-bottom:14px; color:var(--text-parchment);">
          Ingresa los <strong>Puntos de Victoria de Escenario (PV)</strong> obtenidos por cada jugador en <strong>${escapeHtml(
            match.table
          )}</strong>. Los Puntos de Torneo (PT) se calcularán automáticamente y se enviarán en vivo al Organizador.
        </p>

        <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(210px, 1fr)); gap:12px; margin-bottom:14px;">
          <div style="background:rgba(12,24,21,0.92); border:1px solid var(--border-gold); border-radius:12px; padding:12px;">
            <strong style="color:var(--gold-bright); font-family:var(--font-serif); font-size:0.95rem; display:block;">
              1. ${escapeHtml(match.p1.name)}
            </strong>
            ${p1Army ? `<span class="player-army-sub" style="margin-bottom:8px;">🛡️ ${escapeHtml(p1Army)}</span>` : ''}
            <div class="field-group" style="margin-top:8px;">
              <label for="inputReportP1Vp">PV de Escenario logrados</label>
              <input type="number" id="inputReportP1Vp" min="0" max="100" value="${Number(
                match.p1.vp || 0
              )}" style="font-size:1.1rem; font-weight:800; text-align:center;" />
            </div>
            <label style="display:inline-flex; align-items:center; gap:6px; margin-top:8px; font-size:0.78rem; color:var(--text-cream); cursor:pointer;">
              <input type="checkbox" id="checkReportP1Surrender" ${match.p1.surrender ? 'checked' : ''} />
              <span>¿Se rindió en la partida?</span>
            </label>
          </div>

          <div style="background:rgba(12,24,21,0.92); border:1px solid var(--border-gold); border-radius:12px; padding:12px;">
            <strong style="color:var(--gold-bright); font-family:var(--font-serif); font-size:0.95rem; display:block;">
              2. ${escapeHtml(match.p2.name)}
            </strong>
            ${p2Army ? `<span class="player-army-sub" style="margin-bottom:8px;">🛡️ ${escapeHtml(p2Army)}</span>` : ''}
            <div class="field-group" style="margin-top:8px;">
              <label for="inputReportP2Vp">PV de Escenario logrados</label>
              <input type="number" id="inputReportP2Vp" min="0" max="100" value="${Number(
                match.p2.vp || 0
              )}" style="font-size:1.1rem; font-weight:800; text-align:center;" />
            </div>
            <label style="display:inline-flex; align-items:center; gap:6px; margin-top:8px; font-size:0.78rem; color:var(--text-cream); cursor:pointer;">
              <input type="checkbox" id="checkReportP2Surrender" ${match.p2.surrender ? 'checked' : ''} />
              <span>¿Se rindió en la partida?</span>
            </label>
          </div>
        </div>

        <div id="liveMatchReportPreview" style="background:rgba(9,17,15,0.88); border:1px solid rgba(89,207,153,0.45); border-radius:10px; padding:10px 14px; margin-bottom:16px; text-align:center; font-size:0.84rem; color:var(--text-ivory);"></div>

        <div class="modal-confirm-actions">
          <button type="button" class="btn-elven-outline" id="btnCancelMatchReportModal">Cancelar</button>
          <button type="button" class="btn-gold-cta" id="btnSubmitMatchReportModal">📲 Enviar Resultado de Mesa</button>
        </div>
      `
    );

    const inpP1 = document.getElementById('inputReportP1Vp');
    const inpP2 = document.getElementById('inputReportP2Vp');
    const chkP1 = document.getElementById('checkReportP1Surrender');
    const chkP2 = document.getElementById('checkReportP2Surrender');
    const previewEl = document.getElementById('liveMatchReportPreview');

    function updatePreview() {
      const tempMatch = {
        p1: {
          name: match.p1.name,
          vp: Math.max(0, Math.min(100, Number(inpP1?.value || 0))),
          surrender: !!chkP1?.checked,
          abandonMatch: false,
          abandonTournament: false,
          result: '',
          tp: 0,
          manualTp: false
        },
        p2: {
          name: match.p2.name,
          vp: Math.max(0, Math.min(100, Number(inpP2?.value || 0))),
          surrender: !!chkP2?.checked,
          abandonMatch: false,
          abandonTournament: false,
          result: '',
          tp: 0,
          manualTp: false
        }
      };
      recalculateMatch(tempMatch, tempMatch.p1.surrender || tempMatch.p2.surrender ? 'forfeit' : 'vp');
      if (previewEl) {
        previewEl.innerHTML = `
          ⚔️ <strong>Resultado Calculado:</strong>
          <strong style="color:var(--gold-bright);">${escapeHtml(tempMatch.p1.name)}</strong> (${tempMatch.p1.result} • <strong>${tempMatch.p1.tp} PT</strong> • ${tempMatch.p1.vp} PV)
          &nbsp;vs&nbsp;
          <strong style="color:var(--gold-bright);">${escapeHtml(tempMatch.p2.name)}</strong> (${tempMatch.p2.result} • <strong>${tempMatch.p2.tp} PT</strong> • ${tempMatch.p2.vp} PV)
        `;
      }
    }

    updatePreview();
    [inpP1, inpP2, chkP1, chkP2].forEach((el) => {
      el?.addEventListener('input', updatePreview);
      el?.addEventListener('change', updatePreview);
    });

    document.getElementById('btnCancelMatchReportModal')?.addEventListener('click', closeModal);
    document.getElementById('btnSubmitMatchReportModal')?.addEventListener('click', async () => {
      const btnSubmit = document.getElementById('btnSubmitMatchReportModal');
      if (btnSubmit) {
        btnSubmit.disabled = true;
        btnSubmit.textContent = '⏳ Enviando resultado...';
      }

      const ok = await submitPlayerMatchReportToCloud(
        roundNum,
        mIdx,
        Number(inpP1?.value || 0),
        Number(inpP2?.value || 0),
        !!chkP1?.checked,
        !!chkP2?.checked
      );

      if (!ok) {
        if (btnSubmit) {
          btnSubmit.disabled = false;
          btnSubmit.textContent = '📲 Enviar Resultado de Mesa';
        }
        showToast('⚠️ Error de conexión al enviar el resultado. Intenta nuevamente.');
        return;
      }

      closeModal();
      renderAll();
      showToast(`✅ ¡Resultado de ${match.table} enviado y actualizado en vivo!`);
    });
  }

  function toggleMyDropStatusFlow() {
    if (state.tournamentFinished) {
      showToast('🔒 El torneo ya ha finalizado.');
      return;
    }
    const myId = getMyPlayerIdentity(state.roomCode);
    if (!myId.name) {
      showToast('⚠️ Primero debes identificarte como jugador en la sala.');
      return;
    }

    const currentlyDropped = isEntityDropped(myId.name);
    if (!currentlyDropped) {
      openConfirmModal(
        '🏳️ Retirarse para la Siguiente Ronda (Drop)',
        `¿Confirmas que deseas retirarte (Drop) del torneo después de esta ronda? Conservarás todos tus Puntos de Torneo y PV acumulados en la tabla del Podio, pero el sistema suizo ya no te asignará mesa en la próxima ronda.`,
        '🏳️ Sí, Confirmar Drop',
        async () => {
          const ok = await submitPlayerDropStatusToCloud(myId.name, true, state.roomCode);
          if (ok) {
            renderAll();
            showToast(`🏳️ "${myId.name}" marcado como Retirado (Drop) para la siguiente ronda.`);
          } else {
            showToast('⚠️ Error de conexión al registrar el Drop. Intenta nuevamente.');
          }
        }
      );
    } else {
      openConfirmModal(
        '↺ Cancelar Drop y Seguir Jugando',
        `¿Deseas reactivar tu participación como "${myId.name}" para volver a ser emparejado en la siguiente ronda?`,
        '↺ Sí, Volver al Torneo',
        async () => {
          const ok = await submitPlayerDropStatusToCloud(myId.name, false, state.roomCode);
          if (ok) {
            renderAll();
            showToast(`✅ "${myId.name}" reactivado en el torneo.`);
          } else {
            showToast('⚠️ Error de conexión al reactivar. Intenta nuevamente.');
          }
        }
      );
    }
  }

  function bindMatchCardEvents(container, currentRoundObj) {
    container.querySelectorAll('button[data-report-match-idx]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        const mIdx = Number(e.currentTarget.dataset.reportMatchIdx);
        openPlayerMatchReportModal(currentRoundObj.round, mIdx);
      });
    });

    container.querySelectorAll('button[data-toggle-pen-menu]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        const key = e.currentTarget.dataset.togglePenMenu;
        if (!key) return;
        if (openPenaltyMenus.has(key)) {
          openPenaltyMenus.delete(key);
        } else {
          openPenaltyMenus.add(key);
        }
        renderRoundsView();
      });
    });

    container.querySelectorAll('.res-pill').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        const mIdx = Number(e.currentTarget.dataset.mIdx);
        const side = e.currentTarget.dataset.side;
        const res = e.currentTarget.dataset.res;
        const otherSide = side === 'p1' ? 'p2' : 'p1';
        const match = currentRoundObj.matches[mIdx];

        match[side].result = res;
        match[side].manualTp = false;
        match[otherSide].manualTp = false;

        if (res === 'V') match[otherSide].result = 'D';
        else if (res === 'D') match[otherSide].result = 'V';
        else if (res === 'E') match[otherSide].result = 'E';

        recalculateMatch(match, 'result');
        match.lastAppliedReportAt = Date.now();
        saveState();
        renderRoundsView();
        renderSidebarStatus();
      });
    });

    container.querySelectorAll('input[data-field], select[data-field]').forEach((el) => {
      el.addEventListener('change', (e) => {
        const mIdx = Number(e.target.dataset.mIdx);
        const field = e.target.dataset.field;
        const side = e.target.dataset.side;
        const match = currentRoundObj.matches[mIdx];

        if (field === 'table') {
          match.table = e.target.value;
        } else if (side) {
          const pObj = match[side];
          if (field === 'surrender' || field === 'abandonMatch' || field === 'abandonTournament') {
            pObj[field] = e.target.checked;
            recalculateMatch(match, 'forfeit');
          } else if (field === 'vp') {
            pObj.vp = Number(e.target.value || 0);
            recalculateMatch(match, 'vp');
          } else if (field === 'tp') {
            pObj.tp = Number(e.target.value || 0);
            pObj.manualTp = true;
          } else {
            pObj[field] = e.target.value;
            recalculateMatch(match, 'meta');
          }
        }

        match.lastAppliedReportAt = Date.now();
        saveState();
        renderRoundsView();
        renderSidebarStatus();
      });
    });

    container.querySelectorAll('button[data-delete-match]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        const mIdx = Number(e.currentTarget.dataset.deleteMatch);
        currentRoundObj.matches.splice(mIdx, 1);
        saveState();
        renderRoundsView();
      });
    });
  }

  function renderTeamClashesPanel(currentRoundObj) {
    const container = document.getElementById('teamPairingsContainer');
    container.innerHTML = '';

    if (!currentRoundObj.teamClashes || currentRoundObj.teamClashes.length === 0) {
      const numClashes = Math.floor(state.teams.length / 2);
      currentRoundObj.teamClashes = [];
      for (let i = 0; i < numClashes; i++) {
        const t1 = state.teams[2 * i] ? state.teams[2 * i].name : '';
        const t2 = state.teams[2 * i + 1] ? state.teams[2 * i + 1].name : '';
        const gName = state.tableGroups[i] ? state.tableGroups[i].name : '';
        currentRoundObj.teamClashes.push({
          team1: t1,
          color1: 'Rojo',
          team2: t2,
          color2: 'Azul',
          tableGroup: gName,
          pairings: Array.from({ length: state.membersPerTeam }, (_, k) => ({
            m1: state.teams[2 * i]?.members[k] || '',
            m2: state.teams[2 * i + 1]?.members[k] || '',
            table: state.tableGroups[i]?.tables[k] || `Mesa ${i * state.membersPerTeam + k + 1}`
          }))
        });
      }
    }

    let whiteCount = 0;
    currentRoundObj.teamClashes.forEach((clash, cIdx) => {
      if (clash.color1 === 'blanco') whiteCount++;

      const teamOpts1 = state.teams
        .map((t) => `<option value="${escapeHtml(t.name)}" ${t.name === clash.team1 ? 'selected' : ''}>${escapeHtml(t.name)}</option>`)
        .join('');
      const teamOpts2 = state.teams
        .map((t) => `<option value="${escapeHtml(t.name)}" ${t.name === clash.team2 ? 'selected' : ''}>${escapeHtml(t.name)}</option>`)
        .join('');
      const groupOpts = state.tableGroups
        .map((g) => `<option value="${escapeHtml(g.name)}" ${g.name === clash.tableGroup ? 'selected' : ''}>${escapeHtml(g.name)}</option>`)
        .join('');

      const card = document.createElement('div');
      card.className = 'team-clash-card';
      card.innerHTML = `
        <div class="team-clash-top">
          <div>
            <span class="stat-label">EQUIPO 1</span>
            <div style="display:flex; gap:8px; align-items:center;">
              <select class="team-clash-select" data-c-idx="${cIdx}" data-field="team1">${teamOpts1}</select>
              <span class="team-color-badge color-${clash.color1}">${clash.color1}</span>
            </div>
          </div>
          <strong style="font-family:var(--font-serif); color:var(--gold-primary);">V/S</strong>
          <div>
            <span class="stat-label">EQUIPO 2</span>
            <div style="display:flex; gap:8px; align-items:center;">
              <select class="team-clash-select" data-c-idx="${cIdx}" data-field="team2">${teamOpts2}</select>
              <span class="team-color-badge color-${clash.color2}">${clash.color2}</span>
            </div>
          </div>
          <div>
            <span class="stat-label">GRUPO DE MESAS</span>
            <select class="team-clash-select" data-c-idx="${cIdx}" data-field="tableGroup">${groupOpts}</select>
          </div>
        </div>
        <div class="helper-caption">Al presionar "Volcar Mesas de Integrantes" se generan las tarjetas de enfrentamiento inferiores.</div>
      `;
      container.appendChild(card);
    });

    const alertEl = document.getElementById('teamColorAlertCaption');
    if (whiteCount > 0) {
      alertEl.innerHTML = `⚠️ <strong>Alerta (${whiteCount}):</strong> Existen equipos empatados en los criterios del podio (color "blanco"). Asígnalos o usa el botón de Colores.`;
      alertEl.style.color = '#ffb8b5';
    } else {
      alertEl.textContent =
        'Equipos listos. Puedes sortear colores/grupos de mesa y presionar "Volcar Mesas de Integrantes".';
      alertEl.style.color = '';
    }

    container.querySelectorAll('.team-clash-select').forEach((sel) => {
      sel.addEventListener('change', (e) => {
        const cIdx = Number(e.target.dataset.cIdx);
        const field = e.target.dataset.field;
        const clash = currentRoundObj.teamClashes[cIdx];
        clash[field] = e.target.value;
        saveState();
        renderTeamClashesPanel(currentRoundObj);
      });
    });
  }

  // =========================================================================
  // 5. RENDERIZADO DEL PODIO, RECONOCIMIENTOS ESPECIALES Y RESUMEN
  // =========================================================================

  function calculateSpecialAwards(standings) {
    const list = standings || calculateStandings();

    // 1. General Más Letal: mayor cantidad de PV a Favor acumulados (desempate por Dif. PV y PT Final)
    const lethalCandidates = [...list].filter((row) => !row.abandoned && Number(row.vpFavor) > 0);
    lethalCandidates.sort((a, b) => {
      if (b.vpFavor !== a.vpFavor) return b.vpFavor - a.vpFavor;
      if (b.vpDiff !== a.vpDiff) return b.vpDiff - a.vpDiff;
      return b.finalTp - a.finalTp;
    });
    const lethalGeneral = lethalCandidates[0] || null;

    // 2. Votación de Mejor Pintura y Premio Fair Play (con validación de participantes reales y anti-autovoto)
    const paintCounts = Object.create(null);
    const fairPlayCounts = Object.create(null);
    let totalPaintVotes = 0;
    let totalFairPlayVotes = 0;

    const validCandidatesSet = new Set(list.map((row) => String(row.name).trim()));
    const validVotersSet = new Set([
      ...validCandidatesSet,
      ...getRegisteredPlayersList().map((r) => String(r.name).trim())
    ]);

    function isSelfVoteTarget(candidateName, voterName) {
      if (!candidateName || !voterName) return true;
      const cLower = candidateName.toLowerCase();
      const vLower = voterName.toLowerCase();
      if (cLower === vLower) return true;
      const parts = cLower.split(/\s*[&+/]\s*|\s+y\s+/i).map((s) => s.trim());
      return parts.includes(vLower);
    }

    const votesMap = state.votes && typeof state.votes === 'object' ? state.votes : {};
    Object.values(votesMap).forEach((v) => {
      if (!v || typeof v !== 'object') return;
      const voterName = sanitizeTextField(v.voter, 44);
      const rawPaint = sanitizeTextField(v.paintVote || v.paint, 44);
      const rawFair = sanitizeTextField(v.fairPlayVote || v.fairPlay, 44);

      if (!voterName || (validVotersSet.size > 0 && !validVotersSet.has(voterName))) return;

      if (rawPaint && validCandidatesSet.has(rawPaint) && !isSelfVoteTarget(rawPaint, voterName)) {
        paintCounts[rawPaint] = (paintCounts[rawPaint] || 0) + 1;
        totalPaintVotes++;
      }
      if (rawFair && validCandidatesSet.has(rawFair) && !isSelfVoteTarget(rawFair, voterName)) {
        fairPlayCounts[rawFair] = (fairPlayCounts[rawFair] || 0) + 1;
        totalFairPlayVotes++;
      }
    });

    function getTopVoted(countsMap, total) {
      const entries = Object.entries(countsMap);
      if (entries.length === 0) return null;
      entries.sort((a, b) => b[1] - a[1]);
      return {
        name: entries[0][0],
        votes: entries[0][1],
        totalVotes: total
      };
    }

    return {
      lethalGeneral,
      bestPaint: getTopVoted(paintCounts, totalPaintVotes),
      bestFairPlay: getTopVoted(fairPlayCounts, totalFairPlayVotes),
      totalVoters: Object.keys(votesMap).length
    };
  }

  let lastAutoPromptedVotingKey = '';

  function updateVotingControlUI() {
    const paintOpen = !!state.votingPaintOpen;
    const fairOpen = !!state.votingFairPlayOpen;
    const anyOpen = paintOpen || fairOpen;

    ['btnLaunchPaintVotingRounds', 'btnLaunchPaintVotingPodium'].forEach((id) => {
      const btn = document.getElementById(id);
      if (!btn) return;
      btn.textContent = paintOpen ? '🎨 Cerrar Votación Pintura (Activa)' : '🎨 Lanzar Votación Pintura';
      btn.classList.toggle('btn-voting-active', paintOpen);
    });

    ['btnLaunchFairPlayVotingRounds', 'btnLaunchFairPlayVotingPodium'].forEach((id) => {
      const btn = document.getElementById(id);
      if (!btn) return;
      btn.textContent = fairOpen ? '🤝 Cerrar Votación Fair Play (Activa)' : '🤝 Lanzar Votación Fair Play';
      btn.classList.toggle('btn-voting-active', fairOpen);
    });

    const openBtnsLabel =
      paintOpen && fairOpen
        ? '🗳️ Votar Pintura y Fair Play'
        : paintOpen
        ? '🎨 Votar Mejor Pintura'
        : '🤝 Votar Premio Fair Play';

    ['btnOpenVotingFromRounds', 'btnOpenVotingModal'].forEach((id) => {
      const btn = document.getElementById(id);
      if (!btn) return;
      btn.textContent = openBtnsLabel;
      btn.classList.toggle('hidden', !anyOpen);
    });

    const bannerEl = document.getElementById('activeVotingBannerRounds');
    const bannerTxt = document.getElementById('activeVotingBannerText');
    if (bannerEl) {
      bannerEl.classList.toggle('hidden', !anyOpen);
      if (bannerTxt && anyOpen) {
        const cats = [paintOpen ? '🎨 Mejor Pintura' : '', fairOpen ? '🤝 Premio Fair Play' : '']
          .filter(Boolean)
          .join(' y ');
        bannerTxt.innerHTML = `🗳️ <strong>¡VOTACIÓN ABIERTA!</strong> El Organizador ha habilitado la votación para <strong>${cats}</strong>.`;
      }
    }

    // Si un Jugador está conectado y el Organizador lanza una votación, mostrar aviso/modal automáticamente
    if (!isAdminMode && anyOpen) {
      const currentKey = `${state.roomCode}_P${paintOpen ? 1 : 0}_F${fairOpen ? 1 : 0}`;
      if (lastAutoPromptedVotingKey !== currentKey) {
        lastAutoPromptedVotingKey = currentKey;
        const modalEl = document.getElementById('elvenModal');
        if (modalEl && modalEl.classList.contains('hidden')) {
          openSpecialVotingModal();
        }
      }
    } else if (!anyOpen) {
      lastAutoPromptedVotingKey = '';
    }
  }

  function toggleVotingCategory(category) {
    if (!isAdminMode) return;
    if (category === 'paint') {
      state.votingPaintOpen = !state.votingPaintOpen;
      saveState();
      updateVotingControlUI();
      renderPodiumView();
      showToast(
        state.votingPaintOpen
          ? '🎨 ¡Votación de Mejor Pintura lanzada! Ya aparece en la pantalla de todos los jugadores.'
          : '🔒 Votación de Mejor Pintura cerrada.'
      );
    } else if (category === 'fairPlay') {
      state.votingFairPlayOpen = !state.votingFairPlayOpen;
      saveState();
      updateVotingControlUI();
      renderPodiumView();
      showToast(
        state.votingFairPlayOpen
          ? '🤝 ¡Votación de Premio Fair Play lanzada! Ya aparece en la pantalla de todos los jugadores.'
          : '🔒 Votación de Premio Fair Play cerrada.'
      );
    }
  }

  function renderSpecialAwardsCards(optionalStandings) {
    const standings = optionalStandings || calculateStandings();
    const awards = calculateSpecialAwards(standings);
    const awardsShowcaseEl = document.getElementById('specialAwardsShowcase');
    if (awardsShowcaseEl) {
      awardsShowcaseEl.innerHTML = `
        <div class="special-award-card">
          <span class="award-badge-title">⚔️ GENERAL MÁS LETAL</span>
          <strong class="award-winner-name">${escapeHtml(awards.lethalGeneral ? awards.lethalGeneral.name : 'Por definir')}</strong>
          <span class="award-sub-detail">${
            awards.lethalGeneral
              ? `${awards.lethalGeneral.vpFavor} PV a favor (Dif: ${
                  awards.lethalGeneral.vpDiff > 0 ? '+' + awards.lethalGeneral.vpDiff : awards.lethalGeneral.vpDiff
                })`
              : 'Se calcula automáticamente según PV a favor'
          }</span>
        </div>

        <div class="special-award-card">
          <span class="award-badge-title">🎨 MEJOR PINTURA</span>
          <strong class="award-winner-name">${escapeHtml(awards.bestPaint ? awards.bestPaint.name : 'Sin votos aún')}</strong>
          <span class="award-sub-detail">${
            awards.bestPaint
              ? `${awards.bestPaint.votes} voto(s) de ${awards.bestPaint.totalVotes} emitido(s)`
              : state.votingPaintOpen
              ? '🟢 Votación abierta para los jugadores'
              : '⏳ Pendiente que el Organizador lance la votación'
          }</span>
        </div>

        <div class="special-award-card">
          <span class="award-badge-title">🤝 PREMIO FAIR PLAY</span>
          <strong class="award-winner-name">${escapeHtml(awards.bestFairPlay ? awards.bestFairPlay.name : 'Sin votos aún')}</strong>
          <span class="award-sub-detail">${
            awards.bestFairPlay
              ? `${awards.bestFairPlay.votes} voto(s) de ${awards.bestFairPlay.totalVotes} emitido(s)`
              : state.votingFairPlayOpen
              ? '🟢 Votación abierta para los jugadores'
              : '⏳ Pendiente que el Organizador lance la votación'
          }</span>
        </div>
      `;
    }
  }

  function renderPodiumView() {
    const standings = calculateStandings();
    document.getElementById('thPlayerOrTeam').textContent =
      state.mode === 'teams' ? 'EQUIPO' : 'JUGADOR';

    const finishedBanner = document.getElementById('tournamentFinishedBanner');
    if (finishedBanner) {
      finishedBanner.classList.toggle('hidden', !state.tournamentFinished);
    }
    const finishedBannerRounds = document.getElementById('tournamentFinishedBannerRounds');
    if (finishedBannerRounds) {
      finishedBannerRounds.classList.toggle('hidden', !state.tournamentFinished);
    }
    document.body.classList.toggle('tournament-closed-mode', !!state.tournamentFinished);

    updateVotingControlUI();
    renderSpecialAwardsCards(standings);

    const activePlayers = standings.filter((s) => !s.abandoned);
    const first = standings[0];
    const second = standings[1];
    const third = standings[2];
    const lastActive = activePlayers.length > 3 ? activePlayers[activePlayers.length - 1] : null;

    const topCardsEl = document.getElementById('podiumTopCards');
    topCardsEl.innerHTML = [
      first
        ? `<div class="medal-card gold-1">
            <span class="medal-rank" style="color:#ffd700;">🥇 1° LUGAR • CAMPEÓN</span>
            <strong class="medal-name">${escapeHtml(first.name)}</strong>
            ${
              getEntityArmy(first.name)
                ? `<div><span class="player-army-sub">🛡️ ${escapeHtml(getEntityArmy(first.name))}</span></div>`
                : ''
            }
            <div class="medal-metrics">
              <span><strong>${first.finalTp}</strong> PT</span>
              <span>Dif: <strong>${first.vpDiff > 0 ? '+' + first.vpDiff : first.vpDiff}</strong></span>
              <span>PV: <strong>${first.vpFavor}</strong></span>
            </div>
          </div>`
        : '',
      second
        ? `<div class="medal-card silver-2">
            <span class="medal-rank" style="color:#e0e0e0;">🥈 2° LUGAR • PLATA</span>
            <strong class="medal-name">${escapeHtml(second.name)}</strong>
            ${
              getEntityArmy(second.name)
                ? `<div><span class="player-army-sub">🛡️ ${escapeHtml(getEntityArmy(second.name))}</span></div>`
                : ''
            }
            <div class="medal-metrics">
              <span><strong>${second.finalTp}</strong> PT</span>
              <span>Dif: <strong>${second.vpDiff > 0 ? '+' + second.vpDiff : second.vpDiff}</strong></span>
              <span>PV: <strong>${second.vpFavor}</strong></span>
            </div>
          </div>`
        : '',
      third
        ? `<div class="medal-card bronze-3">
            <span class="medal-rank" style="color:#e89b54;">🥉 3° LUGAR • BRONCE</span>
            <strong class="medal-name">${escapeHtml(third.name)}</strong>
            ${
              getEntityArmy(third.name)
                ? `<div><span class="player-army-sub">🛡️ ${escapeHtml(getEntityArmy(third.name))}</span></div>`
                : ''
            }
            <div class="medal-metrics">
              <span><strong>${third.finalTp}</strong> PT</span>
              <span>Dif: <strong>${third.vpDiff > 0 ? '+' + third.vpDiff : third.vpDiff}</strong></span>
              <span>PV: <strong>${third.vpFavor}</strong></span>
            </div>
          </div>`
        : '',
      lastActive
        ? `<div class="medal-card spoon-last">
            <span class="medal-rank" style="color:#dba088;">🪵 ÚLTIMO LUGAR ACTIVO</span>
            <strong class="medal-name">${escapeHtml(lastActive.name)}</strong>
            ${
              getEntityArmy(lastActive.name)
                ? `<div><span class="player-army-sub">🛡️ ${escapeHtml(getEntityArmy(lastActive.name))}</span></div>`
                : ''
            }
            <div class="medal-metrics">
              <span><strong>${lastActive.finalTp}</strong> PT</span>
              <span>Dif: <strong>${lastActive.vpDiff}</strong></span>
              <span>PV: <strong>${lastActive.vpFavor}</strong></span>
            </div>
          </div>`
        : ''
    ].join('');

    // Tabla de posiciones (Podio)
    const tbody = document.getElementById('podiumTableBody');
    tbody.innerHTML = '';

    standings.forEach((row, idx) => {
      const pos = idx + 1;
      const isLastActive =
        !row.abandoned && lastActive && row.name === lastActive.name && pos > 3;

      let rowClass = '';
      if (pos === 1) rowClass = 'row-gold-1';
      else if (pos === 2) rowClass = 'row-silver-2';
      else if (pos === 3) rowClass = 'row-bronze-3';
      else if (isLastActive) rowClass = 'row-spoon-last';
      else if (row.abandoned) rowClass = 'row-abandoned';

      const armyLabel = getEntityArmy(row.name);
      const tr = document.createElement('tr');
      tr.className = rowClass;
      tr.innerHTML = `
        <td><strong>#${pos}</strong></td>
        <td>
          <strong>${escapeHtml(row.name)}</strong>
          ${armyLabel ? `<br/><span class="player-army-sub">🛡️ ${escapeHtml(armyLabel)}</span>` : ''}
        </td>
        <td class="text-center">${
          row.abandoned
            ? '<span class="penalty-badge negative">Abandonó</span>'
            : '<span style="color:var(--win-green); font-size:0.76rem;">Activo</span>'
        }</td>
        <td class="text-center">${row.grossTp}</td>
        <td class="text-center">${
          row.penalties < 0
            ? `<span class="penalty-badge negative">${row.penalties}</span>`
            : '0'
        }</td>
        <td class="text-center gold-col">${row.finalTp}</td>
        <td class="text-center">${row.vpDiff > 0 ? '+' + row.vpDiff : row.vpDiff}</td>
        <td class="text-center">${row.vpFavor}</td>
      `;
      tbody.appendChild(tr);
    });

    // Sábana detallada ronda por ronda
    const resHead = document.getElementById('resumenSheetHead');
    const resBody = document.getElementById('resumenSheetBody');
    let headHtml = `<tr><th>JUGADOR / EQUIPO</th><th class="text-center">PT FINAL</th><th class="text-center">DIF</th><th class="text-center">PV</th>`;
    for (let r = 1; r <= state.totalRounds; r++) {
      headHtml += `<th class="text-center">R${r} (RES / PT / PV / DIF)</th>`;
    }
    headHtml += `</tr>`;
    resHead.innerHTML = headHtml;

    resBody.innerHTML = standings
      .map((row) => {
        let cols = '';
        for (let r = 1; r <= state.totalRounds; r++) {
          const rs = row.perRound[r];
          if (!rs || !rs.played) {
            cols += `<td class="text-center" style="color:var(--text-muted);">-</td>`;
          } else {
            cols += `<td class="text-center"><strong>${rs.result || '-'}</strong> • ${rs.tp}pt • ${rs.vp}pv (${rs.diff >= 0 ? '+' + rs.diff : rs.diff})</td>`;
          }
        }
        return `
          <tr>
            <td><strong>${escapeHtml(row.name)}</strong></td>
            <td class="text-center gold-col">${row.finalTp}</td>
            <td class="text-center">${row.vpDiff}</td>
            <td class="text-center">${row.vpFavor}</td>
            ${cols}
          </tr>
        `;
      })
      .join('');
  }

  function renderAll() {
    renderSidebarStatus();
    renderSetupView();
    renderRoundsView();
    renderPodiumView();
  }

  function escapeHtml(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // =========================================================================
  // 6. CONTROLADORES DE BOTONES Y FLUJO DEL TORNEO
  // =========================================================================

  function initEventListeners() {
    // Navegación principal (CATEGORY cards)
    document.querySelectorAll('.category-card').forEach((btn) => {
      btn.addEventListener('click', () => {
        switchTab(btn.dataset.tab);
      });
    });

    document.getElementById('btnGoHome').addEventListener('click', () => {
      switchTab('setup');
    });

    document.getElementById('btnGoToPodiumFromSetup').addEventListener('click', () => {
      switchTab('podium');
    });

    // Selección de Modalidad (DIFFICULTY cards)
    document.querySelectorAll('#modalityGrid .difficulty-card').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.mode = btn.dataset.mode;
        saveState();
        renderAll();
      });
    });

    // Selección de Sistema de Puntos
    document.querySelectorAll('#scoringSystemGrid .difficulty-card').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.scoringSystem = btn.dataset.scoring;
        saveState();
        renderAll();
      });
    });

    // Parámetros de configuración
    document.getElementById('inputTournamentName').addEventListener('change', (e) => {
      state.tournamentName = e.target.value.trim() || 'Torneo MESBG';
      saveState();
      renderSidebarStatus();
    });

    document.getElementById('inputTotalRounds').addEventListener('change', (e) => {
      const val = Math.max(1, Math.min(12, Number(e.target.value) || 4));
      state.totalRounds = val;
      while (state.rounds.length < val) {
        state.rounds.push({
          round: state.rounds.length + 1,
          paired: false,
          finished: false,
          podiumUpdated: false,
          teamClashes: [],
          matches: []
        });
      }
      saveState();
      renderAll();
    });

    document.getElementById('inputTotalTables').addEventListener('change', (e) => {
      state.totalTables = Math.max(1, Number(e.target.value) || 6);
      state.tableGroups = createTableGroups(state.totalTables, state.tablesPerTeam);
      saveState();
      renderAll();
    });

    document.getElementById('inputTeamCount').addEventListener('change', (e) => {
      state.teamCount = Math.max(2, Number(e.target.value) || 4);
      saveState();
    });

    document.getElementById('inputMembersPerTeam').addEventListener('change', (e) => {
      state.membersPerTeam = Math.max(2, Number(e.target.value) || 4);
      saveState();
    });

    document.getElementById('inputTablesPerTeam').addEventListener('change', (e) => {
      state.tablesPerTeam = Math.max(1, Number(e.target.value) || 4);
      state.tableGroups = createTableGroups(state.totalTables, state.tablesPerTeam);
      saveState();
      renderAll();
    });

    // Inscribir jugador (Nombre / Nick + Ejército)
    const addPlayerAction = async () => {
      const inpName = document.getElementById('inputNewPlayerName');
      const inpArmy = document.getElementById('inputNewPlayerArmy');
      const name = (inpName?.value || '').trim();
      const army = (inpArmy?.value || '').trim();
      if (!name) {
        showToast('⚠️ Ingresa el Nombre o Nick del jugador.');
        return;
      }

      const regPool = getRegisteredPlayersList();
      if (
        state.players.some((p) => String(p).toLowerCase() === name.toLowerCase()) ||
        (state.mode !== 'individual' && regPool.some((r) => r.name.toLowerCase() === name.toLowerCase()))
      ) {
        showToast('⚠️ Ya existe un jugador inscrito con ese nombre en la sala.');
        return;
      }

      if (inpName) inpName.value = '';
      if (inpArmy) inpArmy.value = '';

      await submitPlayerRegistrationToCloud(name, army, state.roomCode);
      saveState();
      renderSetupView();
      renderSidebarStatus();
      showToast(
        army
          ? `🪖 Jugador "${name}" (${army}) inscrito en la sala.`
          : `🪖 Jugador "${name}" inscrito en la sala.`
      );
    };

    document.getElementById('btnAddPlayer').addEventListener('click', addPlayerAction);
    document.getElementById('inputNewPlayerName').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') addPlayerAction();
    });
    document.getElementById('inputNewPlayerArmy')?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') addPlayerAction();
    });

    // Abrir / Cerrar Inscripciones por Código
    document.getElementById('btnToggleRegistrationOpen')?.addEventListener('click', () => {
      if (!isAdminMode) return;
      state.registrationOpen = state.registrationOpen === false;
      saveState();
      renderSetupView();
      showToast(
        state.registrationOpen
          ? '🟢 Inscripciones abiertas para jugadores que entren con el código.'
          : '🔒 Inscripciones cerradas.'
      );
    });

    // Modalidad Parejas (2 vs 2): Formar pareja manual desde jugadores inscritos
    document.getElementById('btnCreatePairFromPool')?.addEventListener('click', () => {
      const sel1 = document.getElementById('selectPairMember1');
      const sel2 = document.getElementById('selectPairMember2');
      const customInp = document.getElementById('inputCustomPairName');
      const p1 = (sel1?.value || '').trim();
      const p2 = (sel2?.value || '').trim();
      if (!p1 || !p2) {
        showToast('⚠️ Selecciona al Jugador 1 y al Jugador 2 de la lista de inscritos.');
        return;
      }
      if (p1.toLowerCase() === p2.toLowerCase()) {
        showToast('⚠️ Debes elegir a dos jugadores distintos para formar una pareja.');
        return;
      }
      const customTitle = (customInp?.value || '').trim();
      const pairName = customTitle ? `${customTitle} (${p1} & ${p2})` : `${p1} & ${p2}`;
      if (state.players.some((p) => String(p).toLowerCase() === pairName.toLowerCase())) {
        showToast('⚠️ Esa pareja ya está registrada en la lista.');
        return;
      }

      const army1 = getEntityArmy(p1);
      const army2 = getEntityArmy(p2);
      const combinedArmy = [army1, army2].filter(Boolean).join(' + ');

      state.players.push(pairName);
      if (combinedArmy) {
        if (!state.playerArmies || typeof state.playerArmies !== 'object') state.playerArmies = {};
        state.playerArmies[pairName] = combinedArmy;
      }
      state.totalTables = Math.max(state.totalTables, Math.ceil(state.players.length / 2));
      if (customInp) customInp.value = '';
      saveState();
      renderSetupView();
      renderSidebarStatus();
      showToast(`🤝 Pareja "${pairName}" formada con éxito.`);
    });

    // Modalidad Parejas (2 vs 2): Emparejar inscritos al azar
    document.getElementById('btnAutoPairRegistered')?.addEventListener('click', () => {
      const unassigned = getRegisteredPlayersList().filter((r) => !isPlayerAssignedInCurrentMode(r.name));
      if (unassigned.length < 2) {
        showToast('⚠️ Se necesitan al menos 2 jugadores inscritos sin pareja para emparejar al azar.');
        return;
      }
      const shuffled = shuffleArray(unassigned);
      let createdCount = 0;
      for (let i = 0; i + 1 < shuffled.length; i += 2) {
        const a = shuffled[i];
        const b = shuffled[i + 1];
        const pairName = `${a.name} & ${b.name}`;
        const combinedArmy = [a.army, b.army].filter(Boolean).join(' + ');
        state.players.push(pairName);
        if (combinedArmy) {
          if (!state.playerArmies || typeof state.playerArmies !== 'object') state.playerArmies = {};
          state.playerArmies[pairName] = combinedArmy;
        }
        createdCount++;
      }
      state.totalTables = Math.max(state.totalTables, Math.ceil(state.players.length / 2));
      saveState();
      renderSetupView();
      renderSidebarStatus();
      showToast(`🎲 Se formaron ${createdCount} pareja(s) con los jugadores inscritos.`);
    });

    // Modalidad Equipos (4 vs 4): Distribuir jugadores inscritos en los equipos
    document.getElementById('btnAutoAssignTeamsFromPool')?.addEventListener('click', () => {
      const regPool = getRegisteredPlayersList();
      if (regPool.length === 0) {
        showToast('⚠️ Aún no hay jugadores inscritos en la sala para asignar a los equipos.');
        return;
      }
      let cursor = 0;
      for (let t = 0; t < state.teams.length; t++) {
        for (let m = 0; m < state.membersPerTeam; m++) {
          if (cursor < regPool.length) {
            state.teams[t].members[m] = regPool[cursor].name;
            cursor++;
          }
        }
      }
      saveState();
      renderSetupView();
      renderSidebarStatus();
      showToast(`🎲 Se asignaron ${Math.min(cursor, regPool.length)} jugadores inscritos a los equipos.`);
    });

    // Generar formulario de equipos
    document.getElementById('btnGenerateTeamTemplate').addEventListener('click', () => {
      state.teams = createDefaultTeams(state.teamCount, state.membersPerTeam);
      state.tableGroups = createTableGroups(state.totalTables, state.tablesPerTeam);
      saveState();
      renderSetupView();
      showToast('Equipos e integrantes generados.');
    });

    // Generar Torneo
    document.getElementById('btnGenerateTournament').addEventListener('click', () => {
      if (state.mode !== 'teams' && state.players.length < 2) {
        showToast('⚠️ Ingresa al menos 2 participantes antes de generar el torneo.');
        return;
      }

      const hasExistingMatches = state.rounds.some((r) => r.matches && r.matches.length > 0);
      const executeGenerate = () => {
        state.rounds = [];
        for (let r = 1; r <= state.totalRounds; r++) {
          state.rounds.push({
            round: r,
            paired: false,
            finished: false,
            podiumUpdated: false,
            teamClashes: [],
            matches: [],
            timer: {
              durationMinutes: 90,
              remainingMs: 90 * 60 * 1000,
              endTime: null,
              running: false
            }
          });
        }
        state.activeRound = 1;
        state.tournamentFinished = false;
        state.registrationOpen = false;
        saveState();
        switchTab('rounds');
        showToast(`Torneo inicializado con ${state.totalRounds} rondas. ¡Listo para emparejar Ronda 1!`);
      };

      if (hasExistingMatches) {
        openConfirmModal(
          '¿Reiniciar Rondas del Torneo?',
          'Actualmente existen mesas y/o resultados registrados en las rondas. Si generas nuevamente el torneo se reiniciarán los cruces manteniendo la lista de jugadores.',
          'Sí, Reiniciar Rondas',
          executeGenerate
        );
      } else {
        executeGenerate();
      }
    });

    // Formatear Plantilla (con confirmación de seguridad)
    document.getElementById('btnClearAllTemplate').addEventListener('click', () => {
      openConfirmModal(
        '¿Formatear Plantilla del Torneo?',
        'Esta acción eliminará todos los jugadores inscritos, los emparejamientos de todas las rondas y los puntajes del Podio. Esta acción no se puede deshacer.',
        '🧹 Sí, Formatear Todo',
        () => {
          state.players = [];
          state.registrations = {};
          state.playerArmies = {};
          state.removedRegistrationKeys = [];
          state.registrationOpen = true;
          state.rounds = [];
          for (let r = 1; r <= state.totalRounds; r++) {
            state.rounds.push({
              round: r,
              paired: false,
              finished: false,
              podiumUpdated: false,
              teamClashes: [],
              matches: [],
              timer: {
                durationMinutes: 90,
                remainingMs: 90 * 60 * 1000,
                endTime: null,
                running: false
              }
            });
          }
          state.activeRound = 1;
          state.tournamentFinished = false;
          state.votingPaintOpen = false;
          state.votingFairPlayOpen = false;
          state.votes = {};
          state.explicitReset = true;
          const regUrl = getRoomRegistrationsEndpoint(state.roomCode);
          if (regUrl) {
            fetchWithTimeout(regUrl, { method: 'DELETE' }).catch(() => {});
          }
          const votesUrl = getRoomVotesEndpoint(state.roomCode);
          if (votesUrl) {
            fetchWithTimeout(votesUrl, { method: 'DELETE' }).catch(() => {});
          }
          saveState();
          delete state.explicitReset;
          renderAll();
          showToast('Plantilla formateada en blanco para un nuevo torneo.');
        }
      );
    });

    // Emparejar Ronda Actual
    document.getElementById('btnPairCurrentRound').addEventListener('click', () => {
      if (state.mode !== 'teams' && state.players.length < 2) {
        showToast('⚠️ Inscribe al menos 2 jugadores en "Inscripción y Torneo" antes de emparejar.');
        return;
      }

      const rNum = state.activeRound;
      let rObj = state.rounds.find((x) => x.round === rNum);
      if (!rObj) {
        rObj = { round: rNum, paired: false, finished: false, podiumUpdated: false, teamClashes: [], matches: [] };
        state.rounds.push(rObj);
      }

      if (state.mode === 'teams') {
        buildIndividualMatchesFromTeamClashes(rObj);
        showToast(`Mesas de integrantes creadas para la Ronda ${rNum}.`);
        return;
      }

      const pairings = generatePairingsForRound(rNum);
      rObj.matches = pairings.map((pair) => {
        const m = {
          table: pair.table,
          team1: '',
          team2: '',
          p1: {
            name: pair.p1,
            paint: 's',
            delay: 'N/A',
            surrender: false,
            abandonMatch: false,
            abandonTournament: false,
            result: '',
            tp: 0,
            vp: 0,
            manualTp: false
          },
          p2: {
            name: pair.p2,
            paint: 's',
            delay: 'N/A',
            surrender: false,
            abandonMatch: false,
            abandonTournament: false,
            result: '',
            tp: 0,
            vp: 0,
            manualTp: false
          }
        };
        recalculateMatch(m, 'init');
        return m;
      });
      rObj.paired = true;
      rObj.finished = false;
      saveState();
      renderAll();
      showToast(
        rNum === 1
          ? `Ronda 1 emparejada aleatoriamente (${rObj.matches.length} mesas).`
          : `Ronda ${rNum} emparejada por Sistema Suizo sin repetir rivales ni mesas.`
      );
    });

    // Finalizar Ronda Actual
    document.getElementById('btnFinishCurrentRound').addEventListener('click', () => {
      const rNum = state.activeRound;
      const rObj = state.rounds.find((x) => x.round === rNum);
      if (!rObj || !rObj.matches || rObj.matches.length === 0) {
        showToast(`⚠️ Primero debes emparejar las mesas de la Ronda ${rNum}.`);
        return;
      }

      const hasError = rObj.matches.some((m) => hasDelayError(m.p1) || hasDelayError(m.p2));
      if (hasError) {
        showToast('⚠️ Corrige el error de atraso (> 20 min requiere marcar Abandono Partida) antes de finalizar.');
        return;
      }

      rObj.finished = true;
      rObj.podiumUpdated = true;

      if (rNum < state.totalRounds) {
        state.activeRound = rNum + 1;
        saveState();
        renderAll();
        showToast(`✓ Ronda ${rNum} finalizada y registrada en el Podio. Avanzando a Ronda ${rNum + 1}.`);
      } else {
        saveState();
        switchTab('podium');
        launchPodiumCelebration();
        showToast(`🏆 ¡Torneo finalizado! Celebrando el Podio oficial.`);
      }
    });

    // Actualizar Podio
    document.getElementById('btnUpdatePodiumFromRound').addEventListener('click', () => {
      const rObj = state.rounds.find((x) => x.round === state.activeRound);
      if (rObj) rObj.podiumUpdated = true;
      saveState();
      switchTab('podium');
      showToast('Podio actualizado y ordenado según los criterios oficiales.');
    });

    // Añadir Mesa Manual en Ronda
    document.getElementById('btnAddManualMatch').addEventListener('click', () => {
      const rObj = state.rounds.find((x) => x.round === state.activeRound);
      if (!rObj) return;
      const nextTableNum = rObj.matches.length + 1;
      rObj.matches.push({
        table: `Mesa ${nextTableNum}`,
        team1: '',
        team2: '',
        p1: {
          name: state.players[0] || 'Jugador 1',
          paint: 's',
          delay: 'N/A',
          surrender: false,
          abandonMatch: false,
          abandonTournament: false,
          result: '',
          tp: 0,
          vp: 0,
          manualTp: false
        },
        p2: {
          name: state.players[1] || 'Jugador 2',
          paint: 's',
          delay: 'N/A',
          surrender: false,
          abandonMatch: false,
          abandonTournament: false,
          result: '',
          tp: 0,
          vp: 0,
          manualTp: false
        }
      });
      saveState();
      renderRoundsView();
    });

    // Limpiar Ronda Actual (con confirmación)
    document.getElementById('btnClearCurrentRound').addEventListener('click', () => {
      const rObj = state.rounds.find((x) => x.round === state.activeRound);
      if (!rObj || !rObj.matches || rObj.matches.length === 0) {
        showToast(`La Ronda ${state.activeRound} ya está vacía.`);
        return;
      }
      openConfirmModal(
        `¿Limpiar Ronda ${state.activeRound}?`,
        `Se borrarán todas las mesas y puntajes registrados en la Ronda ${state.activeRound}.`,
        'Sí, Limpiar Ronda',
        () => {
          rObj.matches = [];
          rObj.teamClashes = [];
          rObj.paired = false;
          rObj.finished = false;
          saveState();
          renderRoundsView();
          renderSidebarStatus();
          showToast(`Ronda ${state.activeRound} limpiada.`);
        }
      );
    });

    // Controles de Duelos 4vs4 (Equipos)
    document.getElementById('btnPairTeamsAuto').addEventListener('click', () => {
      const rNum = state.activeRound;
      const rObj = state.rounds.find((x) => x.round === rNum);
      if (!rObj) return;
      const pairs = generatePairingsForRound(rNum);
      const standingsMap = {};
      calculateStandings(Math.max(1, rNum - 1)).forEach((s) => {
        standingsMap[s.name] = s;
      });

      rObj.teamClashes = pairs.map((p) => {
        const s1 = standingsMap[p.p1] || { finalTp: 0, vpDiff: 0, vpFavor: 0 };
        const s2 = standingsMap[p.p2] || { finalTp: 0, vpDiff: 0, vpFavor: 0 };
        let color1 = 'blanco';
        let color2 = 'blanco';
        if (rNum === 1) {
          const rnd = Math.random() < 0.5;
          color1 = rnd ? 'Rojo' : 'Azul';
          color2 = rnd ? 'Azul' : 'Rojo';
        } else {
          if (s1.finalTp > s2.finalTp) color1 = 'Rojo';
          else if (s1.finalTp < s2.finalTp) color1 = 'Azul';
          else if (s1.vpDiff > s2.vpDiff) color1 = 'Rojo';
          else if (s1.vpDiff < s2.vpDiff) color1 = 'Azul';
          else if (s1.vpFavor > s2.vpFavor) color1 = 'Rojo';
          else if (s1.vpFavor < s2.vpFavor) color1 = 'Azul';
          else color1 = 'blanco';

          color2 = color1 === 'Rojo' ? 'Azul' : color1 === 'Azul' ? 'Rojo' : 'blanco';
        }
        return {
          team1: p.p1,
          color1,
          team2: p.p2,
          color2,
          tableGroup: p.table
        };
      });
      saveState();
      renderRoundsView();
      showToast(`Equipos emparejados para Ronda ${rNum}.`);
    });

    document.getElementById('btnAssignRandomColors').addEventListener('click', () => {
      const rObj = state.rounds.find((x) => x.round === state.activeRound);
      if (!rObj || !rObj.teamClashes) return;
      rObj.teamClashes.forEach((clash) => {
        const rnd = Math.random() < 0.5;
        clash.color1 = rnd ? 'Rojo' : 'Azul';
        clash.color2 = rnd ? 'Azul' : 'Rojo';
      });
      saveState();
      renderRoundsView();
      showToast('Colores Rojo y Azul sorteados entre los equipos enfrentados.');
    });

    document.getElementById('btnAssignTableGroups').addEventListener('click', () => {
      const rObj = state.rounds.find((x) => x.round === state.activeRound);
      if (!rObj || !rObj.teamClashes) return;
      const groups = shuffleArray(state.tableGroups.map((g) => g.name));
      rObj.teamClashes.forEach((clash, idx) => {
        clash.tableGroup = groups[idx % groups.length] || `Mesas_1_a_4`;
      });
      saveState();
      renderRoundsView();
      showToast('Grupos de mesas asignados aleatoriamente.');
    });

    document.getElementById('btnBuildTeamMemberMatches').addEventListener('click', () => {
      const rObj = state.rounds.find((x) => x.round === state.activeRound);
      if (!rObj) return;
      buildIndividualMatchesFromTeamClashes(rObj);
      showToast('Mesas individuales generadas a partir de los enfrentamientos de equipos.');
    });

    // Mostrar/ocultar sábana Resumen en Podio
    document.getElementById('btnToggleDetailedResumen').addEventListener('click', () => {
      const block = document.getElementById('detailedResumenBlock');
      block.classList.toggle('hidden');
    });

    // Animación de Celebración de Podio Final
    document.getElementById('btnShowFinalDialog').addEventListener('click', () => {
      launchPodiumCelebration();
    });

    document.getElementById('btnCloseCelebration').addEventListener('click', closePodiumCelebration);
    document.getElementById('btnCloseCelebrationTop').addEventListener('click', closePodiumCelebration);
    document.getElementById('podiumCelebrationOverlay').addEventListener('click', (e) => {
      if (e.target.id === 'podiumCelebrationOverlay') closePodiumCelebration();
    });

    // Descargar Historia de Instagram (1080x1920)
    document.getElementById('btnDownloadIgStory').addEventListener('click', () => {
      downloadInstagramStory();
    });
    document.getElementById('btnDownloadStoryFromCelebration').addEventListener('click', () => {
      downloadInstagramStory();
    });

    // Modal de Reglas del Sistema
    document.getElementById('btnOpenRulesModal').addEventListener('click', () => {
      openModal(
        'Reglas de Puntuación y Emparejamiento',
        `
          <h4>10.1 Puntos de Torneo (Sistema Extendido)</h4>
          <ul>
            <li><strong>Victoria Absoluta (+5 puntos):</strong> Puntuar al menos 10 VPs más que tu oponente (<code>Dif. PV ≥ 10</code>).</li>
            <li><strong>Victoria Ajustada (+4 puntos):</strong> Cualquier otra victoria (<code>Dif. PV de 1 a 9</code>).</li>
            <li><strong>Empate (+2 puntos):</strong> Igualdad de Puntos de Victoria.</li>
            <li><strong>Derrota Ajustada (+1 punto):</strong> Perder sin que la diferencia de VPs sea 10 o más (<code>Dif. PV de 1 a 9</code>).</li>
            <li><strong>Derrota Absoluta (0 puntos):</strong> Perder si la diferencia de VPs es 10 o más (<code>Dif. PV ≥ 10</code>).</li>
            <li><em>Escala Clásica alternativa (3 / 1 / 0):</em> Victoria = 3 pts; Empate = 1 pt; Derrota = 0 pts.</li>
          </ul>
          <h4>10.2 Diferencia de Puntos de Victoria (-20 a +20 por ronda)</h4>
          <ul>
            <li>Se calcula como la diferencia entre los Puntos de Victoria logrados por el jugador y los Puntos de Victoria logrados por el oponente en el escenario correspondiente de la ronda.</li>
          </ul>
          <h4>10.3 Puntos de Victoria a Favor (0 a 20 por ronda)</h4>
          <ul>
            <li>Son los Puntos de Victoria obtenidos por el jugador en la ronda correspondiente (entre 0 y 20 puntos cada ronda).</li>
          </ul>
          <h4>Orden de Importancia y Desempate</h4>
          <ul>
            <li><strong>1° Puntos de Torneo</strong> → <strong>2° Diferencia de Puntos de Victoria</strong> → <strong>3° Puntos de Victoria a Favor</strong>.</li>
            <li><strong>Emparejamiento Suizo:</strong> Ronda 1 al azar; Ronda 2 en adelante por orden de Podio verificando que los rivales no se hayan enfrentado antes y que no repitan mesa.</li>
          </ul>
        `
      );
    });

    document.getElementById('btnCloseModal').addEventListener('click', closeModal);
    document.getElementById('elvenModal').addEventListener('click', (e) => {
      if (e.target.id === 'elvenModal') closeModal();
    });

    // Buscador de jugador / mesa en vista de Rondas
    const searchInput = document.getElementById('inputFilterPlayerMatch');
    if (searchInput) {
      searchInput.addEventListener('input', (e) => {
        searchFilterQuery = e.target.value;
        renderRoundsView();
      });
    }

    // Botón Modo Organizador / Configuración Firebase en Vivo
    const adminBtn = document.getElementById('btnToggleAdminMode');
    if (adminBtn) {
      adminBtn.addEventListener('click', openAdminAndCloudModal);
    }

    // Companion Room Code: Copiar código / link de sala
    const btnCopyRoomCode = document.getElementById('btnCopyRoomCode');
    if (btnCopyRoomCode) {
      btnCopyRoomCode.addEventListener('click', () => {
        const inviteUrl = `${window.location.origin}${window.location.pathname}?code=${state.roomCode}`;
        navigator.clipboard.writeText(inviteUrl);
        showToast(`📋 Código ${state.roomCode} y link de seguimiento copiados al portapapeles.`);
      });
    }

    // Companion Room Code: Crear una nueva sala de torneo con nuevo ID
    const btnNewRoomCode = document.getElementById('btnNewRoomCode');
    if (btnNewRoomCode) {
      btnNewRoomCode.addEventListener('click', () => {
        promptCreateNewRoom();
      });
    }

    // Companion Room Code: Unirse a un torneo existente mediante su código
    const btnJoinRoomCode = document.getElementById('btnJoinRoomCode');
    const inputJoinRoomCode = document.getElementById('inputJoinRoomCode');
    if (btnJoinRoomCode && inputJoinRoomCode) {
      btnJoinRoomCode.addEventListener('click', () => {
        joinTournamentByCode(inputJoinRoomCode.value);
      });
      inputJoinRoomCode.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          joinTournamentByCode(inputJoinRoomCode.value);
        }
      });
    }

    // Reloj de Ronda Sincronizado: Fijar minutos, Iniciar/Pausar y Reiniciar
    const btnSetTimerMinutes = document.getElementById('btnSetTimerMinutes');
    if (btnSetTimerMinutes) {
      btnSetTimerMinutes.addEventListener('click', () => {
        const rObj = state.rounds.find((x) => x.round === state.activeRound);
        if (!rObj) return;
        const inp = document.getElementById('inputTimerMinutes');
        const mins = Math.max(1, Math.min(360, Number(inp?.value) || 90));
        rObj.timer = {
          durationMinutes: mins,
          remainingMs: mins * 60 * 1000,
          endTime: null,
          running: false
        };
        delete warned15MinByRound[`${state.roomCode}_R${rObj.round}`];
        delete warnedExpiredByRound[`${state.roomCode}_R${rObj.round}`];
        saveState();
        updateRoundTimerUI();
        showToast(`⏱️ Tiempo de Ronda ${rObj.round} fijado en ${mins} minutos.`);
      });
    }

    const btnToggleTimerRun = document.getElementById('btnToggleTimerRun');
    if (btnToggleTimerRun) {
      btnToggleTimerRun.addEventListener('click', () => {
        const rObj = state.rounds.find((x) => x.round === state.activeRound);
        if (!rObj) return;
        if (!rObj.timer) {
          const inp = document.getElementById('inputTimerMinutes');
          const mins = Math.max(1, Math.min(360, Number(inp?.value) || 90));
          rObj.timer = {
            durationMinutes: mins,
            remainingMs: mins * 60 * 1000,
            endTime: null,
            running: false
          };
        }
        const t = rObj.timer;
        if (t.running) {
          // Pausar
          const currentRem = getRoundRemainingMs(rObj);
          t.remainingMs = currentRem;
          t.endTime = null;
          t.running = false;
          saveState();
          updateRoundTimerUI();
          showToast(`⏸ Reloj de Ronda ${rObj.round} pausado.`);
        } else {
          // Iniciar / Reanudar
          let currentRem = getRoundRemainingMs(rObj);
          if (currentRem <= 0) {
            const mins = Number(t.durationMinutes) || 90;
            currentRem = mins * 60 * 1000;
            delete warned15MinByRound[`${state.roomCode}_R${rObj.round}`];
            delete warnedExpiredByRound[`${state.roomCode}_R${rObj.round}`];
          }
          t.remainingMs = currentRem;
          t.endTime = Date.now() + currentRem;
          t.running = true;
          saveState();
          updateRoundTimerUI();
          showToast(`▶ Reloj de Ronda ${rObj.round} en marcha y sincronizado para todos los jugadores.`);
        }
      });
    }

    const btnResetTimer = document.getElementById('btnResetTimer');
    if (btnResetTimer) {
      btnResetTimer.addEventListener('click', () => {
        const rObj = state.rounds.find((x) => x.round === state.activeRound);
        if (!rObj) return;
        const inp = document.getElementById('inputTimerMinutes');
        const mins = Math.max(1, Math.min(360, Number(inp?.value) || Number(rObj.timer?.durationMinutes) || 90));
        rObj.timer = {
          durationMinutes: mins,
          remainingMs: mins * 60 * 1000,
          endTime: null,
          running: false
        };
        delete warned15MinByRound[`${state.roomCode}_R${rObj.round}`];
        delete warnedExpiredByRound[`${state.roomCode}_R${rObj.round}`];
        saveState();
        updateRoundTimerUI();
        showToast(`↺ Reloj de Ronda ${rObj.round} reiniciado a ${mins}:00.`);
      });
    }

    // Lanzar / Cerrar Votaciones (Organizador) y Abrir Modal de Votación (Jugadores)
    ['btnLaunchPaintVotingRounds', 'btnLaunchPaintVotingPodium'].forEach((id) => {
      document.getElementById(id)?.addEventListener('click', () => toggleVotingCategory('paint'));
    });
    ['btnLaunchFairPlayVotingRounds', 'btnLaunchFairPlayVotingPodium'].forEach((id) => {
      document.getElementById(id)?.addEventListener('click', () => toggleVotingCategory('fairPlay'));
    });

    ['btnOpenVotingFromRounds', 'btnOpenVotingModal', 'btnOpenVotingFromBanner'].forEach((id) => {
      document.getElementById(id)?.addEventListener('click', openSpecialVotingModal);
    });

    // Minimizar / Expandir Tarjetas de Foto 2 (Código de Torneo y Resumen) + Modal
    const btnToggleCompanionMinimize = document.getElementById('btnToggleCompanionMinimize');
    if (btnToggleCompanionMinimize) {
      btnToggleCompanionMinimize.addEventListener('click', () => {
        const card = document.getElementById('companionRoomCard');
        const body = document.getElementById('companionCollapsibleBody');
        const minBadge = document.getElementById('minimizedRoomCodeBadge');
        if (!card || !body) return;
        const willMinimize = !card.classList.contains('is-minimized');
        card.classList.toggle('is-minimized', willMinimize);
        body.classList.toggle('hidden', willMinimize);
        if (minBadge) minBadge.classList.toggle('hidden', !willMinimize);
        btnToggleCompanionMinimize.textContent = willMinimize ? '+' : '—';
        btnToggleCompanionMinimize.setAttribute('aria-expanded', String(!willMinimize));
      });
    }

    const btnToggleStatusMinimize = document.getElementById('btnToggleStatusMinimize');
    if (btnToggleStatusMinimize) {
      btnToggleStatusMinimize.addEventListener('click', () => {
        const card = document.getElementById('quickStatusCard');
        const grid = document.getElementById('statusCollapsibleGrid');
        if (!card || !grid) return;
        const willMinimize = !card.classList.contains('is-minimized');
        card.classList.toggle('is-minimized', willMinimize);
        grid.classList.toggle('hidden', willMinimize);
        btnToggleStatusMinimize.textContent = willMinimize ? '+' : '—';
        btnToggleStatusMinimize.setAttribute('aria-expanded', String(!willMinimize));
      });
    }

    const btnMinimizeModal = document.getElementById('btnMinimizeModal');
    if (btnMinimizeModal) {
      btnMinimizeModal.addEventListener('click', () => {
        const modalBackdrop = document.getElementById('elvenModal');
        if (!modalBackdrop) return;
        const willMin = !modalBackdrop.classList.contains('is-minimized');
        modalBackdrop.classList.toggle('is-minimized', willMin);
        btnMinimizeModal.textContent = willMin ? '□' : '—';
      });
    }

    // Finalizar Torneo Oficialmente y Reabrir Torneo
    const btnFinalizeFromRounds = document.getElementById('btnFinalizeTournamentFromRounds');
    if (btnFinalizeFromRounds) {
      btnFinalizeFromRounds.addEventListener('click', finalizeTournamentFlow);
    }
    const btnFinalizePodium = document.getElementById('btnFinalizeTournamentPodium');
    if (btnFinalizePodium) {
      btnFinalizePodium.addEventListener('click', finalizeTournamentFlow);
    }
    document.getElementById('btnReopenTournamentRounds')?.addEventListener('click', reopenTournamentFlow);
    document.getElementById('btnReopenTournamentPodium')?.addEventListener('click', reopenTournamentFlow);

    // Sincronización instantánea entre pestañas del mismo navegador
    window.addEventListener('storage', (e) => {
      if (e.key === ROOMS_REGISTRY_KEY && state && state.roomCode) {
        const updatedRoom = getRoomFromLocalRegistry(state.roomCode);
        if (
          updatedRoom &&
          isValidTournamentPayload(updatedRoom) &&
          String(updatedRoom.roomCode).toUpperCase() === state.roomCode &&
          updatedRoom.updatedAt > (state.updatedAt || 0)
        ) {
          const currentVotes = { ...(state.votes || {}), ...(updatedRoom.votes || {}) };
          state = normalizeState(updatedRoom, state.roomCode);
          state.votes = currentVotes;
          renderAll();
        }
      }
    });

    // Botón Mi Identidad / Inscribirme en Sala
    const btnIdentityPill = document.getElementById('btnPlayerIdentityPill');
    if (btnIdentityPill) {
      btnIdentityPill.addEventListener('click', openPlayerRegistrationModal);
    }

    // Reconexión inmediata cuando el dispositivo recupera conexión o vuelve a primer plano (celular/pestaña)
    window.addEventListener('online', () => {
      startCloudRealtimeSync();
    });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        pullStateFromCloud();
      }
    });
  }

  function openPlayerRegistrationModal() {
    const lockedRoomCode = String(state.roomCode || '').trim().toUpperCase();
    const regOpen = state.registrationOpen !== false;
    const myId = getMyPlayerIdentity(lockedRoomCode);
    const regPool = getRegisteredPlayersList();

    const modeHint =
      state.mode === 'pairs'
        ? 'Inscríbete con tu Nombre y Ejército. El Organizador formará las parejas (2 vs 2) con los jugadores inscritos.'
        : state.mode === 'teams'
        ? 'Inscríbete con tu Nombre y Ejército. El Organizador asignará los equipos (4 vs 4) con los jugadores inscritos.'
        : 'Inscríbete con tu Nombre y Ejército para quedar registrado inmediatamente en la lista del torneo.';

    const existingOptionsHtml = [
      `<option value="">-- Selecciona tu nombre si ya estás inscrito --</option>`,
      ...regPool.map(
        (r) =>
          `<option value="${escapeHtml(r.name)}" ${
            myId.name && r.name.toLowerCase() === myId.name.toLowerCase() ? 'selected' : ''
          }>${escapeHtml(r.name + (r.army ? ` — 🛡️ ${r.army}` : ''))}</option>`
      )
    ].join('');

    openModal(
      `🪖 Identifícate en el Torneo (ID: ${lockedRoomCode})`,
      `
        <p style="margin-bottom:12px; color:var(--text-parchment);">
          Bienvenido a <strong>${escapeHtml(state.tournamentName || 'Torneo MESBG')}</strong>. ${escapeHtml(modeHint)}
        </p>

        ${
          regOpen || myId.name
            ? `
              <div style="background:rgba(12,24,21,0.88); border:1px solid var(--border-gold); border-radius:12px; padding:14px; margin-bottom:14px;">
                <h4 style="margin-top:0; margin-bottom:10px; color:var(--gold-bright);">
                  ${myId.name ? '🪖 Tu Inscripción Vinculada a este Dispositivo' : '⚔️ 1. Inscribirme como Participante'}
                </h4>
                <div class="field-group" style="margin-bottom:10px;">
                  <label for="inputSelfRegName">Tu Nombre / Nick ${myId.name ? '(Vinculado a tu asiento)' : ''}</label>
                  <input type="text" id="inputSelfRegName" maxlength="36" placeholder="Ej: Lain, Nine, Aragorn..." value="${escapeHtml(
                    myId.name
                  )}" ${myId.name ? 'readonly disabled style="opacity:0.85; cursor:not-allowed;"' : ''} />
                </div>
                <div class="field-group" style="margin-bottom:12px;">
                  <label for="inputSelfRegArmy">Tu Ejército / Facción</label>
                  <input type="text" id="inputSelfRegArmy" maxlength="44" placeholder="Ej: Mordor, Gondor, Rohan, Rivendel..." value="${escapeHtml(
                    myId.army
                  )}" />
                </div>
                <button type="button" class="btn-gold-cta" id="btnSubmitSelfRegistration" style="width:100%;">
                  ⚔️ ${myId.name ? 'Guardar Mi Ejército' : 'Inscribirme y Entrar al Torneo'}
                </button>
              </div>
            `
            : `
              <div style="background:rgba(82,36,24,0.38); border:1px solid rgba(224,112,92,0.5); border-radius:10px; padding:10px 12px; margin-bottom:14px; font-size:0.82rem; color:#ffd7cc;">
                🔒 Las inscripciones nuevas ya fueron cerradas por el Organizador. Si el Organizador te inscribió manualmente, selecciona tu nombre abajo.
              </div>
            `
        }

        ${
          !myId.name && regPool.length > 0
            ? `
              <div style="background:rgba(9,17,15,0.82); border:1px solid rgba(169,189,179,0.28); border-radius:12px; padding:12px 14px; margin-bottom:14px;">
                <label for="selectExistingPlayerIdentity" style="display:block; margin-bottom:6px; font-size:0.78rem; color:var(--text-cream);">
                  ¿El Organizador te agregó manualmente a la lista? Vincula tu dispositivo:
                </label>
                <div style="display:flex; gap:8px; flex-wrap:wrap;">
                  <select id="selectExistingPlayerIdentity" style="flex:1; min-width:170px;">${existingOptionsHtml}</select>
                  <button type="button" class="btn-elven-outline btn-sm" id="btnClaimExistingIdentity">✓ Soy este Jugador</button>
                </div>
              </div>
            `
            : ''
        }

        <div class="modal-confirm-actions" style="justify-content:space-between;">
          ${
            !myId.name
              ? `<button type="button" class="btn-elven-outline btn-sm" id="btnEnterAsSpectatorOnly">
                  👁️ Solo mirar (Espectador)
                </button>`
              : `<span></span>`
          }
          <button type="button" class="btn-elven-outline btn-sm" id="btnCloseSelfRegModal">
            Cerrar
          </button>
        </div>
      `
    );

    const inpNameEl = document.getElementById('inputSelfRegName');
    const inpArmyEl = document.getElementById('inputSelfRegArmy');
    const btnSubmitEl = document.getElementById('btnSubmitSelfRegistration');

    const handleSelfRegister = async () => {
      const pName = (inpNameEl?.value || '').trim();
      const pArmy = (inpArmyEl?.value || '').trim();
      if (!pName) {
        showToast('⚠️ Por favor ingresa tu Nombre o Nick.');
        return;
      }
      if (!pArmy) {
        showToast('⚠️ Por favor ingresa tu Ejército o Facción.');
        return;
      }

      const alreadyExists = regPool.some((r) => r.name.toLowerCase() === pName.toLowerCase());
      const isUpdatingSelf = myId.name && myId.name.toLowerCase() === pName.toLowerCase();
      if (alreadyExists && !isUpdatingSelf) {
        showToast(
          `⚠️ El nombre "${pName}" ya está inscrito en la sala. Si eres tú, selecciónalo abajo en "¿Ya estás en la lista?", o agrega tu inicial/nick.`
        );
        return;
      }

      if (btnSubmitEl) {
        btnSubmitEl.disabled = true;
        btnSubmitEl.textContent = '⏳ Inscribiendo en la sala...';
      }

      const ok = await submitPlayerRegistrationToCloud(pName, pArmy, lockedRoomCode);
      if (!ok) {
        if (btnSubmitEl) {
          btnSubmitEl.disabled = false;
          btnSubmitEl.textContent = `⚔️ ${
            myId.name ? 'Guardar y Actualizar Mi Inscripción' : 'Inscribirme y Entrar al Torneo'
          }`;
        }
        showToast('⚠️ Error de conexión con la base de datos. Verifica tu internet e intenta nuevamente.');
        return;
      }

      setMyPlayerIdentity(lockedRoomCode, pName, pArmy, false);
      closeModal();
      renderAll();
      showToast(`✅ ¡Inscrito como "${pName}" con ejército "${pArmy}"!`);
    };

    btnSubmitEl?.addEventListener('click', handleSelfRegister);
    inpArmyEl?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') handleSelfRegister();
    });

    document.getElementById('btnClaimExistingIdentity')?.addEventListener('click', () => {
      if (myId.name) {
        showToast('🔒 Tu dispositivo ya está vinculado a tu asiento de jugador.');
        return;
      }
      const sel = document.getElementById('selectExistingPlayerIdentity');
      const chosenName = (sel?.value || '').trim();
      if (!chosenName) {
        showToast('⚠️ Selecciona tu nombre de la lista.');
        return;
      }
      const regKey = sanitizeFirebaseKey(chosenName);
      const existingReg = state.registrations && state.registrations[regKey];
      if (existingReg && existingReg.deviceId && existingReg.deviceId !== getMyDeviceId()) {
        showToast('🔒 Ese jugador ya está vinculado a otro dispositivo. No puedes tomar el asiento de otro jugador.');
        return;
      }
      const chosenArmy = getEntityArmy(chosenName);
      setMyPlayerIdentity(lockedRoomCode, chosenName, chosenArmy, false);
      closeModal();
      renderAll();
      showToast(`🪖 Identificado como "${chosenName}"${chosenArmy ? ` (${chosenArmy})` : ''}.`);
    });

    document.getElementById('btnEnterAsSpectatorOnly')?.addEventListener('click', () => {
      setMyPlayerIdentity(lockedRoomCode, '', '', true);
      closeModal();
      renderAll();
      showToast('👁️ Viendo el torneo en modo Espectador. Puedes inscribirte en cualquier momento desde el botón superior.');
    });

    document.getElementById('btnCloseSelfRegModal')?.addEventListener('click', closeModal);
  }

  function openSpecialVotingModal() {
    const lockedRoomCode = String(state.roomCode || '').trim().toUpperCase();
    const paintOpen = !!state.votingPaintOpen;
    const fairOpen = !!state.votingFairPlayOpen;

    if (!paintOpen && !fairOpen) {
      showToast('🔒 El Organizador aún no ha lanzado la votación de Pintura ni de Fair Play.');
      return;
    }

    const standings = calculateStandings();
    const candidates = standings.map((s) => s.name).filter(Boolean);
    if (candidates.length === 0) {
      showToast('⚠️ Aún no hay participantes registrados en el torneo para votar.');
      return;
    }

    const myId = getMyPlayerIdentity(lockedRoomCode);
    const savedVoterKey = myId.key && myId.key !== '__SPECTATOR__' ? myId.key : '';

    const existingVote =
      savedVoterKey && state.votes && state.votes[savedVoterKey] ? state.votes[savedVoterKey] : null;

    // Si el jugador se inscribió individualmente y luego fue puesto en una pareja, encontrar su entidad en candidates
    const matchedCandidateForMe = myId.name
      ? candidates.find(
          (c) =>
            c.toLowerCase() === myId.name.toLowerCase() ||
            c
              .split(/\s*[&+/]\s*|\s+y\s+/i)
              .map((s) => s.trim().toLowerCase())
              .includes(myId.name.toLowerCase())
        )
      : '';

    const savedVoterName =
      matchedCandidateForMe ||
      existingVote?.voter ||
      candidates.find((c) => sanitizeFirebaseKey(c) === savedVoterKey) ||
      '';
    const currentPaint = existingVote?.paintVote || existingVote?.paint || '';
    const currentFairPlay = existingVote?.fairPlayVote || existingVote?.fairPlay || '';

    const voterOptionsHtml = [
      `<option value="">-- Selecciona tu nombre en el torneo --</option>`,
      ...candidates.map((c) => {
        const cArmy = getEntityArmy(c);
        return `<option value="${escapeHtml(c)}" ${c === savedVoterName ? 'selected' : ''}>${escapeHtml(
          c + (cArmy ? ` (${cArmy})` : '')
        )}</option>`;
      })
    ].join('');

    openModal(
      '🗳️ Votación de Reconocimientos Especiales',
      `
        <p style="margin-bottom:14px; color:var(--text-parchment);">
          Selecciona tu candidato favorito. <strong>No está permitido votar por uno mismo.</strong>
        </p>

        <div class="field-group" style="margin-bottom:14px;">
          <label for="selectVoterIdentity">1. Tu Identidad en el Torneo</label>
          <select id="selectVoterIdentity">${voterOptionsHtml}</select>
        </div>

        ${
          paintOpen
            ? `<div class="field-group" style="margin-bottom:14px;">
                <label for="selectVoteBestPaint">🎨 Tu voto para Mejor Pintura (No puedes votarte a ti mismo)</label>
                <select id="selectVoteBestPaint"></select>
              </div>`
            : ''
        }

        ${
          fairOpen
            ? `<div class="field-group" style="margin-bottom:18px;">
                <label for="selectVoteFairPlay">🤝 Tu voto para Premio Fair Play (No puedes votarte a ti mismo)</label>
                <select id="selectVoteFairPlay"></select>
              </div>`
            : ''
        }

        <div class="modal-confirm-actions">
          <button type="button" class="btn-elven-outline" id="btnCancelVoteModal">Cancelar</button>
          <button type="button" class="btn-gold-cta" id="btnSubmitVoteModal">🗳️ Registrar Mi Voto</button>
        </div>
      `
    );

    const selectVoterEl = document.getElementById('selectVoterIdentity');
    const selectPaintEl = document.getElementById('selectVoteBestPaint');
    const selectFairEl = document.getElementById('selectVoteFairPlay');

    function rebuildCandidateDropdowns(selectedVoter, preferredPaint, preferredFair) {
      const otherCandidates = candidates.filter((c) => c !== selectedVoter);

      if (selectPaintEl) {
        selectPaintEl.innerHTML = [
          `<option value="">-- Elige tu voto para Mejor Pintura --</option>`,
          ...otherCandidates.map((c) => {
            const cArmy = getEntityArmy(c);
            return `<option value="${escapeHtml(c)}" ${
              c === preferredPaint && c !== selectedVoter ? 'selected' : ''
            }>🎨 ${escapeHtml(c + (cArmy ? ` — 🛡️ ${cArmy}` : ''))}</option>`;
          })
        ].join('');
      }

      if (selectFairEl) {
        selectFairEl.innerHTML = [
          `<option value="">-- Elige tu voto para Premio Fair Play --</option>`,
          ...otherCandidates.map((c) => {
            const cArmy = getEntityArmy(c);
            return `<option value="${escapeHtml(c)}" ${
              c === preferredFair && c !== selectedVoter ? 'selected' : ''
            }>🤝 ${escapeHtml(c + (cArmy ? ` — 🛡️ ${cArmy}` : ''))}</option>`;
          })
        ].join('');
      }
    }

    rebuildCandidateDropdowns(savedVoterName, currentPaint, currentFairPlay);

    if (selectVoterEl) {
      selectVoterEl.addEventListener('change', () => {
        const who = selectVoterEl.value;
        const whoKey = sanitizeFirebaseKey(who);
        const prev = whoKey && state.votes && state.votes[whoKey] ? state.votes[whoKey] : null;
        const prevPaint = prev?.paintVote || prev?.paint || (selectPaintEl ? selectPaintEl.value : '');
        const prevFair = prev?.fairPlayVote || prev?.fairPlay || (selectFairEl ? selectFairEl.value : '');
        rebuildCandidateDropdowns(who, prevPaint, prevFair);
      });
    }

    document.getElementById('btnCancelVoteModal')?.addEventListener('click', closeModal);
    document.getElementById('btnSubmitVoteModal')?.addEventListener('click', async () => {
      const voterName = (selectVoterEl?.value || '').trim();
      const voterKey = sanitizeFirebaseKey(voterName);
      const prevVoteObj = voterKey && state.votes && state.votes[voterKey] ? state.votes[voterKey] : {};

      const paintVote = paintOpen
        ? (selectPaintEl?.value || '').trim()
        : String(prevVoteObj.paintVote || prevVoteObj.paint || '').trim();
      const fairPlayVote = fairOpen
        ? (selectFairEl?.value || '').trim()
        : String(prevVoteObj.fairPlayVote || prevVoteObj.fairPlay || '').trim();

      if (!voterName) {
        showToast('⚠️ Por favor selecciona tu nombre en la lista de participantes.');
        return;
      }
      if ((paintOpen && paintVote === voterName) || (fairOpen && fairPlayVote === voterName)) {
        showToast('⚠️ No puedes votar por ti mismo.');
        return;
      }
      if ((paintOpen && !paintVote) && (fairOpen && !fairPlayVote)) {
        showToast('⚠️ Selecciona al menos un candidato para emitir tu voto.');
        return;
      }
      if (paintOpen && !fairOpen && !paintVote) {
        showToast('⚠️ Selecciona un candidato para Mejor Pintura.');
        return;
      }
      if (fairOpen && !paintOpen && !fairPlayVote) {
        showToast('⚠️ Selecciona un candidato para Premio Fair Play.');
        return;
      }

      const btnVoteSubmit = document.getElementById('btnSubmitVoteModal');
      if (btnVoteSubmit) {
        btnVoteSubmit.disabled = true;
        btnVoteSubmit.textContent = '⏳ Guardando voto...';
      }

      const voteSaved = await submitPlayerVoteToCloud(
        voterKey,
        {
          voter: voterName,
          paintVote,
          fairPlayVote,
          updatedAt: Date.now()
        },
        lockedRoomCode
      );

      if (!voteSaved) {
        if (btnVoteSubmit) {
          btnVoteSubmit.disabled = false;
          btnVoteSubmit.textContent = '🗳️ Registrar Mi Voto';
        }
        showToast('⚠️ Error de conexión con la base de datos. Verifica tu internet e intenta nuevamente.');
        return;
      }

      if (!myId.name) {
        setMyPlayerIdentity(lockedRoomCode, voterName, getEntityArmy(voterName), false);
      }

      closeModal();
      renderSpecialAwardsCards();
      showToast(`✅ ¡Voto de ${voterName} registrado con éxito!`);
    });
  }

  function finalizeTournamentFlow() {
    if (!isAdminMode) {
      showToast('🔒 Solo el Organizador puede finalizar oficialmente el torneo.');
      return;
    }

    openConfirmModal(
      '🏁 Finalizar Torneo y Cerrar ID Oficialmente',
      `¿Confirmas que deseas finalizar el torneo y cerrar el ID "${state.roomCode}"? Se cerrarán definitivamente las inscripciones, las votaciones de Pintura/Fair Play y la edición de puntajes, quedando el Podio Oficial sellado en modo consulta.`,
      '🏁 Sí, Finalizar y Cerrar ID',
      () => {
        state.rounds.forEach((r) => {
          r.finished = true;
          if (r.timer && r.timer.running) {
            r.timer.remainingMs = getRoundRemainingMs(r);
            r.timer.endTime = null;
            r.timer.running = false;
          }
        });
        state.tournamentFinished = true;
        state.registrationOpen = false;
        state.votingPaintOpen = false;
        state.votingFairPlayOpen = false;
        saveState();
        switchTab('podium');
        renderAll();
        updateLiveSyncBadge(`🟢 ${state.roomCode}`, true);
        launchPodiumCelebration();
        showToast(`🔒 ¡Torneo ${state.roomCode} finalizado y cerrado oficialmente!`);
      }
    );
  }

  function reopenTournamentFlow() {
    if (!isAdminMode) return;
    openConfirmModal(
      '🔓 Reabrir ID del Torneo',
      `¿Deseas reabrir el ID "${state.roomCode}" para realizar alguna corrección en puntajes o votaciones?`,
      '🔓 Sí, Reabrir Torneo',
      () => {
        state.tournamentFinished = false;
        saveState();
        renderAll();
        updateLiveSyncBadge(`🟢 ${state.roomCode}`, true);
        showToast(`🔓 Torneo ${state.roomCode} reabierto para edición del Organizador.`);
      }
    );
  }

  function promptCreateNewRoom() {
    openConfirmModal(
      'Crear Nuevo Torneo (Nuevo ID)',
      '¿Deseas levantar un nuevo torneo con un código ID nuevo? Quedarás automáticamente como Organizador de la nueva sala y el torneo anterior seguirá guardado bajo su propio código.',
      '➕ Crear Nuevo Torneo',
      () => {
        const newCode = generateRoomCode();
        state = buildCleanInitialState(newCode);
        ensureConsistency();
        markRoomAsOwned(newCode);
        isAdminMode = true;
        syncUrlWithRoomCode(newCode);
        saveState();
        startCloudRealtimeSync();
        applyRoleModeUI();
        switchTab('setup');
        renderAll();
        showToast(`Nueva sala creada con el código ${newCode}. Rol activo: Organizador.`);
      }
    );
  }

  function openAdminAndCloudModal() {
    const shareUrl = `${window.location.origin}${window.location.pathname}?code=${state.roomCode}`;
    const iOwnThisRoom = isRoomOwnedByMe(state.roomCode);

    openModal(
      'Sala de Torneo',
      `
        <h4>Código de Sala Activo: <span style="color:var(--gold-bright); letter-spacing:0.12em;">${escapeHtml(state.roomCode || '------')}</span></h4>
        <p style="margin-bottom:14px;">
          Tu rol en este torneo: <strong style="color:var(--gold-bright);">${
            isAdminMode
              ? 'Organizador (Puedes configurar, emparejar y editar resultados)'
              : iOwnThisRoom
              ? 'Jugador (Previsualizando tu propio torneo)'
              : 'Jugador (Siguiendo en vivo Rondas, Mesas y Podio)'
          }</strong>
        </p>

        <div style="display:flex; gap:10px; align-items:center; flex-wrap:wrap; margin-bottom:18px;">
          ${
            iOwnThisRoom && isAdminMode
              ? `<button type="button" class="btn-elven-outline btn-sm" id="btnLockToSpectator">Cambiar a Jugador</button>`
              : ''
          }
          ${
            iOwnThisRoom && !isAdminMode
              ? `<button type="button" class="btn-gold-cta btn-sm" id="btnReturnToHost">Volver a Organizador</button>`
              : ''
          }
          <button type="button" class="btn-gold-cta btn-sm" id="btnCreateOwnTournamentFromModal">➕ Crear Nuevo Torneo (Nuevo ID)</button>
        </div>

        <div style="background:rgba(9,17,15,0.85); border:1px solid var(--border-gold); border-radius:10px; padding:12px 14px;">
          <span class="stat-label">LINK DE INVITACIÓN PARA JUGADORES (ID: ${escapeHtml(state.roomCode || '------')}):</span>
          <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap; margin-top:6px;">
            <input type="text" readonly value="${escapeHtml(shareUrl)}" id="inputSharePlayerLink" style="flex:1; min-width:180px; font-size:0.78rem;" />
            <button type="button" class="btn-elven-outline btn-sm" id="btnCopyShareLink">📋 Copiar Link</button>
          </div>
        </div>
      `
    );

    const btnReturnHost = document.getElementById('btnReturnToHost');
    if (btnReturnHost) {
      btnReturnHost.addEventListener('click', () => {
        isAdminMode = true;
        applyRoleModeUI();
        closeModal();
        showToast('Modo Organizador activado.');
      });
    }

    const btnLock = document.getElementById('btnLockToSpectator');
    if (btnLock) {
      btnLock.addEventListener('click', () => {
        isAdminMode = false;
        applyRoleModeUI();
        closeModal();
        showToast('Modo Jugador activado (solo lectura).');
      });
    }

    const btnCreateNew = document.getElementById('btnCreateOwnTournamentFromModal');
    if (btnCreateNew) {
      btnCreateNew.addEventListener('click', () => {
        closeModal();
        promptCreateNewRoom();
      });
    }

    const btnCopy = document.getElementById('btnCopyShareLink');
    if (btnCopy) {
      btnCopy.addEventListener('click', () => {
        const inp = document.getElementById('inputSharePlayerLink');
        if (inp) {
          navigator.clipboard.writeText(inp.value);
          showToast('📋 Link para jugadores copiado al portapapeles.');
        }
      });
    }
  }

  function buildIndividualMatchesFromTeamClashes(rObj) {
    if (!rObj.teamClashes || rObj.teamClashes.length === 0) {
      renderTeamClashesPanel(rObj);
    }
    const matches = [];
    (rObj.teamClashes || []).forEach((clash) => {
      const t1 = state.teams.find((t) => t.name === clash.team1);
      const t2 = state.teams.find((t) => t.name === clash.team2);
      const grp = state.tableGroups.find((g) => g.name === clash.tableGroup);
      for (let k = 0; k < state.membersPerTeam; k++) {
        matches.push({
          table: grp?.tables[k] || `Mesa ${matches.length + 1}`,
          team1: clash.team1,
          team2: clash.team2,
          p1: {
            name: t1?.members[k] || `${clash.team1}_${k + 1}`,
            paint: 's',
            delay: 'N/A',
            surrender: false,
            abandonMatch: false,
            abandonTournament: false,
            result: '',
            tp: 0,
            vp: 0,
            manualTp: false
          },
          p2: {
            name: t2?.members[k] || `${clash.team2}_${k + 1}`,
            paint: 's',
            delay: 'N/A',
            surrender: false,
            abandonMatch: false,
            abandonTournament: false,
            result: '',
            tp: 0,
            vp: 0,
            manualTp: false
          }
        });
      }
    });
    rObj.matches = matches;
    rObj.paired = true;
    saveState();
    renderAll();
  }

  function openModal(title, htmlContent) {
    document.getElementById('modalTitle').textContent = title;
    document.getElementById('modalBodyContent').innerHTML = htmlContent;
    const modalEl = document.getElementById('elvenModal');
    modalEl.classList.remove('hidden', 'is-minimized');
    const minBtn = document.getElementById('btnMinimizeModal');
    if (minBtn) minBtn.textContent = '—';
  }

  function openConfirmModal(title, message, confirmLabel, onConfirm) {
    document.getElementById('modalTitle').textContent = title;
    const bodyEl = document.getElementById('modalBodyContent');
    bodyEl.innerHTML = `
      <p style="margin-bottom: 20px; font-size: 0.95rem; color: var(--text-ivory);">${escapeHtml(message)}</p>
      <div class="modal-confirm-actions">
        <button type="button" class="btn-elven-outline" id="btnCancelConfirmModal">Cancelar</button>
        <button type="button" class="btn-dark-danger" id="btnAcceptConfirmModal">${escapeHtml(confirmLabel)}</button>
      </div>
    `;
    const modalEl = document.getElementById('elvenModal');
    modalEl.classList.remove('hidden', 'is-minimized');
    const minBtn = document.getElementById('btnMinimizeModal');
    if (minBtn) minBtn.textContent = '—';

    document.getElementById('btnCancelConfirmModal').addEventListener('click', closeModal);
    document.getElementById('btnAcceptConfirmModal').addEventListener('click', () => {
      closeModal();
      if (typeof onConfirm === 'function') onConfirm();
    });
  }

  function closeModal() {
    document.getElementById('elvenModal').classList.add('hidden');
  }

  // =========================================================================
  // 7. ANIMACIÓN DE CELEBRACIÓN DEL PODIO FINAL (CONFETI Y PEDESTALES)
  // =========================================================================

  let confettiAnimId = null;

  function launchPodiumCelebration() {
    const standings = calculateStandings();
    if (standings.length === 0) {
      showToast('⚠️ Aún no hay participantes registrados en el Podio.');
      return;
    }

    const active = standings.filter((s) => !s.abandoned);
    const first = standings[0];
    const second = standings[1];
    const third = standings[2];
    const lastActive = active.length > 3 ? active[active.length - 1] : null;

    document.getElementById('celebrationTournamentTitle').textContent =
      state.tournamentName || 'TORNEO MESBG';

    const pedestalsEl = document.getElementById('celebrationPedestalsContainer');
    pedestalsEl.innerHTML = `
      <!-- 2° Lugar (Izquierda) -->
      <div class="pedestal-column rank-2">
        <div class="pedestal-avatar-crest">🥈</div>
        <div class="pedestal-box">
          <span class="pedestal-place-tag" style="color:#e0e0e0;">2° LUGAR • PLATA</span>
          <strong class="pedestal-player-name">${escapeHtml(second ? second.name : '-')}</strong>
          ${
            second
              ? `<span class="pedestal-score-pill"><strong>${second.finalTp}</strong> PT • Dif ${
                  second.vpDiff > 0 ? '+' + second.vpDiff : second.vpDiff
                } • ${second.vpFavor} PV</span>`
              : ''
          }
        </div>
      </div>

      <!-- 1° Lugar (Centro - Campeón) -->
      <div class="pedestal-column rank-1">
        <div class="pedestal-avatar-crest">👑</div>
        <div class="pedestal-box">
          <span class="pedestal-place-tag" style="color:#ffd700;">🥇 1° LUGAR • CAMPEÓN</span>
          <strong class="pedestal-player-name">${escapeHtml(first ? first.name : '-')}</strong>
          ${
            first
              ? `<span class="pedestal-score-pill"><strong>${first.finalTp}</strong> PT • Dif ${
                  first.vpDiff > 0 ? '+' + first.vpDiff : first.vpDiff
                } • ${first.vpFavor} PV</span>`
              : ''
          }
        </div>
      </div>

      <!-- 3° Lugar (Derecha) -->
      <div class="pedestal-column rank-3">
        <div class="pedestal-avatar-crest">🥉</div>
        <div class="pedestal-box">
          <span class="pedestal-place-tag" style="color:#e89b54;">3° LUGAR • BRONCE</span>
          <strong class="pedestal-player-name">${escapeHtml(third ? third.name : '-')}</strong>
          ${
            third
              ? `<span class="pedestal-score-pill"><strong>${third.finalTp}</strong> PT • Dif ${
                  third.vpDiff > 0 ? '+' + third.vpDiff : third.vpDiff
                } • ${third.vpFavor} PV</span>`
              : ''
          }
        </div>
      </div>
    `;

    const spoonSlot = document.getElementById('celebrationSpoonSlot');
    spoonSlot.innerHTML = lastActive
      ? `<div class="celebration-spoon-badge">
          <span>🪵</span>
          <span><strong>Cuchara de Palo (Último Activo):</strong> ${escapeHtml(lastActive.name)} (${lastActive.finalTp} PT)</span>
        </div>`
      : '';

    const specialAwardsSlot = document.getElementById('celebrationSpecialAwardsSlot');
    if (specialAwardsSlot) {
      const awards = calculateSpecialAwards(standings);
      const awardPills = [];

      if (awards.lethalGeneral) {
        awardPills.push(
          `<span class="celebration-award-pill">⚔️ <strong>General Más Letal:</strong> ${escapeHtml(
            awards.lethalGeneral.name
          )} (${awards.lethalGeneral.vpFavor} PV)</span>`
        );
      }

      if (awards.bestPaint && awards.bestPaint.votes > 0) {
        awardPills.push(
          `<span class="celebration-award-pill">🎨 <strong>Mejor Pintura:</strong> ${escapeHtml(
            awards.bestPaint.name
          )} (${awards.bestPaint.votes} voto${awards.bestPaint.votes === 1 ? '' : 's'})</span>`
        );
      }

      if (awards.bestFairPlay && awards.bestFairPlay.votes > 0) {
        awardPills.push(
          `<span class="celebration-award-pill">🤝 <strong>Premio Fair Play:</strong> ${escapeHtml(
            awards.bestFairPlay.name
          )} (${awards.bestFairPlay.votes} voto${awards.bestFairPlay.votes === 1 ? '' : 's'})</span>`
        );
      }

      specialAwardsSlot.innerHTML =
        awardPills.length > 0
          ? `<div class="celebration-special-awards">${awardPills.join('')}</div>`
          : '';
    }

    const overlay = document.getElementById('podiumCelebrationOverlay');
    overlay.classList.remove('hidden');
    startConfettiAnimation();
  }

  function closePodiumCelebration() {
    document.getElementById('podiumCelebrationOverlay').classList.add('hidden');
    if (confettiAnimId) {
      cancelAnimationFrame(confettiAnimId);
      confettiAnimId = null;
    }
  }

  function startConfettiAnimation() {
    const canvas = document.getElementById('confettiCanvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;

    const colors = ['#ffd700', '#f3d486', '#d4a843', '#e0e0e0', '#cd7f32', '#59cf99', '#fff8dc'];
    const particles = Array.from({ length: 110 }, () => ({
      x: Math.random() * canvas.width,
      y: Math.random() * canvas.height - canvas.height,
      w: Math.random() * 9 + 4,
      h: Math.random() * 5 + 3,
      color: colors[Math.floor(Math.random() * colors.length)],
      vy: Math.random() * 2.6 + 1.2,
      vx: (Math.random() - 0.5) * 1.4,
      angle: Math.random() * Math.PI * 2,
      spin: (Math.random() - 0.5) * 0.08,
      isStar: Math.random() < 0.25
    }));

    if (confettiAnimId) cancelAnimationFrame(confettiAnimId);

    function drawFrame() {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      particles.forEach((p) => {
        p.y += p.vy;
        p.x += p.vx + Math.sin(p.angle) * 0.4;
        p.angle += p.spin;

        if (p.y > canvas.height + 20) {
          p.y = -20;
          p.x = Math.random() * canvas.width;
        }

        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.angle);
        ctx.fillStyle = p.color;

        if (p.isStar) {
          ctx.beginPath();
          ctx.arc(0, 0, p.w * 0.4, 0, Math.PI * 2);
          ctx.fill();
        } else {
          ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
        }
        ctx.restore();
      });

      confettiAnimId = requestAnimationFrame(drawFrame);
    }

    drawFrame();
  }

  // =========================================================================
  // 8. GENERADOR DE IMAGEN PARA HISTORIA DE INSTAGRAM (1080 x 1920 PX)
  // =========================================================================

  function loadImagePromise(src) {
    return new Promise((resolve) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => resolve(img);
      img.onerror = () => resolve(null);
      img.src = src;
    });
  }

  function drawRoundedRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
  }

  async function downloadInstagramStory() {
    const standings = calculateStandings();
    if (standings.length === 0) {
      showToast('⚠️ No hay participantes registrados para generar la imagen.');
      return;
    }

    showToast('🎨 Generando imagen en formato Historia de Instagram (1080×1920)...');

    const W = 1080;
    const H = 1920;
    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d');

    // 1. Cargar recursos visuales
    const [bgImg, logoDeazul, logoComunidad] = await Promise.all([
      loadImagePromise('assets/bg-rivendell.jpg'),
      loadImagePromise('assets/logo-deazul.png'),
      loadImagePromise('assets/logo-comunidad.png')
    ]);

    // 2. Fondo nocturno Rivendel + Viñeta verde bosque / dorado
    ctx.fillStyle = '#08110f';
    ctx.fillRect(0, 0, W, H);

    if (bgImg) {
      const scale = Math.max(W / bgImg.width, H / bgImg.height);
      const dw = bgImg.width * scale;
      const dh = bgImg.height * scale;
      ctx.globalAlpha = 0.42;
      ctx.drawImage(bgImg, (W - dw) / 2, (H - dh) / 2, dw, dh);
      ctx.globalAlpha = 1;
    }

    const grad = ctx.createLinearGradient(0, 0, 0, H);
    grad.addColorStop(0, 'rgba(7, 16, 14, 0.84)');
    grad.addColorStop(0.35, 'rgba(10, 22, 19, 0.88)');
    grad.addColorStop(1, 'rgba(6, 13, 11, 0.96)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, W, H);

    // 3. Marco Ornamental Élfico Doble
    ctx.strokeStyle = 'rgba(212, 168, 67, 0.72)';
    ctx.lineWidth = 3;
    drawRoundedRect(ctx, 28, 28, W - 56, H - 56, 26);
    ctx.stroke();

    ctx.strokeStyle = 'rgba(212, 168, 67, 0.28)';
    ctx.lineWidth = 1.5;
    drawRoundedRect(ctx, 40, 40, W - 80, H - 80, 20);
    ctx.stroke();

    // 4. Logos superiores (DeAzul y Comunidad MESBG Chile)
    const logoY = 64;
    const logoSize = 116;
    if (logoDeazul && logoComunidad) {
      ctx.drawImage(logoDeazul, W / 2 - logoSize - 18, logoY, logoSize, logoSize);
      ctx.drawImage(logoComunidad, W / 2 + 18, logoY, logoSize, logoSize);
    } else if (logoDeazul) {
      ctx.drawImage(logoDeazul, (W - logoSize) / 2, logoY, logoSize, logoSize);
    }

    // 5. Títulos del Torneo
    ctx.textAlign = 'center';
    ctx.fillStyle = '#ebd79a';
    ctx.font = '700 22px Cinzel, serif';
    ctx.fillText('COMUNIDAD MESBG CHILE', W / 2, 214);

    ctx.fillStyle = '#ffffff';
    ctx.font = '800 46px Cinzel, serif';
    const mainTitle = (state.tournamentName || 'TORNEO MESBG').toUpperCase();
    ctx.fillText(mainTitle.slice(0, 34), W / 2, 268);

    const modeLabels = {
      individual: 'MODALIDAD INDIVIDUAL (1 VS 1)',
      pairs: 'MODALIDAD PAREJAS (2 VS 2)',
      teams: 'MODALIDAD EQUIPOS (DUELOS 4VS4)'
    };
    ctx.fillStyle = '#94a69e';
    ctx.font = '600 19px "Plus Jakarta Sans", sans-serif';
    ctx.fillText(
      `${modeLabels[state.mode]}  •  ${state.totalRounds} RONDAS  •  TABLA OFICIAL DE POSICIONES`,
      W / 2,
      302
    );

    // Línea divisoria dorada
    ctx.strokeStyle = 'rgba(212, 168, 67, 0.55)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(160, 324);
    ctx.lineTo(W - 160, 324);
    ctx.stroke();

    // 6. Tarjetas Destacadas del Top 3 (Podio)
    const topY = 346;
    const cardH = 148;
    const cardW = 304;
    const gap = 22;
    const startX = (W - (cardW * 3 + gap * 2)) / 2;

    const top3Specs = [
      {
        idx: 1,
        label: '🥈 2° LUGAR',
        border: '#d7d7d7',
        bg: 'rgba(68, 76, 80, 0.36)',
        accent: '#e6e6e6',
        x: startX
      },
      {
        idx: 0,
        label: '👑 1° CAMPEÓN',
        border: '#ffd700',
        bg: 'rgba(110, 84, 18, 0.48)',
        accent: '#ffd700',
        x: startX + cardW + gap
      },
      {
        idx: 2,
        label: '🥉 3° LUGAR',
        border: '#cd7f32',
        bg: 'rgba(104, 58, 24, 0.42)',
        accent: '#f0a660',
        x: startX + (cardW + gap) * 2
      }
    ];

    top3Specs.forEach((spec) => {
      const player = standings[spec.idx];
      ctx.fillStyle = spec.bg;
      ctx.strokeStyle = spec.border;
      ctx.lineWidth = spec.idx === 0 ? 3 : 2;
      drawRoundedRect(ctx, spec.x, topY, cardW, cardH, 16);
      ctx.fill();
      ctx.stroke();

      ctx.fillStyle = spec.accent;
      ctx.font = '800 18px Cinzel, serif';
      ctx.fillText(spec.label, spec.x + cardW / 2, topY + 36);

      ctx.fillStyle = '#ffffff';
      ctx.font = '700 23px "Plus Jakarta Sans", sans-serif';
      const pName = player ? player.name : '-';
      ctx.fillText(pName.length > 20 ? pName.slice(0, 19) + '…' : pName, spec.x + cardW / 2, topY + 78);

      if (player) {
        const diffTxt = player.vpDiff > 0 ? `+${player.vpDiff}` : String(player.vpDiff);
        ctx.fillStyle = '#ede6d3';
        ctx.font = '600 18px "Plus Jakarta Sans", sans-serif';
        ctx.fillText(
          `${player.finalTp} PT  •  Dif ${diffTxt}  •  ${player.vpFavor} PV`,
          spec.x + cardW / 2,
          topY + 118
        );
      }
    });

    // 7. Tabla Completa de Participantes y sus Lugares en el Torneo
    const tableTopY = 520;
    const tableBottomLimit = 1755;
    const availableH = tableBottomLimit - tableTopY;
    const totalRows = standings.length;
    const activePlayers = standings.filter((s) => !s.abandoned);
    const lastActiveName =
      activePlayers.length > 3 ? activePlayers[activePlayers.length - 1].name : null;

    // Si hay más de 20 participantes, usamos diseño de 2 columnas para que todos entren cómodamente
    const useTwoCols = totalRows > 20;
    const rowsPerCol = useTwoCols ? Math.ceil(totalRows / 2) : totalRows;
    const headerH = 44;
    const rowH = Math.min(54, Math.max(28, Math.floor((availableH - headerH - 12) / Math.max(1, rowsPerCol))));
    const fontSize = rowH >= 44 ? 21 : rowH >= 36 ? 18 : 15;

    function renderTableColumn(items, offsetIndex, colX, colW) {
      // Encabezado de tabla
      ctx.fillStyle = 'rgba(18, 34, 29, 0.95)';
      ctx.strokeStyle = 'rgba(212, 168, 67, 0.55)';
      ctx.lineWidth = 1.5;
      drawRoundedRect(ctx, colX, tableTopY, colW, headerH, 10);
      ctx.fill();
      ctx.stroke();

      ctx.fillStyle = '#d4a843';
      ctx.font = `700 ${Math.max(14, fontSize - 3)}px Cinzel, serif`;
      ctx.textAlign = 'left';
      ctx.fillText('LUGAR', colX + 18, tableTopY + 28);
      ctx.fillText(state.mode === 'teams' ? 'EQUIPO' : 'PARTICIPANTE', colX + 105, tableTopY + 28);

      ctx.textAlign = 'center';
      ctx.fillText('PT FINAL', colX + colW - 195, tableTopY + 28);
      ctx.fillText('DIF. PV', colX + colW - 105, tableTopY + 28);
      ctx.fillText('PV', colX + colW - 38, tableTopY + 28);

      items.forEach((row, idx) => {
        const pos = offsetIndex + idx + 1;
        const y = tableTopY + headerH + 6 + idx * rowH;
        const isLastActive = !row.abandoned && lastActiveName && row.name === lastActiveName && pos > 3;

        // Fondo de fila según posición
        if (pos === 1) ctx.fillStyle = 'rgba(255, 215, 0, 0.18)';
        else if (pos === 2) ctx.fillStyle = 'rgba(215, 215, 215, 0.14)';
        else if (pos === 3) ctx.fillStyle = 'rgba(205, 127, 50, 0.16)';
        else if (isLastActive) ctx.fillStyle = 'rgba(163, 94, 66, 0.22)';
        else ctx.fillStyle = idx % 2 === 0 ? 'rgba(14, 26, 22, 0.78)' : 'rgba(20, 35, 30, 0.58)';

        drawRoundedRect(ctx, colX, y, colW, rowH - 4, 7);
        ctx.fill();

        const textY = y + (rowH - 4) / 2 + fontSize * 0.35;

        // Lugar
        ctx.textAlign = 'left';
        ctx.font = `800 ${fontSize}px Cinzel, serif`;
        if (pos === 1) ctx.fillStyle = '#ffd700';
        else if (pos === 2) ctx.fillStyle = '#e0e0e0';
        else if (pos === 3) ctx.fillStyle = '#e89b54';
        else ctx.fillStyle = '#c2a05a';
        ctx.fillText(`#${pos}`, colX + 18, textY);

        // Nombre del jugador/equipo
        ctx.fillStyle = row.abandoned ? '#94a69e' : '#ffffff';
        ctx.font = `600 ${fontSize}px "Plus Jakarta Sans", sans-serif`;
        const maxChars = useTwoCols ? 18 : 34;
        const displayName =
          row.name.length > maxChars ? row.name.slice(0, maxChars - 1) + '…' : row.name;
        ctx.fillText(displayName, colX + 105, textY);

        // PT Final
        ctx.textAlign = 'center';
        ctx.fillStyle = '#ebd79a';
        ctx.font = `800 ${fontSize}px "Plus Jakarta Sans", sans-serif`;
        ctx.fillText(String(row.finalTp), colX + colW - 195, textY);

        // Dif PV
        const diffStr = row.vpDiff > 0 ? `+${row.vpDiff}` : String(row.vpDiff);
        ctx.fillStyle = row.vpDiff > 0 ? '#59cf99' : row.vpDiff < 0 ? '#ff8b88' : '#d5cebc';
        ctx.font = `600 ${fontSize}px "Plus Jakarta Sans", sans-serif`;
        ctx.fillText(diffStr, colX + colW - 105, textY);

        // PV a Favor
        ctx.fillStyle = '#d5cebc';
        ctx.fillText(String(row.vpFavor), colX + colW - 38, textY);
      });
    }

    if (!useTwoCols) {
      renderTableColumn(standings, 0, 64, W - 128);
    } else {
      const colW = (W - 148) / 2;
      const leftItems = standings.slice(0, rowsPerCol);
      const rightItems = standings.slice(rowsPerCol);
      renderTableColumn(leftItems, 0, 64, colW);
      renderTableColumn(rightItems, rowsPerCol, 64 + colW + 20, colW);
    }

    // 8. Pie de Historia: Instagram y Créditos DeazuL 2026
    ctx.strokeStyle = 'rgba(212, 168, 67, 0.45)';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(180, 1785);
    ctx.lineTo(W - 180, 1785);
    ctx.stroke();

    ctx.textAlign = 'center';
    ctx.fillStyle = '#ebd79a';
    ctx.font = '700 20px Cinzel, serif';
    ctx.fillText('▶ YT: @DeAzul_boardgames   •   📸 IG: @lain_cl   •   📸 IG: @comunidad_mesbg_cl', W / 2, 1826);

    ctx.fillStyle = '#94a69e';
    ctx.font = '600 18px Cinzel, serif';
    ctx.fillText('CREADO POR EQUIPO DEAZUL 2026', W / 2, 1862);

    // 9. Descargar PNG
    const dataUrl = canvas.toDataURL('image/png');
    const a = document.createElement('a');
    a.href = dataUrl;
    const cleanName = (state.tournamentName || 'Torneo_MESBG').replace(/[^a-zA-Z0-9_-]/g, '_');
    a.download = `Resultado_Podio_${cleanName}.png`;
    a.click();
    showToast('✅ Imagen de resultado descargada.');
  }

  // Inicialización al cargar el DOM
  document.addEventListener('DOMContentLoaded', () => {
    loadState();
    initEventListeners();
    applyRoleModeUI();
    renderAll();
    startCloudRealtimeSync();
    startGlobalTimerTicker();
  });
})();
