// ===================== CAPA DE DATOS: GOOGLE SHEETS =====================
// Reemplaza a PostgreSQL. Usa una cuenta de servicio de Google para leer/escribir
// un Spreadsheet con 3 pestañas: turnos, garita_usuarios, interna_usuarios.
//
// Variables de entorno requeridas:
//   SHEET_ID                       -> ID del spreadsheet (parte de la URL)
//   GOOGLE_SERVICE_ACCOUNT_JSON    -> JSON completo de la cuenta de servicio (stringify)
// (alternativa: GOOGLE_SA_EMAIL + GOOGLE_SA_PRIVATE_KEY)
//
// NOTA: Google Sheets no tiene transacciones ni bloqueo de filas. Las operaciones
// son lectura-modificación-escritura "best effort". Para una planta chica es suficiente.

const { google } = require('googleapis');

const SHEET_ID = process.env.SHEET_ID;

// Columnas de la pestaña "turnos" (el orden define las columnas A..AA)
const TURNO_COLS = [
  'turno_id', 'truck', 'carrier', 'type', 'warehouse', 'dock', 'status',
  'operation', 'carga_estado', 'chofer', 'dni_chofer', 'celular_chofer',
  'patente_semi', 'contenedor', 'precinto', 'obs_ingreso', 'obs_egreso',
  'registrado_por', 'llaves_recibidas', 'llaves_devueltas',
  'ts_entrada', 'ts_llaves_entrega', 'ts_asignacion', 'ts_atracado',
  'ts_desatracado', 'ts_llaves_retiro', 'ts_egreso'
];
const BOOL_COLS = new Set(['llaves_recibidas', 'llaves_devueltas']);
const TURNO_TAB = 'turnos';
const USER_TABS = { garita: 'garita_usuarios', interna: 'interna_usuarios' };
const PUSH_TAB = 'push_subs'; // suscripciones a notificaciones push del operador

// Legajo de chofer (ART + seguro de vehículo), asociado por DNI. Persiste entre visitas.
const CHOFER_TAB = 'choferes';
const CHOFER_COLS = [
  'dni', 'nombre',
  'art_empresa', 'art_poliza', 'art_vigencia',
  'seguro_empresa', 'seguro_poliza', 'seguro_vigencia',
  'updated_at'
];

const SEED_USERS = {
  garita: { email: 'guardia@ocasa.com', password: 'garita2026', nombre: 'Guardia Tortuguitas' },
  interna: { email: 'interna@ocasa.com', password: 'llaves2026', nombre: 'Seguridad Interna' }
};

// ---------- Autenticación ----------
function getCredentials() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (raw) {
    const json = JSON.parse(raw);
    if (json.private_key) json.private_key = json.private_key.replace(/\\n/g, '\n');
    return { email: json.client_email, key: json.private_key };
  }
  if (process.env.GOOGLE_SA_EMAIL && process.env.GOOGLE_SA_PRIVATE_KEY) {
    return {
      email: process.env.GOOGLE_SA_EMAIL,
      key: process.env.GOOGLE_SA_PRIVATE_KEY.replace(/\\n/g, '\n')
    };
  }
  throw new Error('Faltan credenciales: definí GOOGLE_SERVICE_ACCOUNT_JSON (o GOOGLE_SA_EMAIL + GOOGLE_SA_PRIVATE_KEY)');
}

let _sheets = null;
async function sheets() {
  if (_sheets) return _sheets;
  if (!SHEET_ID) throw new Error('Falta la variable de entorno SHEET_ID');
  const { email, key } = getCredentials();
  const auth = new google.auth.JWT({
    email,
    key,
    scopes: ['https://www.googleapis.com/auth/spreadsheets']
  });
  await auth.authorize();
  _sheets = google.sheets({ version: 'v4', auth });
  return _sheets;
}

// ---------- Helpers de columnas ----------
function colLetter(n) {
  // 1 -> A, 27 -> AA
  let s = '';
  while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
  return s;
}
const LAST_COL = colLetter(TURNO_COLS.length); // 'AA'
const CHOFER_LAST_COL = colLetter(CHOFER_COLS.length);

function rowToTurno(row, rowNumber) {
  const t = { _row: rowNumber };
  TURNO_COLS.forEach((col, i) => {
    let v = row[i] !== undefined ? row[i] : '';
    if (BOOL_COLS.has(col)) {
      v = (v === true || v === 'TRUE' || v === 'true' || v === '1');
    } else if (v === '') {
      v = null;
    }
    t[col] = v;
  });
  return t;
}
function turnoToRow(obj) {
  return TURNO_COLS.map(col => {
    let v = obj[col];
    if (BOOL_COLS.has(col)) return v ? 'TRUE' : 'FALSE';
    if (v === null || v === undefined) return '';
    return String(v);
  });
}

// ---------- Inicialización (idempotente, una vez por proceso) ----------
let _readyPromise = null;
function ensureReady() {
  if (!_readyPromise) _readyPromise = init();
  return _readyPromise;
}

async function init() {
  const api = await sheets();
  const meta = await api.spreadsheets.get({ spreadsheetId: SHEET_ID });
  const existing = new Set((meta.data.sheets || []).map(s => s.properties.title));

  const needed = [TURNO_TAB, USER_TABS.garita, USER_TABS.interna, PUSH_TAB, CHOFER_TAB];
  const addRequests = needed.filter(t => !existing.has(t)).map(title => ({ addSheet: { properties: { title } } }));
  if (addRequests.length) {
    await api.spreadsheets.batchUpdate({ spreadsheetId: SHEET_ID, requestBody: { requests: addRequests } });
  }

  // Header de turnos
  const turnoHeader = await api.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `${TURNO_TAB}!A1:${LAST_COL}1` });
  if (!turnoHeader.data.values || !turnoHeader.data.values[0] || turnoHeader.data.values[0].length === 0) {
    await api.spreadsheets.values.update({
      spreadsheetId: SHEET_ID, range: `${TURNO_TAB}!A1`, valueInputOption: 'RAW',
      requestBody: { values: [TURNO_COLS] }
    });
  }

  // Tablas de usuarios + seeds
  for (const role of ['garita', 'interna']) {
    const tab = USER_TABS[role];
    const got = await api.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `${tab}!A1:D` });
    const rows = got.data.values || [];
    if (rows.length === 0) {
      const u = SEED_USERS[role];
      await api.spreadsheets.values.update({
        spreadsheetId: SHEET_ID, range: `${tab}!A1`, valueInputOption: 'RAW',
        requestBody: { values: [['email', 'password', 'nombre', 'activo'], [u.email, u.password, u.nombre, 'TRUE']] }
      });
    }
  }
  // Header de suscripciones push
  const pushHeader = await api.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `${PUSH_TAB}!A1:D1` });
  if (!pushHeader.data.values || !pushHeader.data.values[0] || pushHeader.data.values[0].length === 0) {
    await api.spreadsheets.values.update({
      spreadsheetId: SHEET_ID, range: `${PUSH_TAB}!A1`, valueInputOption: 'RAW',
      requestBody: { values: [['endpoint', 'p256dh', 'auth', 'created']] }
    });
  }

  // Header de legajo de choferes (ART + seguro de vehículo)
  const choferHeader = await api.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `${CHOFER_TAB}!A1:${CHOFER_LAST_COL}1` });
  if (!choferHeader.data.values || !choferHeader.data.values[0] || choferHeader.data.values[0].length === 0) {
    await api.spreadsheets.values.update({
      spreadsheetId: SHEET_ID, range: `${CHOFER_TAB}!A1`, valueInputOption: 'RAW',
      requestBody: { values: [CHOFER_COLS] }
    });
  }

  console.log('✅ Google Sheets inicializado (Tortuguitas)');
}

// ---------- Suscripciones push (notificaciones del operador) ----------
async function listPushSubs() {
  await ensureReady();
  const api = await sheets();
  const got = await api.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `${PUSH_TAB}!A2:D` });
  return (got.data.values || [])
    .map((r, i) => ({ _row: i + 2, endpoint: r[0], keys: { p256dh: r[1], auth: r[2] }, created: r[3] }))
    .filter(s => s.endpoint);
}

async function addPushSub(sub) {
  await ensureReady();
  const api = await sheets();
  const existing = await listPushSubs();
  if (existing.some(s => s.endpoint === sub.endpoint)) return { already: true };
  await api.spreadsheets.values.append({
    spreadsheetId: SHEET_ID, range: `${PUSH_TAB}!A1`,
    valueInputOption: 'RAW', insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [[sub.endpoint, sub.keys && sub.keys.p256dh || '', sub.keys && sub.keys.auth || '', new Date().toISOString()]] }
  });
  return { added: true };
}

async function removePushSub(endpoint) {
  await ensureReady();
  const api = await sheets();
  const subs = await listPushSubs();
  const target = subs.filter(s => s.endpoint === endpoint).sort((a, b) => b._row - a._row);
  if (!target.length) return 0;
  const meta = await api.spreadsheets.get({ spreadsheetId: SHEET_ID });
  const sh = (meta.data.sheets || []).find(s => s.properties.title === PUSH_TAB);
  const requests = target.map(t => ({
    deleteDimension: { range: { sheetId: sh.properties.sheetId, dimension: 'ROWS', startIndex: t._row - 1, endIndex: t._row } }
  }));
  await api.spreadsheets.batchUpdate({ spreadsheetId: SHEET_ID, requestBody: { requests } });
  return target.length;
}

// ---------- Cache corto de turnos (reduce cuota en el polling) ----------
let _cache = { data: null, ts: 0 };
const CACHE_MS = 1500;

async function listTurnos({ fresh = false } = {}) {
  await ensureReady();
  if (!fresh && _cache.data && (Date.now() - _cache.ts) < CACHE_MS) return _cache.data;
  const api = await sheets();
  const got = await api.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `${TURNO_TAB}!A2:${LAST_COL}` });
  const rows = got.data.values || [];
  const turnos = rows.map((r, i) => rowToTurno(r, i + 2)).filter(t => t.turno_id);
  _cache = { data: turnos, ts: Date.now() };
  return turnos;
}
function invalidateCache() { _cache = { data: null, ts: 0 }; }

async function getTurno(turnoId) {
  const all = await listTurnos({ fresh: true });
  return all.find(t => t.turno_id === turnoId) || null;
}

async function nextTurnoId() {
  const all = await listTurnos({ fresh: true });
  let max = 0;
  all.forEach(t => {
    const m = /TRN-(\d+)/.exec(t.turno_id || '');
    if (m) max = Math.max(max, parseInt(m[1], 10));
  });
  return 'TRN-' + String(max + 1).padStart(4, '0');
}

async function insertTurno(obj) {
  await ensureReady();
  const api = await sheets();
  await api.spreadsheets.values.append({
    spreadsheetId: SHEET_ID, range: `${TURNO_TAB}!A1`,
    valueInputOption: 'RAW', insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [turnoToRow(obj)] }
  });
  invalidateCache();
  return obj;
}

// Actualiza un turno por turno_id aplicando un patch (read-modify-write de la fila completa)
async function updateTurno(turnoId, patch) {
  await ensureReady();
  const api = await sheets();
  const all = await listTurnos({ fresh: true });
  const current = all.find(t => t.turno_id === turnoId);
  if (!current) return null;
  const merged = { ...current, ...patch };
  await api.spreadsheets.values.update({
    spreadsheetId: SHEET_ID, range: `${TURNO_TAB}!A${current._row}:${LAST_COL}${current._row}`,
    valueInputOption: 'RAW', requestBody: { values: [turnoToRow(merged)] }
  });
  invalidateCache();
  return merged;
}

// Devuelve el sheetId numérico de la pestaña turnos (necesario para deleteDimension)
let _turnoSheetId = null;
async function turnoSheetId() {
  if (_turnoSheetId != null) return _turnoSheetId;
  const api = await sheets();
  const meta = await api.spreadsheets.get({ spreadsheetId: SHEET_ID });
  const sh = (meta.data.sheets || []).find(s => s.properties.title === TURNO_TAB);
  if (!sh) throw new Error('No existe la pestaña ' + TURNO_TAB);
  _turnoSheetId = sh.properties.sheetId;
  return _turnoSheetId;
}

// Elimina turnos que cumplan el predicate. Borra de abajo hacia arriba para no
// invalidar índices. Devuelve la cantidad eliminada.
async function deleteWhere(predicate) {
  await ensureReady();
  const api = await sheets();
  const all = await listTurnos({ fresh: true });
  const target = all.filter(predicate).sort((a, b) => b._row - a._row); // mayor fila primero
  if (target.length === 0) { invalidateCache(); return 0; }
  const sheetId = await turnoSheetId();
  const requests = target.map(t => ({
    deleteDimension: {
      range: { sheetId, dimension: 'ROWS', startIndex: t._row - 1, endIndex: t._row }
    }
  }));
  await api.spreadsheets.batchUpdate({ spreadsheetId: SHEET_ID, requestBody: { requests } });
  invalidateCache();
  return target.length;
}

async function deleteTurno(turnoId) {
  return deleteWhere(t => t.turno_id === turnoId);
}

async function authUser(role, email, password) {
  await ensureReady();
  const api = await sheets();
  const tab = USER_TABS[role];
  const got = await api.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `${tab}!A2:D` });
  const rows = got.data.values || [];
  const e = (email || '').trim().toLowerCase();
  for (const r of rows) {
    const [uemail, upass, unombre, activo] = r;
    if ((uemail || '').trim().toLowerCase() === e && (upass || '') === password &&
        (activo === undefined || activo === '' || activo === 'TRUE' || activo === 'true' || activo === true)) {
      return { email: uemail, nombre: unombre || uemail };
    }
  }
  return null;
}

// ---------- Legajo de chofer (ART + seguro de vehículo), asociado por DNI ----------
function rowToChofer(row, rowNumber) {
  const c = { _row: rowNumber };
  CHOFER_COLS.forEach((col, i) => { c[col] = row[i] || null; });
  return c;
}
function choferToRow(obj) {
  return CHOFER_COLS.map(col => (obj[col] === null || obj[col] === undefined) ? '' : String(obj[col]));
}

async function listChoferes() {
  await ensureReady();
  const api = await sheets();
  const got = await api.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `${CHOFER_TAB}!A2:${CHOFER_LAST_COL}` });
  const rows = got.data.values || [];
  return rows.map((r, i) => rowToChofer(r, i + 2)).filter(c => c.dni);
}

async function getChoferByDni(dni) {
  if (!dni) return null;
  const clean = String(dni).trim();
  if (!clean) return null;
  const all = await listChoferes();
  return all.find(c => c.dni === clean) || null;
}

// Crea o actualiza el legajo del chofer (merge de campos no vacíos sobre lo existente).
async function upsertChofer(dni, patch) {
  const clean = String(dni || '').trim();
  if (!clean) return null;
  await ensureReady();
  const api = await sheets();
  const existing = await getChoferByDni(clean);
  const merged = { ...(existing || { dni: clean }), ...patch, dni: clean, updated_at: now() };

  if (existing) {
    await api.spreadsheets.values.update({
      spreadsheetId: SHEET_ID, range: `${CHOFER_TAB}!A${existing._row}:${CHOFER_LAST_COL}${existing._row}`,
      valueInputOption: 'RAW', requestBody: { values: [choferToRow(merged)] }
    });
  } else {
    await api.spreadsheets.values.append({
      spreadsheetId: SHEET_ID, range: `${CHOFER_TAB}!A1`,
      valueInputOption: 'RAW', insertDataOption: 'INSERT_ROWS',
      requestBody: { values: [choferToRow(merged)] }
    });
  }
  return merged;
}

// Marca de tiempo actual en ISO (reemplaza CURRENT_TIMESTAMP)
function now() { return new Date().toISOString(); }

module.exports = {
  ensureReady, init, listTurnos, getTurno, nextTurnoId,
  insertTurno, updateTurno, deleteTurno, deleteWhere, authUser,
  listPushSubs, addPushSub, removePushSub,
  getChoferByDni, upsertChofer,
  invalidateCache, now, TURNO_COLS
};
