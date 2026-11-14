/**
 * TORNEO MESBG — MOTOR DE GESTIÓN DE TORNEOS
 */

(function () {
  const STORAGE_KEY = 'mesbg_torneo_state_v2';
  const ROOMS_REGISTRY_KEY = 'mesbg_rooms_registry_v1';
  const OWNED_ROOMS_KEY = 'mesbg_owned_rooms_v1';
  const FIREBASE_URL_STORAGE_KEY = 'mesbg_firebase_db_url';
  const ADMIN_SESSION_KEY = 'mesbg_admin_unlocked';

  // Estado central de la aplicación
  let state = buildCleanInitialState();
  let isAdminMode = false;
  let searchFilterQuery = '';
  let cloudEventSource = null;
  let cloudPollTimer = null;
  let isApplyingRemoteUpdate = false;

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

  function normalizeState(s) {
    if (!s || typeof s !== 'object') return buildCleanInitialState();
    s.roomCode = (s.roomCode || generateRoomCode()).toUpperCase();
    s.tournamentName = s.tournamentName || 'Torneo MESBG';
    s.mode = s.mode || 'individual';
    s.scoringSystem = s.scoringSystem || 'expanded';
    s.totalRounds = Math.max(1, Number(s.totalRounds) || 4);
    s.totalTables = Math.max(1, Number(s.totalTables) || 6);
    s.teamCount = Math.max(2, Number(s.teamCount) || 4);
    s.membersPerTeam = Math.max(2, Number(s.membersPerTeam) || 4);
    s.tablesPerTeam = Math.max(1, Number(s.tablesPerTeam) || 4);
    s.activeRound = Math.max(1, Number(s.activeRound) || 1);
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
          matches: []
        };
        s.rounds.push(rObj);
      } else {
        rObj.matches = Array.isArray(rObj.matches) ? rObj.matches : [];
        rObj.teamClashes = Array.isArray(rObj.teamClashes) ? rObj.teamClashes : [];
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
        matches: []
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
      if (localMatch && typeof localMatch === 'object') {
        state = normalizeState(localMatch);
      } else {
        state = buildCleanInitialState(urlCodeParam);
      }
      isAdminMode = isRoomOwnedByMe(urlCodeParam);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      return;
    }

    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') {
          if (!parsed.roomCode) {
            parsed.roomCode = generateRoomCode();
            markRoomAsOwned(parsed.roomCode);
          }
          state = normalizeState(parsed);
          saveRoomToLocalRegistry(state);
          // Si este navegador no tiene ninguna sala propia aún y no entró con ?code, es dueño de su sala inicial
          if (getOwnedRooms().length === 0) {
            markRoomAsOwned(state.roomCode);
          }
          isAdminMode = isRoomOwnedByMe(state.roomCode);
          return;
        }
      }
    } catch (e) {
      console.warn('Error leyendo localStorage:', e);
    }

    state = buildCleanInitialState();
    markRoomAsOwned(state.roomCode);
    isAdminMode = true;
    saveState();
  }

  // =========================================================================
  // 1B. SINCRONIZACIÓN EN TIEMPO REAL POR CÓDIGO DE SALA (COMPANION + FIREBASE)
  // =========================================================================

  function getFirebaseDbUrl() {
    const fromConfig =
      window.MESBG_CLOUD_CONFIG && window.MESBG_CLOUD_CONFIG.FIREBASE_DB_URL
        ? window.MESBG_CLOUD_CONFIG.FIREBASE_DB_URL.trim()
        : '';
    const fromLocal = localStorage.getItem(FIREBASE_URL_STORAGE_KEY) || '';
    const url = (fromConfig || fromLocal).replace(/\/+$/, '');
    return url;
  }

  function getRoomCloudEndpoint(roomCode) {
    const dbUrl = getFirebaseDbUrl();
    const code = (roomCode || state.roomCode || 'DEFAULT').toUpperCase();
    if (!dbUrl) return '';
    return `${dbUrl}/torneos/${code}.json`;
  }

  function getAdminPin() {
    return (window.MESBG_CLOUD_CONFIG && window.MESBG_CLOUD_CONFIG.ADMIN_PIN) || 'deazul2026';
  }

  function updateLiveSyncBadge(statusText, isOnline) {
    const badge = document.getElementById('liveSyncBadge');
    if (!badge) return;
    badge.textContent = statusText;
    badge.classList.toggle('online', !!isOnline);
  }

  async function pushStateToCloud() {
    const endpoint = getRoomCloudEndpoint(state.roomCode);
    if (!endpoint) return;

    try {
      updateLiveSyncBadge(`🔄 SYNC (${state.roomCode})`, true);
      const res = await fetch(endpoint, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(state)
      });
      if (res.ok) {
        updateLiveSyncBadge(`🟢 SALA ${state.roomCode}`, true);
      } else {
        updateLiveSyncBadge('⚠️ ERROR NUBE', false);
      }
    } catch (err) {
      console.warn('Error al sincronizar con Firebase:', err);
      updateLiveSyncBadge('⚠️ SIN CONEXIÓN', false);
    }
  }

  async function pullStateFromCloud() {
    const endpoint = getRoomCloudEndpoint(state.roomCode);
    if (!endpoint) {
      updateLiveSyncBadge(`⚪ SALA LOCAL (${state.roomCode})`, false);
      return false;
    }

    try {
      const res = await fetch(endpoint);
      if (!res.ok) return false;
      const remoteData = await res.json();
      if (remoteData && typeof remoteData === 'object' && (remoteData.roomCode || Array.isArray(remoteData.rounds))) {
        const cleanRemote = normalizeState(remoteData);
        const localTime = Number(state.updatedAt || 0);
        const remoteTime = Number(cleanRemote.updatedAt || 0);
        const localPlayersCount = Array.isArray(state.players) ? state.players.length : 0;
        if (!isAdminMode || remoteTime > localTime || localPlayersCount === 0) {
          isApplyingRemoteUpdate = true;
          state = cleanRemote;
          localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
          saveRoomToLocalRegistry(state);
          renderAll();
          isApplyingRemoteUpdate = false;
        }
        updateLiveSyncBadge(`🟢 SALA ${state.roomCode}`, true);
        return true;
      }
      // Si la sala aún no existe en Firebase y este navegador es el organizador, publicarla automáticamente
      if (isAdminMode && state && Array.isArray(state.rounds)) {
        await pushStateToCloud();
        return true;
      }
      updateLiveSyncBadge(`🟢 SALA ${state.roomCode}`, true);
      return false;
    } catch (err) {
      console.warn('Error en pullStateFromCloud:', err);
      updateLiveSyncBadge('⚠️ SIN CONEXIÓN', false);
      return false;
    }
  }

  async function joinTournamentByCode(rawCode) {
    const code = (rawCode || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (code.length < 4) {
      showToast('⚠️ Ingresa un código de torneo válido (ej: M8K4R2).');
      return;
    }

    const endpoint = getRoomCloudEndpoint(code);
    if (endpoint) {
      showToast(`🔍 Buscando torneo "${code}" en vivo...`);
      try {
        const res = await fetch(endpoint);
        if (res.ok) {
          const remoteData = await res.json();
          if (remoteData && typeof remoteData === 'object' && (remoteData.roomCode || Array.isArray(remoteData.rounds))) {
            isApplyingRemoteUpdate = true;
            state = normalizeState(remoteData);
            state.roomCode = code;
            isAdminMode = isRoomOwnedByMe(code);
            localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
            saveRoomToLocalRegistry(state);
            applyRoleModeUI();
            switchTab(isAdminMode ? 'setup' : 'rounds');
            startCloudRealtimeSync();
            isApplyingRemoteUpdate = false;
            showToast(
              isAdminMode
                ? `👑 Conectado como Host a tu torneo "${state.tournamentName}" (ID: ${code}).`
                : `👁️ Conectado como Jugador al torneo "${state.tournamentName}" (ID: ${code}).`
            );
            return;
          }
        }
      } catch (e) {
        console.warn('Error buscando sala en Firebase:', e);
      }
    }

    // Buscar en el registro local del navegador (útil en modo local o entre pestañas)
    const localRoom = getRoomFromLocalRegistry(code);
    if (localRoom && typeof localRoom === 'object') {
      isApplyingRemoteUpdate = true;
      state = normalizeState(localRoom);
      state.roomCode = code;
      isAdminMode = isRoomOwnedByMe(code);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      applyRoleModeUI();
      switchTab(isAdminMode ? 'setup' : 'rounds');
      startCloudRealtimeSync();
      isApplyingRemoteUpdate = false;
      showToast(
        isAdminMode
          ? `👑 Torneo "${state.tournamentName}" (ID: ${code}) cargado en Modo Host.`
          : `👁️ Torneo "${state.tournamentName}" (ID: ${code}) cargado en Vista Jugador.`
      );
      return;
    }

    showToast(`⚠️ No se encontró ningún torneo activo con el código "${code}".`);
  }

  function startCloudRealtimeSync() {
    if (cloudEventSource) {
      cloudEventSource.close();
      cloudEventSource = null;
    }
    if (cloudPollTimer) {
      clearInterval(cloudPollTimer);
      cloudPollTimer = null;
    }

    const endpoint = getRoomCloudEndpoint(state.roomCode);
    if (!endpoint) {
      updateLiveSyncBadge(`⚪ SALA LOCAL (${state.roomCode})`, false);
      return;
    }

    pullStateFromCloud();

    try {
      const sse = new EventSource(endpoint);
      sse.addEventListener('put', (ev) => {
        try {
          const payload = JSON.parse(ev.data);
          if (payload && payload.data && typeof payload.data === 'object') {
            const cleanRemote = normalizeState(payload.data);
            const remoteTime = Number(cleanRemote.updatedAt || 0);
            const localTime = Number(state.updatedAt || 0);
            if (remoteTime >= localTime || !isAdminMode) {
              isApplyingRemoteUpdate = true;
              state = cleanRemote;
              localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
              saveRoomToLocalRegistry(state);
              renderAll();
              isApplyingRemoteUpdate = false;
            }
            updateLiveSyncBadge(`🟢 SALA ${state.roomCode}`, true);
          }
        } catch (e) {
          // Ignorar
        }
      });
      cloudEventSource = sse;
    } catch (e) {
      console.warn('SSE no disponible, usando polling:', e);
    }

    cloudPollTimer = setInterval(pullStateFromCloud, 5000);
  }

  function applyRoleModeUI() {
    document.body.classList.toggle('spectator-mode', !isAdminMode);
    const btn = document.getElementById('btnToggleAdminMode');
    if (btn) {
      const iOwnThisRoom = isRoomOwnedByMe(state.roomCode);
      if (isAdminMode) {
        btn.textContent = '👑 Host del Torneo';
      } else if (iOwnThisRoom) {
        btn.textContent = '👁️ Vista Jugador (Host)';
      } else {
        btn.textContent = '👁️ Vista Jugador';
      }
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
   * Puntos de Escenario por defecto ante abandono/rendición del rival
   */
  function getDefaultScenarioVp() {
    return state.mode === 'individual' ? 6 : 12;
  }

  /**
   * Cálculo de Puntos de Torneo según Resultado (V/E/D), Diferencia de PV y Rendición
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

    // Escala Expandida (5 / 4 / 2 / 1 / 0 / -1)
    if (res === 'V') {
      return absDiff >= 6 ? 5 : 4;
    }
    if (res === 'E') {
      return 2;
    }
    if (res === 'D') {
      if (surrendered) return -1;
      return absDiff < 6 ? 1 : 0;
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
        abandoned: false,
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
          const tp = Number(me.tp || 0);
          const vp = Number(me.vp || 0);
          const diff = vp - Number(opp.vp || 0);

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
      activeList = shuffleArray(getCompetitorEntities());
    } else {
      const prevStandings = calculateStandings(roundNum - 1);
      activeList = prevStandings.filter((s) => !s.abandoned).map((s) => s.name);
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
  }

  function renderSetupView() {
    // Modalidad
    document.querySelectorAll('#modalityGrid .difficulty-card').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.mode === state.mode);
    });

    // Sistema de puntos
    document.querySelectorAll('#scoringSystemGrid .difficulty-card').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.scoring === state.scoringSystem);
    });

    // Inputs numéricos
    document.getElementById('inputTournamentName').value = state.tournamentName;
    document.getElementById('inputTotalRounds').value = state.totalRounds;
    document.getElementById('inputTotalTables').value = state.totalTables;
    document.getElementById('inputTeamCount').value = state.teamCount;
    document.getElementById('inputMembersPerTeam').value = state.membersPerTeam;
    document.getElementById('inputTablesPerTeam').value = state.tablesPerTeam;

    const isTeams = state.mode === 'teams';
    document.querySelectorAll('.team-only-field').forEach((el) => {
      el.classList.toggle('hidden', !isTeams);
    });
    document.getElementById('individualRosterBlock').classList.toggle('hidden', isTeams);
    document.getElementById('teamsRosterBlock').classList.toggle('hidden', !isTeams);

    if (!isTeams) {
      document.getElementById('rosterCountLabel').textContent = String(state.players.length);
      document.getElementById('requiredTablesLabel').textContent = String(
        Math.ceil(state.players.length / 2)
      );

      const listEl = document.getElementById('playersRosterList');
      listEl.innerHTML = '';
      state.players.forEach((pName, idx) => {
        const div = document.createElement('div');
        div.className = 'roster-item';
        div.innerHTML = `
          <span class="roster-num">${idx + 1}</span>
          <input type="text" value="${escapeHtml(pName)}" data-player-idx="${idx}" aria-label="Jugador ${idx + 1}" />
          <button class="roster-remove-btn" data-remove-idx="${idx}" title="Eliminar participante">✕</button>
        `;
        listEl.appendChild(div);
      });

      listEl.querySelectorAll('input[data-player-idx]').forEach((inp) => {
        inp.addEventListener('change', (e) => {
          const idx = Number(e.target.dataset.playerIdx);
          const newVal = e.target.value.trim();
          if (newVal) {
            state.players[idx] = newVal;
            saveState();
            renderSidebarStatus();
          }
        });
      });

      listEl.querySelectorAll('button[data-remove-idx]').forEach((btn) => {
        btn.addEventListener('click', (e) => {
          const idx = Number(e.currentTarget.dataset.removeIdx);
          state.players.splice(idx, 1);
          saveState();
          renderSetupView();
          renderSidebarStatus();
        });
      });
    } else {
      const container = document.getElementById('teamsRosterContainer');
      container.innerHTML = '';
      state.teams.forEach((team, tIdx) => {
        const card = document.createElement('div');
        card.className = 'team-roster-card';
        const membersInputs = team.members
          .map(
            (m, mIdx) => `
            <div class="roster-item">
              <span class="roster-num">${mIdx + 1}</span>
              <input type="text" value="${escapeHtml(m)}" data-team-idx="${tIdx}" data-member-idx="${mIdx}" />
            </div>
          `
          )
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

    // Panel de Equipos
    const teamPanel = document.getElementById('teamRoundPairingPanel');
    teamPanel.classList.toggle('hidden', state.mode !== 'teams');
    if (state.mode === 'teams') {
      renderTeamClashesPanel(currentRoundObj);
    }

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

    currentRoundObj.matches.forEach((match, mIdx) => {
      if (cleanFilter) {
        const hay = `${match.table} ${match.p1.name} ${match.p2.name} ${match.team1 || ''} ${
          match.team2 || ''
        }`.toLowerCase();
        if (!hay.includes(cleanFilter)) return;
      }

      const card = document.createElement('div');
      card.className = 'match-card';

      const diff1 = Number(match.p1.vp || 0) - Number(match.p2.vp || 0);
      const diff2 = Number(match.p2.vp || 0) - Number(match.p1.vp || 0);
      const p1Pen = calcPaintPenalty(match.p1.paint) + calcDelayPenalty(match.p1.delay);
      const p2Pen = calcPaintPenalty(match.p2.paint) + calcDelayPenalty(match.p2.delay);

      const err1 = hasDelayError(match.p1);
      const err2 = hasDelayError(match.p2);

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
          </div>
          <button class="roster-remove-btn" data-delete-match="${mIdx}" title="Eliminar mesa">✕</button>
        </div>

        <div class="table-responsive">
          <table class="match-table-grid">
            <thead>
              <tr>
                <th class="text-left">OPONENTES</th>
                <th>PINTURA S/N</th>
                <th>ATRASO</th>
                <th>PENALIZ.</th>
                <th>RENDICIÓN</th>
                <th>AB. PARTIDA</th>
                <th>AB. TORNEO</th>
                <th>RESULTADO</th>
                <th>PT TORNEO</th>
                <th>PV ESCENARIO</th>
                <th>DIF. PV</th>
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
  }

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

    return `
      <tr>
        <td class="text-left">
          ${teamName ? `<span class="team-tag-small">${escapeHtml(teamName)}</span><br/>` : ''}
          <select class="player-select" data-m-idx="${mIdx}" data-side="${side}" data-field="name">
            ${extraOption}
            ${optionsHtml}
          </select>
        </td>
        <td>
          <select class="mini-select" data-m-idx="${mIdx}" data-side="${side}" data-field="paint">
            <option value="" ${pObj.paint === '' ? 'selected' : ''}>-</option>
            <option value="s" ${pObj.paint === 's' ? 'selected' : ''}>Sí (0)</option>
            <option value="n" ${pObj.paint === 'n' ? 'selected' : ''}>No (${state.mode === 'teams' ? '-2' : '-1'})</option>
          </select>
        </td>
        <td>
          <select class="mini-select" data-m-idx="${mIdx}" data-side="${side}" data-field="delay">
            <option value="N/A" ${pObj.delay === 'N/A' ? 'selected' : ''}>N/A</option>
            <option value="< 10 min" ${pObj.delay === '< 10 min' ? 'selected' : ''}>&lt; 10 min</option>
            <option value="10 - 20 min" ${pObj.delay === '10 - 20 min' ? 'selected' : ''}>10 - 20 min (-1)</option>
            <option value="> 20 min" ${pObj.delay === '> 20 min' ? 'selected' : ''}>&gt; 20 min (-1)</option>
          </select>
        </td>
        <td>
          <span class="penalty-badge ${totalPen < 0 ? 'negative' : ''}">${totalPen}</span>
        </td>
        <td>
          <input type="checkbox" ${pObj.surrender ? 'checked' : ''} data-m-idx="${mIdx}" data-side="${side}" data-field="surrender" title="Rendición S/N" />
        </td>
        <td>
          <input type="checkbox" ${pObj.abandonMatch ? 'checked' : ''} data-m-idx="${mIdx}" data-side="${side}" data-field="abandonMatch" title="Abandono de Partida S/N" />
        </td>
        <td>
          <input type="checkbox" ${pObj.abandonTournament ? 'checked' : ''} data-m-idx="${mIdx}" data-side="${side}" data-field="abandonTournament" title="Abandono del Torneo S/N" />
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
        <td>
          <span class="diff-badge ${diffClass}">${diffStr}</span>
        </td>
      </tr>
    `;
  }

  function bindMatchCardEvents(container, currentRoundObj) {
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
  // 5. RENDERIZADO DEL PODIO Y RESUMEN
  // =========================================================================

  function renderPodiumView() {
    const standings = calculateStandings();
    document.getElementById('thPlayerOrTeam').textContent =
      state.mode === 'teams' ? 'EQUIPO' : 'JUGADOR';

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

      const tr = document.createElement('tr');
      tr.className = rowClass;
      tr.innerHTML = `
        <td><strong>#${pos}</strong></td>
        <td><strong>${escapeHtml(row.name)}</strong></td>
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
      .replace(/"/g, '&quot;');
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

    // Agregar jugador individual
    const addPlayerAction = () => {
      const inp = document.getElementById('inputNewPlayerName');
      const name = inp.value.trim();
      if (!name) return;
      if (state.players.includes(name)) {
        showToast('⚠️ Ya existe un jugador con ese nombre en la lista.');
        return;
      }
      state.players.push(name);
      inp.value = '';
      state.totalTables = Math.max(state.totalTables, Math.ceil(state.players.length / 2));
      saveState();
      renderSetupView();
      renderSidebarStatus();
      showToast(`Jugador "${name}" inscrito.`);
    };

    document.getElementById('btnAddPlayer').addEventListener('click', addPlayerAction);
    document.getElementById('inputNewPlayerName').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') addPlayerAction();
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
            matches: []
          });
        }
        state.activeRound = 1;
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
          state.rounds = [];
          for (let r = 1; r <= state.totalRounds; r++) {
            state.rounds.push({
              round: r,
              paired: false,
              finished: false,
              podiumUpdated: false,
              teamClashes: [],
              matches: []
            });
          }
          state.activeRound = 1;
          saveState();
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
          <h4>1. Puntos de Torneo</h4>
          <ul>
            <li><strong>Escala Expandida (5 / 4 / 2 / 1 / 0 / -1):</strong> Victoria por Masacre (Dif. PV ≥ 6) = <strong>5 pts</strong>; Victoria Marginal (Dif. PV &lt; 6) = <strong>4 pts</strong>; Empate = <strong>2 pts</strong>; Derrota Marginal (Dif. PV &lt; 6) = <strong>1 pt</strong>; Derrota por Masacre (Dif. PV ≥ 6) = <strong>0 pts</strong>; Derrota por Rendición = <strong>-1 pt</strong>.</li>
            <li><strong>Escala Clásica (3 / 1 / 0):</strong> Victoria = <strong>3 pts</strong>; Empate = <strong>1 pt</strong>; Derrota = <strong>0 pts</strong>.</li>
          </ul>
          <h4>2. Penalizaciones y Rendición / Abandono</h4>
          <ul>
            <li><strong>Pintura:</strong> Si no cumple criterio (<code>No</code>), resta <strong>-1 pt</strong> en torneo individual/parejas o <strong>-2 pts</strong> en torneo por equipos (4vs4).</li>
            <li><strong>Atraso:</strong> Entre <code>10 - 20 min</code> o <code>&gt; 20 min</code> penaliza con <strong>-1 pt</strong>. Si supera los 20 minutos, exige marcar <em>Abandono de Partida</em>.</li>
            <li><strong>Abandono o Rendición:</strong> Otorga Victoria automática al oponente con <strong>6 PV</strong> (individual) o <strong>12 PV</strong> (parejas/equipos) y 0 PV al infractor.</li>
          </ul>
          <h4>3. Ordenamiento del Podio y Emparejamiento Suizo</h4>
          <ul>
            <li><strong>Criterios de Desempate:</strong> 1° No haber abandonado el torneo • 2° Puntos de Torneo Final • 3° Diferencia de PV • 4° PV a Favor.</li>
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

    // Sincronización instantánea entre pestañas del mismo navegador
    window.addEventListener('storage', (e) => {
      if (e.key === ROOMS_REGISTRY_KEY && state && state.roomCode) {
        const updatedRoom = getRoomFromLocalRegistry(state.roomCode);
        if (updatedRoom && updatedRoom.updatedAt > (state.updatedAt || 0)) {
          state = updatedRoom;
          ensureConsistency();
          renderAll();
        }
      }
    });
  }

  function promptCreateNewRoom() {
    openConfirmModal(
      'Crear Nuevo Torneo (Nuevo ID)',
      '¿Deseas levantar un nuevo torneo con un código ID nuevo? Quedarás automáticamente como Host (Organizador) de la nueva sala y el torneo anterior seguirá guardado bajo su propio código.',
      '➕ Crear Nuevo Torneo',
      () => {
        const newCode = generateRoomCode();
        state = buildCleanInitialState(newCode);
        ensureConsistency();
        markRoomAsOwned(newCode);
        isAdminMode = true;
        try {
          window.history.replaceState({}, '', window.location.pathname);
        } catch (e) {
          // Ignorar
        }
        saveState();
        startCloudRealtimeSync();
        applyRoleModeUI();
        switchTab('setup');
        renderAll();
        showToast(`👑 Nueva sala creada con el código ${newCode}. ¡Eres el Host!`);
      }
    );
  }

  function openAdminAndCloudModal() {
    const shareUrl = `${window.location.origin}${window.location.pathname}?code=${state.roomCode}`;
    const iOwnThisRoom = isRoomOwnedByMe(state.roomCode);

    openModal(
      'Sala de Torneo (Estilo Companion)',
      `
        <h4>Código de Sala Activo: <span style="color:var(--gold-bright); letter-spacing:0.12em;">${escapeHtml(state.roomCode || '------')}</span></h4>
        <p style="margin-bottom:14px;">
          Tu rol en este torneo: <strong style="color:var(--gold-bright);">${
            isAdminMode
              ? '👑 Host del Torneo (Puedes configurar, emparejar y editar resultados)'
              : iOwnThisRoom
              ? '👁️ Vista Jugador (Previsualizando tu propio torneo)'
              : '👁️ Vista Jugador (Siguiendo en vivo Rondas, Mesas y Podio)'
          }</strong>
        </p>

        <div style="display:flex; gap:10px; align-items:center; flex-wrap:wrap; margin-bottom:18px;">
          ${
            iOwnThisRoom && isAdminMode
              ? `<button type="button" class="btn-elven-outline btn-sm" id="btnLockToSpectator">👁️ Previsualizar como Jugador</button>`
              : ''
          }
          ${
            iOwnThisRoom && !isAdminMode
              ? `<button type="button" class="btn-gold-cta btn-sm" id="btnReturnToHost">👑 Volver a Modo Host</button>`
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
        showToast('👑 Modo Host restaurado.');
      });
    }

    const btnLock = document.getElementById('btnLockToSpectator');
    if (btnLock) {
      btnLock.addEventListener('click', () => {
        isAdminMode = false;
        applyRoleModeUI();
        closeModal();
        showToast('👁️ Previsualizando como Jugador (solo lectura).');
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
    document.getElementById('elvenModal').classList.remove('hidden');
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
    document.getElementById('elvenModal').classList.remove('hidden');

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
  });
})();
