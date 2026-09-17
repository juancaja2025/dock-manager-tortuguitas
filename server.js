const express = require('express');
const db = require('./lib/sheetsDb');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_PASS = process.env.ADMIN_PASS || 'Tortuguitas2026';

// ===================== NOTIFICACIONES PUSH (solo proceso operador) =====================
// El panel /operador es instalable como PWA y recibe push cuando garita registra
// un ingreso (camión esperando dársena). Suscripciones en la pestaña push_subs del Sheet.
const webpush = require('web-push');
const PUSH_ENABLED = !!(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY);
if (PUSH_ENABLED) {
  webpush.setVapidDetails(
    process.env.VAPID_SUBJECT || 'mailto:juan.cajaravilla@ocasa.com',
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  );
} else {
  console.log('⚠️ Push deshabilitado: faltan VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY');
}

// Envía una notificación a todos los operadores suscriptos; limpia suscripciones muertas.
async function notifyOperators(payload) {
  if (!PUSH_ENABLED) return;
  try {
    const subs = await db.listPushSubs();
    if (!subs.length) return;
    const body = JSON.stringify(payload);
    await Promise.allSettled(subs.map(async (s) => {
      try {
        await webpush.sendNotification({ endpoint: s.endpoint, keys: s.keys }, body, { TTL: 3600 });
      } catch (err) {
        if (err.statusCode === 404 || err.statusCode === 410) {
          await db.removePushSub(s.endpoint).catch(() => {});
        }
      }
    }));
  } catch (err) {
    console.error('Error enviando push:', err.message);
  }
}

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use('/public', express.static(path.join(__dirname, 'public')));

// ===================== BASE DE DATOS: GOOGLE SHEETS =====================
// Circuito: ESPERANDO_ASIGNACION (garita registra ingreso al predio + QR)
//   -> DARSENA_ASIGNADA (operador asigna dársena) -> [seguridad interna recibe llaves: llaves_recibidas]
//   -> ATRACADO -> DESATRACADO (muelle) -> [seguridad interna devuelve llaves] -> EGRESADO (garita)
// Naves: 'Nave 1', 'Nave 2', 'Nave 3'. Sin tacos de goma, sin número de viaje.
// La persistencia vive en un Spreadsheet de Google (ver lib/sheetsDb.js).
db.ensureReady().catch(err => console.error('❌ Error inicializando Google Sheets:', err.message));

// ===================== PWA (manifest + service worker) =====================
app.get('/manifest.webmanifest', (req, res) => {
  res.set('Content-Type', 'application/manifest+json');
  res.json({
    name: 'OCASA Dock — Operador',
    short_name: 'Dock Operador',
    description: 'Asignación de dársenas — Planta Tortuguitas',
    start_url: '/operador',
    scope: '/',
    display: 'standalone',
    background_color: '#f5f7fa',
    theme_color: '#0099A8',
    icons: [
      { src: '/public/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/public/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' }
    ]
  });
});

app.get('/sw.js', (req, res) => {
  res.set('Content-Type', 'application/javascript');
  res.send(`
self.addEventListener('install', (e) => { self.skipWaiting(); });
self.addEventListener('activate', (e) => { e.waitUntil(self.clients.claim()); });

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch(e) {}
  event.waitUntil(self.registration.showNotification(data.title || 'OCASA Dock', {
    body: data.body || '',
    icon: '/public/icon-192.png',
    badge: '/public/icon-192.png',
    vibrate: [300, 120, 300],
    tag: data.tag || 'dock-operador',
    renotify: true,
    data: { url: data.url || '/operador' }
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/operador';
  event.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true }).then((wins) => {
    for (const w of wins) { if (w.url.includes('/operador') && 'focus' in w) return w.focus(); }
    return clients.openWindow(url);
  }));
});
`);
});

// ===================== API PUSH (suscripciones del operador) =====================
app.post('/api/push/subscribe', async (req, res) => {
  try {
    const sub = req.body;
    if (!sub || !sub.endpoint) return res.json({ success: false, error: 'Suscripción inválida' });
    await db.addPushSub(sub);
    res.json({ success: true });
  } catch (err) {
    console.error('Error en /api/push/subscribe:', err);
    res.json({ success: false, error: 'Error guardando la suscripción' });
  }
});

app.post('/api/push/unsubscribe', async (req, res) => {
  try {
    const { endpoint } = req.body || {};
    if (endpoint) await db.removePushSub(endpoint);
    res.json({ success: true });
  } catch (err) {
    res.json({ success: false });
  }
});

// Prueba manual: envía una notificación de test a todos los suscriptos
app.post('/api/push/test', async (req, res) => {
  await notifyOperators({ title: '🔔 Prueba OCASA Dock', body: 'Las notificaciones funcionan correctamente.', url: '/operador', tag: 'test' });
  res.json({ success: true });
});

// ===================== COLORES OCASA (Manual de marca) =====================
const colors = {
  primary: '#0099A8',      // CALYPSO - color central
  primaryDark: '#056572',  // Teal oscuro - secundario (max 5%)
  primaryLight: 'rgba(0,153,168,0.08)',
  primaryMedium: 'rgba(0,153,168,0.15)',
  green: '#8fbf4c',        // Verde - secundario (max 5%)
  orange: '#ffab40',       // Naranja - secundario (max 5%)
  light: '#efefef',        // Gris claro
  dark: '#1a1a2e',
  darkBlue: '#16213e',
  white: '#ffffff',
  black: '#000000',
  // Tema claro (alineado a manual: CALYPSO + blanco + negro)
  bg: '#f5f7fa',
  bgCard: '#ffffff',
  bgCardHover: '#f0f9fa',
  textPrimary: '#1a1a2e',
  textSecondary: '#5a6478',
  textMuted: '#8c95a6',
  border: '#e2e8f0',
  borderLight: '#f0f0f0',
  shadow: 'rgba(0,0,0,0.06)',
  shadowHover: 'rgba(0,153,168,0.12)',
};

// ===================== LOGO BASE64 =====================
const fs = require('fs');
let logoSrc = '';
try {
  const logoPath = path.join(__dirname, 'public', 'logo.png');
  const logoBuffer = fs.readFileSync(logoPath);
  logoSrc = 'data:image/png;base64,' + logoBuffer.toString('base64');
} catch(e) {
  console.log('Logo no encontrado, usando texto');
  logoSrc = '';
}

// ===================== ESTILOS CSS COMPARTIDOS =====================
// Google Fonts link para incluir en cada página
const fontLink = '<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?family=Montserrat:wght@400;500;600;700&display=swap" rel="stylesheet">';

const styles = `
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: 'Montserrat', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    background: ${colors.bg};
    min-height: 100vh;
    color: ${colors.textPrimary};
  }
  .container { max-width: 500px; margin: 0 auto; padding: 20px; }
  .container-wide { max-width: 960px; margin: 0 auto; padding: 20px; }
  /* El logo OCASA es blanco: lo mostramos sobre un chip Calypso para que se vea en cualquier fondo */
  .logo { height: 56px; margin-bottom: 16px; background: ${colors.primary}; padding: 10px 18px; border-radius: 12px; display: inline-block; vertical-align: middle; }
  .logo-large { height: 84px; margin-bottom: 24px; background: ${colors.primary}; padding: 14px 26px; border-radius: 16px; display: inline-block; }
  h1 { font-size: 24px; margin-bottom: 8px; color: ${colors.textPrimary}; font-weight: 700; }
  h2 { font-size: 20px; margin-bottom: 12px; color: ${colors.textPrimary}; font-weight: 600; }
  .subtitle { color: ${colors.textSecondary}; margin-bottom: 24px; }
  .card {
    background: ${colors.bgCard};
    border-radius: 16px;
    padding: 20px;
    margin-bottom: 16px;
    border: 1px solid ${colors.border};
    box-shadow: 0 1px 3px ${colors.shadow};
  }
  .btn {
    display: block; width: 100%; padding: 16px; border: none; border-radius: 12px;
    font-family: 'Montserrat', sans-serif;
    font-size: 16px; font-weight: 600; cursor: pointer; margin-top: 12px;
    transition: transform 0.2s, box-shadow 0.2s;
    text-decoration: none; text-align: center;
  }
  .btn:hover { transform: translateY(-1px); box-shadow: 0 4px 12px ${colors.shadowHover}; }
  .btn:active { transform: translateY(0); }
  .btn:disabled { opacity: 0.5; cursor: not-allowed; transform: none; box-shadow: none; }
  .btn-primary { background: ${colors.primary}; color: white; }
  .btn-primary:hover { background: ${colors.primaryDark}; }
  .btn-green { background: ${colors.green}; color: white; }
  .btn-orange { background: ${colors.orange}; color: ${colors.textPrimary}; }
  input, select {
    width: 100%; padding: 16px; border: 2px solid ${colors.border};
    border-radius: 12px; font-size: 16px; font-family: 'Montserrat', sans-serif;
    background: ${colors.bgCard};
    color: ${colors.textPrimary}; margin-bottom: 8px; min-height: 52px;
    transition: border-color 0.2s, box-shadow 0.2s;
  }
  input::placeholder { color: ${colors.textMuted}; }
  input:focus, select:focus { outline: none; border-color: ${colors.primary}; box-shadow: 0 0 0 3px rgba(0,153,168,0.12); }
  select option { background: ${colors.bgCard}; color: ${colors.textPrimary}; padding: 12px; font-size: 16px; }
  select option:disabled { color: ${colors.textMuted}; }
  .error { background: #fef2f2; color: #dc2626; padding: 12px; border-radius: 8px; margin-bottom: 16px; border: 1px solid #fecaca; font-weight: 500; }
  .success { background: #f0fdf4; color: #16a34a; padding: 12px; border-radius: 8px; margin-bottom: 16px; border: 1px solid #bbf7d0; font-weight: 500; }
  .icon-circle {
    width: 80px; height: 80px; border-radius: 50%;
    display: flex; align-items: center; justify-content: center;
    font-size: 40px; margin: 0 auto 16px;
  }
  .icon-primary { background: ${colors.primaryLight}; }
  .icon-green { background: rgba(143,191,76,0.12); }
  .icon-orange { background: rgba(255,171,64,0.12); }
  .badge {
    display: inline-block; padding: 4px 12px; border-radius: 20px;
    font-size: 11px; font-weight: 600; margin-left: 8px; letter-spacing: 0.3px;
  }
  .badge-yellow { background: #fffbeb; color: #d97706; border: 1px solid #fde68a; }
  .badge-primary { background: rgba(0,153,168,0.08); color: ${colors.primary}; border: 1px solid rgba(0,153,168,0.2); }
  .badge-green { background: #f0fdf4; color: #16a34a; border: 1px solid #bbf7d0; }
  .badge-orange { background: #fffbeb; color: #d97706; border: 1px solid #fde68a; }
  .badge-dark { background: ${colors.light}; color: ${colors.textSecondary}; border: 1px solid ${colors.border}; }
  .turno-card {
    background: ${colors.bgCard}; border-radius: 12px;
    padding: 16px; margin-bottom: 12px;
    display: flex; justify-content: space-between; align-items: center;
    cursor: pointer; transition: all 0.2s;
    border: 1px solid ${colors.border};
    box-shadow: 0 1px 2px ${colors.shadow};
  }
  .turno-card:hover { border-color: ${colors.primary}; box-shadow: 0 2px 8px ${colors.shadowHover}; background: ${colors.bgCardHover}; }
  .turno-info h3 { font-size: 16px; margin-bottom: 4px; font-weight: 600; }
  .turno-info p { color: ${colors.textSecondary}; font-size: 13px; }
  .turno-meta { text-align: right; }
  .turno-meta .time { color: ${colors.textMuted}; font-size: 13px; }
  .grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 24px; }
  .grid-3 { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 12px; margin-bottom: 24px; }
  .kpis-row { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-bottom: 24px; }
  .kpi {
    background: ${colors.bgCard}; border-radius: 12px; padding: 20px; text-align: center;
    border: 1px solid ${colors.border}; box-shadow: 0 1px 2px ${colors.shadow};
  }
  .kpi-value { font-size: 36px; font-weight: 700; color: ${colors.primary}; }
  .kpi-label { color: ${colors.textMuted}; font-size: 13px; margin-top: 4px; font-weight: 500; }
  .dock-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(72px, 1fr)); gap: 8px; margin-top: 16px; }
  .dock {
    padding: 12px 8px; border-radius: 8px; text-align: center;
    font-weight: 600; font-size: 14px;
  }
  .dock-free { background: #f0fdf4; color: #16a34a; border: 1px solid #bbf7d0; }
  .dock-occupied { background: #fffbeb; color: #d97706; border: 1px solid #fde68a; }
  .warehouse { margin-bottom: 24px; }
  .warehouse h3 { margin-bottom: 12px; color: ${colors.textSecondary}; font-weight: 600; }
  .tabs { display: flex; gap: 8px; margin-bottom: 20px; }
  .tab {
    flex: 1; padding: 12px; border-radius: 8px; border: 2px solid ${colors.border};
    background: ${colors.bgCard}; color: ${colors.textSecondary}; cursor: pointer;
    font-family: 'Montserrat', sans-serif; font-weight: 600; transition: all 0.2s;
  }
  .tab:hover { border-color: ${colors.primary}; color: ${colors.primary}; }
  .tab.active { background: ${colors.primary}; color: white; border-color: ${colors.primary}; }
  .timeline { margin-top: 20px; }
  .timeline-item {
    display: flex; align-items: center; padding: 16px 0;
    border-left: 2px solid ${colors.border};
    margin-left: 12px; padding-left: 24px; position: relative;
  }
  .timeline-item::before {
    content: ''; position: absolute; left: -7px; width: 12px; height: 12px;
    border-radius: 50%; background: ${colors.border};
  }
  .timeline-item.done::before { background: ${colors.primary}; }
  .timeline-item.current::before { background: ${colors.primary}; box-shadow: 0 0 0 4px rgba(0,153,168,0.2); }
  .timeline-time { color: ${colors.textMuted}; font-size: 13px; width: 100px; font-weight: 500; }
  .timeline-text { flex: 1; font-weight: 500; }
  .modal-overlay {
    display: none; position: fixed; top: 0; left: 0; right: 0; bottom: 0;
    background: rgba(0,0,0,0.5); z-index: 1000; backdrop-filter: blur(4px);
    justify-content: center; align-items: center; padding: 20px;
  }
  .modal-overlay.active { display: flex; }
  .modal {
    background: ${colors.bgCard}; border-radius: 16px; padding: 24px;
    max-width: 500px; width: 100%; max-height: 90vh; overflow-y: auto;
    border: 1px solid ${colors.border}; box-shadow: 0 20px 60px rgba(0,0,0,0.15);
  }
  .modal-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px; }
  .modal-close {
    background: ${colors.light}; border: none; color: ${colors.textSecondary}; font-size: 20px;
    cursor: pointer; padding: 4px 10px; border-radius: 8px; transition: background 0.2s;
  }
  .modal-close:hover { background: ${colors.border}; color: ${colors.textPrimary}; }
  .header {
    display: flex; align-items: center; justify-content: space-between;
    margin-bottom: 24px; padding-bottom: 16px;
    border-bottom: 1px solid ${colors.border};
  }
  .header-left { display: flex; align-items: center; gap: 16px; }
  .assign-row { display: flex; gap: 8px; margin-top: 12px; align-items: stretch; }
  .assign-row select {
    flex: 2; margin: 0; padding: 16px; font-size: 16px; font-weight: 600;
    min-height: 56px; min-width: 0;
  }
  .assign-row button { flex: 1; margin: 0; padding: 16px 12px; min-height: 56px; font-size: 14px; white-space: nowrap; }
  .refresh-notice {
    text-align: center; color: ${colors.textMuted}; font-size: 13px;
    margin-top: 20px;
  }
  .toast { position: fixed; top: 20px; right: 20px; padding: 14px 20px; border-radius: 10px; font-weight: 500; font-size: 14px; z-index: 2000; transform: translateY(-20px); opacity: 0; transition: all 0.3s; pointer-events: none; }
  .toast.show { transform: translateY(0); opacity: 1; }
  .toast-success { background: #f0fdf4; color: #16a34a; border: 1px solid #bbf7d0; box-shadow: 0 4px 12px rgba(0,0,0,0.1); }
  .toast-error { background: #fef2f2; color: #dc2626; border: 1px solid #fecaca; box-shadow: 0 4px 12px rgba(0,0,0,0.1); }
  .time-badge { font-size: 11px; color: ${colors.textMuted}; font-weight: 500; white-space: nowrap; }
  .time-badge.warning { color: #d97706; }
  .time-badge.danger { color: #dc2626; font-weight: 600; }

  /* Dashboard KPIs */
  .nav-tab-dashboard { background: rgba(0,153,168,0.06); border-color: ${colors.primary}; color: ${colors.primary}; }
  .nav-tab-dashboard.active { background: ${colors.primaryDark}; color: white; border-color: ${colors.primaryDark}; }
  .date-range-bar { display: flex; gap: 8px; margin-bottom: 20px; align-items: center; flex-wrap: wrap; }
  .range-btn {
    padding: 8px 16px; border: 1px solid ${colors.border}; border-radius: 8px;
    background: ${colors.bgCard}; color: ${colors.textSecondary}; font-family: 'Montserrat', sans-serif;
    font-size: 13px; font-weight: 600; cursor: pointer; transition: all 0.2s;
  }
  .range-btn:hover { border-color: ${colors.primary}; color: ${colors.primary}; }
  .range-btn.active { background: ${colors.primary}; color: white; border-color: ${colors.primary}; }
  .dash-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-bottom: 16px; }
  .dash-section {
    background: ${colors.bgCard}; border-radius: 12px; padding: 20px;
    border: 1px solid ${colors.border}; box-shadow: 0 1px 2px ${colors.shadow};
  }
  .dash-section h3 { font-size: 14px; color: ${colors.textSecondary}; margin: 0 0 16px 0; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; }
  .dash-full { grid-column: 1 / -1; }
  .bar-row { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; }
  .bar-label { width: 100px; font-size: 12px; color: ${colors.textSecondary}; text-align: right; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .bar-track { flex: 1; height: 24px; background: ${colors.light}; border-radius: 6px; overflow: hidden; }
  .bar-fill { height: 100%; border-radius: 6px; transition: width 0.4s ease; min-width: 2px; }
  .bar-fill-primary { background: ${colors.primary}; }
  .bar-fill-green { background: ${colors.green}; }
  .bar-fill-orange { background: ${colors.orange}; }
  .bar-value { width: 50px; font-size: 12px; font-weight: 600; color: ${colors.textPrimary}; }
  .hour-chart { display: flex; align-items: flex-end; gap: 2px; height: 120px; padding-top: 8px; }
  .hour-bar-wrap { flex: 1; display: flex; flex-direction: column; align-items: center; height: 100%; justify-content: flex-end; }
  .hour-bar { width: 100%; background: ${colors.primary}; border-radius: 3px 3px 0 0; transition: height 0.4s ease; min-width: 6px; cursor: pointer; position: relative; }
  .hour-bar:hover { background: ${colors.primaryDark}; }
  .hour-label { font-size: 9px; text-align: center; color: ${colors.textMuted}; margin-top: 4px; }
  .hour-bar-tooltip { display: none; position: absolute; top: -24px; left: 50%; transform: translateX(-50%); background: ${colors.dark}; color: white; font-size: 11px; padding: 2px 6px; border-radius: 4px; white-space: nowrap; }
  .hour-bar:hover .hour-bar-tooltip { display: block; }
  .trend-chart { display: flex; align-items: flex-end; gap: 3px; height: 120px; padding-top: 8px; }
  .trend-bar-wrap { flex: 1; display: flex; flex-direction: column; align-items: center; height: 100%; justify-content: flex-end; }
  .trend-bar { width: 100%; background: ${colors.primary}; border-radius: 3px 3px 0 0; transition: height 0.4s ease; cursor: pointer; position: relative; }
  .trend-bar:hover { background: ${colors.primaryDark}; }
  .trend-label { font-size: 8px; text-align: center; color: ${colors.textMuted}; margin-top: 4px; }
  .trend-bar-tooltip { display: none; position: absolute; top: -24px; left: 50%; transform: translateX(-50%); background: ${colors.dark}; color: white; font-size: 11px; padding: 2px 6px; border-radius: 4px; white-space: nowrap; }
  .trend-bar:hover .trend-bar-tooltip { display: block; }
  .kpi-subtitle { font-size: 11px; color: ${colors.textMuted}; margin-top: 2px; }
  .dash-empty { text-align: center; padding: 40px 20px; color: ${colors.textMuted}; font-size: 14px; }

  @media (max-width: 600px) {
    .grid-2 { grid-template-columns: 1fr 1fr; gap: 8px; }
    .grid-3 { grid-template-columns: 1fr 1fr 1fr; gap: 8px; }
    .kpis-row { grid-template-columns: 1fr 1fr; gap: 8px; margin-bottom: 16px; }
    .kpi { padding: 14px; }
    .kpi-value { font-size: 28px; }
    .kpi-label { font-size: 11px; }
    .container-wide { padding: 12px; }
    .container { padding: 14px; }
    .dash-grid { grid-template-columns: 1fr; }
    .bar-label { width: 70px; }
    .hour-chart, .trend-chart { height: 80px; }
    h1 { font-size: 20px; }
    .header { flex-wrap: wrap; gap: 10px; }
    .modal { padding: 18px; border-radius: 14px; }
    /* Inputs a 16px para que iOS no haga zoom al enfocar */
    input, select { font-size: 16px; }
  }
`;

// ===================== FUNCIONES HELPER =====================
async function generarId() {
  return db.nextTurnoId();
}

function formatTime(date) {
  if (!date) return '--:--';
  return new Date(date).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' });
}

function formatDateTime(date) {
  if (!date) return '--:--';
  return new Date(date).toLocaleString('es-AR', { 
    day: '2-digit', month: '2-digit', 
    hour: '2-digit', minute: '2-digit' 
  });
}

// ===================== RUTAS API =====================

// Obtener turnos activos por patente
app.get('/api/turnos-by-patente/:patente', async (req, res) => {
  try {
    const patente = (req.params.patente || '').toUpperCase().replace(/[-\s]/g, '');
    const all = await db.listTurnos();
    const turnos = all
      .filter(t => (t.truck || '').toUpperCase().replace(/[-\s]/g, '') === patente && t.status !== 'EGRESADO')
      .sort((a, b) => new Date(b.ts_entrada || 0) - new Date(a.ts_entrada || 0));
    res.json({ success: true, turnos });
  } catch (err) {
    console.error(err);
    res.json({ success: false, error: err.message });
  }
});

// Obtener turno por ID
app.get('/api/turno/:id', async (req, res) => {
  try {
    const turno = await db.getTurno(req.params.id);
    if (!turno) return res.json({ success: false, error: 'Turno no encontrado' });
    res.json({ success: true, turno });
  } catch (err) {
    console.error(err);
    res.json({ success: false, error: 'Error de base de datos' });
  }
});

// Obtener todos los turnos
app.get('/api/turnos', async (req, res) => {
  try {
    const all = await db.listTurnos();
    const turnos = all.slice().sort((a, b) => new Date(b.ts_entrada || 0) - new Date(a.ts_entrada || 0));
    res.json({ success: true, turnos });
  } catch (err) {
    console.error(err);
    res.json({ success: false, error: 'Error de base de datos' });
  }
});

// Asignar dársena
app.post('/api/asignar', async (req, res) => {
  const { turnoId, dock, warehouse } = req.body;

  try {
    const all = await db.listTurnos({ fresh: true });
    const t = all.find(x => x.turno_id === turnoId);
    if (!t) return res.json({ success: false, error: 'Turno no encontrado' });

    // Idempotente: si ya está asignado a la misma dársena, éxito (evita error por doble-click)
    if (t.status === 'DARSENA_ASIGNADA' && t.dock === dock) {
      return res.json({ success: true });
    }
    if (t.status !== 'ESPERANDO_ASIGNACION') {
      return res.json({ success: false, error: 'El turno ya tiene dársena asignada (' + (t.dock || '') + '). Refrescá la pantalla.' });
    }

    // Verificar que el dock no esté ocupado
    const ocupada = all.find(x => x.dock === dock && !['EGRESADO', 'DESATRACADO'].includes(x.status) && x.turno_id !== turnoId);
    if (ocupada) {
      return res.json({ success: false, error: 'Esa dársena ya está ocupada por ' + ocupada.truck });
    }

    await db.updateTurno(turnoId, { dock, warehouse, status: 'DARSENA_ASIGNADA', ts_asignacion: db.now() });
    res.json({ success: true });
  } catch (err) {
    console.error('Error en /api/asignar:', err);
    res.json({ success: false, error: 'Error de base de datos' });
  }
});

// Reasignar dársena (después de desatracar)
app.post('/api/reasignar', async (req, res) => {
  const { turnoId, dock, warehouse } = req.body;
  try {
    const all = await db.listTurnos({ fresh: true });
    const ocupada = all.find(x => x.dock === dock && !['EGRESADO', 'DESATRACADO'].includes(x.status));
    if (ocupada) {
      return res.json({ success: false, error: 'Esa dársena ya está ocupada por ' + ocupada.truck });
    }
    await db.updateTurno(turnoId, {
      dock, warehouse, status: 'DARSENA_ASIGNADA', ts_asignacion: db.now(),
      ts_atracado: null, ts_desatracado: null
    });
    res.json({ success: true });
  } catch(e) {
    console.error('Error en /api/reasignar:', e);
    res.json({ success: false, error: 'Error de base de datos' });
  }
});

// ===================== EDITAR / ELIMINAR TURNO (con PIN de supervisor) =====================
const EDIT_PIN = process.env.EDIT_PIN || '1234';

app.post('/api/turno/editar', async (req, res) => {
  try {
    const { turnoId, pin, truck, carrier, chofer, operation, dock, warehouse } = req.body;
    if (String(pin) !== String(EDIT_PIN)) return res.json({ success: false, error: 'PIN incorrecto' });
    if (!turnoId) return res.json({ success: false, error: 'Turno requerido' });
    if (!truck || !truck.trim()) return res.json({ success: false, error: 'La patente no puede quedar vacía' });

    const all = await db.listTurnos({ fresh: true });
    const t = all.find(x => x.turno_id === turnoId);
    if (!t) return res.json({ success: false, error: 'Turno no encontrado' });

    // Si se cambia la dársena, verificar que no esté ocupada por otro turno activo
    if (dock && dock !== t.dock) {
      const ocupada = all.find(x => x.dock === dock && !['EGRESADO', 'DESATRACADO'].includes(x.status) && x.turno_id !== turnoId);
      if (ocupada) return res.json({ success: false, error: 'La dársena ' + dock + ' está ocupada por ' + ocupada.truck });
    }

    await db.updateTurno(turnoId, {
      truck: truck.toUpperCase().trim(),
      carrier: carrier || t.carrier,
      chofer: (chofer !== undefined) ? (chofer || null) : t.chofer,
      operation: operation || t.operation,
      dock: (dock !== undefined) ? (dock || '') : t.dock,
      warehouse: warehouse || t.warehouse
    });
    res.json({ success: true });
  } catch (err) {
    console.error('Error en /api/turno/editar:', err);
    res.json({ success: false, error: 'Error de base de datos' });
  }
});

app.post('/api/turno/eliminar', async (req, res) => {
  try {
    const { turnoId, pin } = req.body;
    if (String(pin) !== String(EDIT_PIN)) return res.json({ success: false, error: 'PIN incorrecto' });
    if (!turnoId) return res.json({ success: false, error: 'Turno requerido' });
    const n = await db.deleteTurno(turnoId);
    if (!n) return res.json({ success: false, error: 'Turno no encontrado' });
    res.json({ success: true });
  } catch (err) {
    console.error('Error en /api/turno/eliminar:', err);
    res.json({ success: false, error: 'Error de base de datos' });
  }
});

// Atraque automático (escanear QR de dársena)
app.post('/api/dock/:dockId', async (req, res) => {
  const dockId = req.params.dockId;

  try {
    const all = await db.listTurnos({ fresh: true });
    const t = all.find(x => x.dock === dockId && !['EGRESADO', 'DESATRACADO'].includes(x.status));
    if (!t) return res.json({ success: false, error: 'No hay ningún camión asignado a esta dársena' });

    if (t.status === 'DARSENA_ASIGNADA') {
      await db.updateTurno(t.turno_id, { status: 'ATRACADO', ts_atracado: db.now() });
      return res.json({ success: true, action: 'atracado', truck: t.truck });
    } else if (t.status === 'ATRACADO') {
      if (t.llaves_recibidas && !t.llaves_devueltas) {
        return res.json({ success: false, error: 'El chofer debe RETIRAR LAS LLAVES en Seguridad Interna antes de desatracar.' });
      }
      await db.updateTurno(t.turno_id, { status: 'DESATRACADO', dock: '', ts_desatracado: db.now() });
      return res.json({ success: true, action: 'desatracado', truck: t.truck });
    } else {
      return res.json({ success: false, error: 'Estado no válido: ' + t.status });
    }
  } catch (err) {
    console.error('Error en /api/dock:', err);
    res.json({ success: false, error: 'Error de base de datos' });
  }
});

// Registrar salida
app.post('/api/salida', async (req, res) => {
  const { truck } = req.body;

  try {
    const patenteUpper = (truck || '').toUpperCase().trim();
    const all = await db.listTurnos({ fresh: true });
    const t = all.find(x => (x.truck || '').toUpperCase() === patenteUpper && x.status === 'DESATRACADO');
    if (!t) return res.json({ success: false, error: 'No se encontró un turno desatracado para esa patente' });

    await db.updateTurno(t.turno_id, { status: 'EGRESADO', ts_egreso: db.now() });
    res.json({ success: true, turno: t });
  } catch (err) {
    console.error('Error en /api/salida:', err);
    res.json({ success: false, error: 'Error de base de datos' });
  }
});

// ===================== API GARITA: LOGIN =====================
app.post('/api/garita/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.json({ success: false, error: 'Email y contraseña requeridos' });
    const user = await db.authUser('garita', email, password);
    if (!user) return res.json({ success: false, error: 'Credenciales inválidas' });
    res.json({ success: true, nombre: user.nombre, email: user.email });
  } catch (err) {
    console.error(err);
    res.json({ success: false, error: 'Error de base de datos' });
  }
});

// ===================== API GARITA: CHECK DUPLICADO =====================
app.get('/api/garita/check-duplicado/:patente', async (req, res) => {
  try {
    const patente = req.params.patente.toUpperCase().trim();
    const all = await db.listTurnos({ fresh: true });
    const turnos = all
      .filter(t => (t.truck || '').toUpperCase() === patente && t.status !== 'EGRESADO')
      .sort((a, b) => new Date(b.ts_entrada || 0) - new Date(a.ts_entrada || 0));
    if (turnos.length === 0) return res.json({ exists: false });
    res.json({ exists: true, turnos, registrado_por: turnos[0].registrado_por || 'driver' });
  } catch (err) {
    console.error(err);
    res.json({ exists: false, error: 'Error de base de datos' });
  }
});

// ===================== API LEGAJO CHOFER (ART + seguro de vehículo, por DNI) =====================
app.get('/api/choferes/:dni', async (req, res) => {
  try {
    const dni = (req.params.dni || '').trim();
    if (!dni) return res.json({ found: false });
    const chofer = await db.getChoferByDni(dni);
    if (!chofer) return res.json({ found: false });
    res.json({
      found: true,
      chofer,
      art_vencida: seguroVencido(chofer.art_vigencia),
      seguro_vencido: seguroVencido(chofer.seguro_vigencia)
    });
  } catch (err) {
    console.error('Error en /api/choferes/:dni:', err);
    res.json({ found: false, error: 'Error de base de datos' });
  }
});

// true si la vigencia (YYYY-MM-DD) ya pasó (comparación lexicográfica, válida para ese formato)
function seguroVencido(vigenciaStr) {
  if (!vigenciaStr) return false;
  const hoy = new Date().toISOString().slice(0, 10);
  return String(vigenciaStr).slice(0, 10) < hoy;
}

// ===================== API GARITA: ENTRADA =====================
app.post('/api/garita/entrada', async (req, res) => {
  try {
    const { truck, carrier, chofer, dni_chofer, celular_chofer, patente_semi,
            contenedor, precinto, obs_ingreso, carga_estado,
            art_empresa, art_poliza, art_vigencia,
            seguro_empresa, seguro_poliza, seguro_vigencia } = req.body;

    if (!truck || !carrier || !chofer) {
      return res.json({ success: false, error: 'Patente, transportista y chofer son requeridos' });
    }

    // Bloqueo: ART o seguro del vehículo vencidos no pueden ingresar hasta actualizar la vigencia
    if (seguroVencido(art_vigencia)) {
      return res.json({ success: false, blocked: 'art',
        error: '🚫 La ART del chofer está VENCIDA (venció el ' + art_vigencia + '). Actualizá la vigencia para poder registrar el ingreso.' });
    }
    if (seguroVencido(seguro_vigencia)) {
      return res.json({ success: false, blocked: 'seguro',
        error: '🚫 El seguro del vehículo está VENCIDO (venció el ' + seguro_vigencia + '). Actualizá la vigencia para poder registrar el ingreso.' });
    }

    const patenteUpper = truck.toUpperCase().trim();

    // Guarda/actualiza el legajo del chofer por DNI (solo pisa campos que vienen con dato)
    if (dni_chofer) {
      const choferPatch = { nombre: chofer };
      if (art_empresa) choferPatch.art_empresa = art_empresa;
      if (art_poliza) choferPatch.art_poliza = art_poliza;
      if (art_vigencia) choferPatch.art_vigencia = art_vigencia;
      if (seguro_empresa) choferPatch.seguro_empresa = seguro_empresa;
      if (seguro_poliza) choferPatch.seguro_poliza = seguro_poliza;
      if (seguro_vigencia) choferPatch.seguro_vigencia = seguro_vigencia;
      await db.upsertChofer(dni_chofer, choferPatch);
    }

    const all = await db.listTurnos({ fresh: true });
    const existing = all
      .filter(t => (t.truck || '').toUpperCase() === patenteUpper && t.status !== 'EGRESADO')
      .sort((a, b) => new Date(b.ts_entrada || 0) - new Date(a.ts_entrada || 0))[0];

    if (existing) {
      if ((existing.registrado_por || 'driver') === 'driver') {
        await db.updateTurno(existing.turno_id, {
          chofer, dni_chofer: dni_chofer || null, celular_chofer: celular_chofer || null,
          patente_semi: patente_semi ? patente_semi.toUpperCase() : null,
          contenedor: contenedor || null, precinto: precinto || null, obs_ingreso: obs_ingreso || null,
          registrado_por: 'guardia', carga_estado: carga_estado || 'VACIO'
        });
        return res.json({ success: true, turno_id: existing.turno_id, enriched: true });
      } else {
        return res.json({ success: false, error: 'Vehículo ya registrado en predio por garita' });
      }
    }

    const turnoId = await generarId();
    await db.insertTurno({
      turno_id: turnoId, truck: patenteUpper, carrier, chofer,
      dni_chofer: dni_chofer || null, celular_chofer: celular_chofer || null,
      patente_semi: patente_semi ? patente_semi.toUpperCase() : null,
      contenedor: contenedor || null, precinto: precinto || null, obs_ingreso: obs_ingreso || null,
      type: 'INBOUND', status: 'ESPERANDO_ASIGNACION', ts_entrada: db.now(),
      registrado_por: 'guardia', carga_estado: carga_estado || 'VACIO'
    });

    // Avisar a los operadores: hay un camión esperando dársena
    await notifyOperators({
      title: '🚛 Camión esperando dársena',
      body: patenteUpper + ' · ' + carrier + ' — asignale una dársena',
      url: '/operador',
      tag: 'esperando-' + turnoId
    });

    res.json({ success: true, turno_id: turnoId, enriched: false });
  } catch (err) {
    console.error('Error en /api/garita/entrada:', err);
    res.json({ success: false, error: 'Error de base de datos: ' + err.message });
  }
});

// ===================== API GARITA: SALIDA =====================
app.post('/api/garita/salida', async (req, res) => {
  try {
    const { truck, obs_egreso } = req.body;
    if (!truck) return res.json({ success: false, error: 'Patente requerida' });

    const patenteUpper = truck.toUpperCase().trim();

    const all = await db.listTurnos({ fresh: true });
    const turno = all
      .filter(t => (t.truck || '').toUpperCase() === patenteUpper && t.status !== 'EGRESADO')
      .sort((a, b) => new Date(b.ts_entrada || 0) - new Date(a.ts_entrada || 0))[0];

    if (!turno) {
      return res.json({ success: false, error: 'No se encontró vehículo activo con esa patente' });
    }

    // Bloqueo: el chofer debe retirar las llaves en Seguridad Interna antes de egresar
    if (turno.llaves_recibidas && !turno.llaves_devueltas) {
      return res.json({ success: false, blocked: 'llaves',
        error: 'El chofer debe RETIRAR LAS LLAVES en Seguridad Interna antes de salir del predio.' });
    }

    const updated = await db.updateTurno(turno.turno_id, {
      status: 'EGRESADO', ts_egreso: db.now(), obs_egreso: obs_egreso || null
    });
    res.json({ success: true, turno: updated });
  } catch (err) {
    console.error('Error en /api/garita/salida:', err);
    res.json({ success: false, error: 'Error de base de datos' });
  }
});

// ===================== API GARITA: HISTORIAL =====================
app.get('/api/garita/historial', async (req, res) => {
  try {
    const days = parseInt(req.query.days) || 7;
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    const all = await db.listTurnos();
    const turnos = all
      .filter(t => t.ts_entrada && new Date(t.ts_entrada).getTime() > cutoff)
      .sort((a, b) => new Date(b.ts_entrada || 0) - new Date(a.ts_entrada || 0));
    res.json({ success: true, turnos });
  } catch (err) {
    console.error(err);
    res.json({ success: false, error: 'Error de base de datos' });
  }
});

// ===================== API SEGURIDAD INTERNA: LLAVES =====================
// Login de seguridad interna
app.post('/api/interna/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.json({ success: false, error: 'Email y contraseña requeridos' });
    const user = await db.authUser('interna', email, password);
    if (!user) return res.json({ success: false, error: 'Credenciales inválidas' });
    res.json({ success: true, nombre: user.nombre, email: user.email });
  } catch (err) {
    console.error(err);
    res.json({ success: false, error: 'Error de base de datos' });
  }
});

// Camiones en el predio pendientes de entregar llaves (recién ingresados por garita)
app.get('/api/interna/pendientes-entrega', async (req, res) => {
  try {
    const all = await db.listTurnos();
    const turnos = all
      .filter(t => t.status === 'ATRACADO' && !t.llaves_recibidas)
      .sort((a, b) => new Date(a.ts_atracado || 0) - new Date(b.ts_atracado || 0));
    res.json({ success: true, turnos });
  } catch (err) {
    console.error(err);
    res.json({ success: false, error: 'Error de base de datos' });
  }
});

// Camiones desatracados pendientes de retirar llaves (flujo inverso)
app.get('/api/interna/pendientes-devolucion', async (req, res) => {
  try {
    const all = await db.listTurnos();
    const turnos = all
      .filter(t => t.status === 'ATRACADO' && t.llaves_recibidas && !t.llaves_devueltas)
      .sort((a, b) => new Date(a.ts_llaves_entrega || 0) - new Date(b.ts_llaves_entrega || 0));
    res.json({ success: true, turnos });
  } catch (err) {
    console.error(err);
    res.json({ success: false, error: 'Error de base de datos' });
  }
});

// Registrar entrega de llaves + ingreso a nave (define nave destino y operación)
app.post('/api/interna/entrega', async (req, res) => {
  try {
    const { turnoId, operation } = req.body;
    if (!turnoId) return res.json({ success: false, error: 'Turno requerido' });

    const t = await db.getTurno(turnoId);
    if (!t) return res.json({ success: false, error: 'Turno no encontrado' });
    if (t.llaves_recibidas) return res.json({ success: true, already: true, turno_id: t.turno_id });
    if (t.status !== 'ATRACADO') {
      return res.json({ success: false, error: 'El camión todavía no atracó' });
    }
    const patch = { llaves_recibidas: true, ts_llaves_entrega: db.now() };
    if (operation) patch.operation = operation;
    await db.updateTurno(turnoId, patch);
    res.json({ success: true, turno_id: turnoId });
  } catch (err) {
    console.error('Error en /api/interna/entrega:', err);
    res.json({ success: false, error: 'Error de base de datos' });
  }
});

// Registrar devolución (retiro) de llaves al chofer
app.post('/api/interna/devolucion', async (req, res) => {
  try {
    const { turnoId } = req.body;
    if (!turnoId) return res.json({ success: false, error: 'Turno requerido' });

    const t = await db.getTurno(turnoId);
    if (!t) return res.json({ success: false, error: 'Turno no encontrado' });
    if (t.llaves_devueltas) return res.json({ success: true, already: true, turno_id: t.turno_id });
    await db.updateTurno(turnoId, { llaves_devueltas: true, ts_llaves_retiro: db.now() });
    res.json({ success: true, turno_id: turnoId, truck: t.truck });
  } catch (err) {
    console.error('Error en /api/interna/devolucion:', err);
    res.json({ success: false, error: 'Error de base de datos' });
  }
});

// ==================== DASHBOARD STATS ====================
app.get('/api/dashboard/stats', async (req, res) => {
  try {
    const range = req.query.range || 'today';
    let fromDate, toDate;
    const now = new Date();
    const arNow = new Date(now.toLocaleString('en-US', { timeZone: 'America/Argentina/Buenos_Aires' }));

    if (range === 'custom') {
      fromDate = req.query.from || arNow.toISOString().slice(0, 10);
      toDate = req.query.to || arNow.toISOString().slice(0, 10);
      // toDate inclusive: add 1 day
      const td = new Date(toDate);
      td.setDate(td.getDate() + 1);
      toDate = td.toISOString().slice(0, 10);
    } else if (range === 'week') {
      const dayOfWeek = arNow.getDay() || 7; // lunes=1
      const monday = new Date(arNow);
      monday.setDate(arNow.getDate() - dayOfWeek + 1);
      fromDate = monday.toISOString().slice(0, 10);
      const tomorrow = new Date(arNow);
      tomorrow.setDate(arNow.getDate() + 1);
      toDate = tomorrow.toISOString().slice(0, 10);
    } else if (range === 'month') {
      fromDate = arNow.toISOString().slice(0, 8) + '01';
      const tomorrow = new Date(arNow);
      tomorrow.setDate(arNow.getDate() + 1);
      toDate = tomorrow.toISOString().slice(0, 10);
    } else {
      // today
      fromDate = arNow.toISOString().slice(0, 10);
      const tomorrow = new Date(arNow);
      tomorrow.setDate(arNow.getDate() + 1);
      toDate = tomorrow.toISOString().slice(0, 10);
    }

    const fromMs = new Date(fromDate).getTime();
    const toMs = new Date(toDate).getTime();
    const all = await db.listTurnos();
    const completed = all.filter(t => t.ts_egreso && t.ts_entrada &&
      new Date(t.ts_entrada).getTime() >= fromMs && new Date(t.ts_entrada).getTime() < toMs);

    const secs = (a, b) => (a && b) ? (new Date(a).getTime() - new Date(b).getTime()) / 1000 : null;
    const avgOf = (arr) => arr.length ? arr.reduce((s, x) => s + x, 0) / arr.length : 0;

    const predios = completed.map(t => secs(t.ts_egreso, t.ts_entrada)).filter(v => v != null && v >= 0);
    const atraques = completed.map(t => secs(t.ts_desatracado, t.ts_atracado)).filter(v => v != null && v >= 0);
    const esperas = completed.map(t => secs(t.ts_asignacion, t.ts_entrada)).filter(v => v != null && v >= 0);

    // Agrupador genérico: {key -> {count, sumPredio}}
    function groupBy(keyFn) {
      const m = new Map();
      completed.forEach(t => {
        const k = keyFn(t);
        if (!m.has(k)) m.set(k, { count: 0, sum: 0, n: 0 });
        const g = m.get(k); g.count++;
        const p = secs(t.ts_egreso, t.ts_entrada);
        if (p != null && p >= 0) { g.sum += p; g.n++; }
      });
      return m;
    }
    const toArr = (m, label) => [...m.entries()]
      .map(([k, g]) => ({ [label]: k, count: g.count, avgPredio: g.n ? g.sum / g.n : 0 }))
      .sort((a, b) => b.count - a.count);

    const byOpArr = toArr(groupBy(t => t.operation || 'Sin tipo'), 'operation');
    const byWhArr = toArr(groupBy(t => t.warehouse || 'Sin nave'), 'warehouse');
    const byCarrierArr = toArr(groupBy(t => t.carrier || 'Sin asignar'), 'carrier').slice(0, 10);

    const hourMap = new Map();
    completed.forEach(t => {
      const h = new Date(t.ts_entrada).getHours();
      hourMap.set(h, (hourMap.get(h) || 0) + 1);
    });
    const byHour = [...hourMap.entries()].map(([hour, count]) => ({ hour, count })).sort((a, b) => a.hour - b.hour);

    // Tendencia diaria últimos 30 días (sobre todos los completados, no solo el rango)
    const trend30 = Date.now() - 30 * 24 * 60 * 60 * 1000;
    const dayMap = new Map();
    all.filter(t => t.ts_egreso && t.ts_entrada && new Date(t.ts_entrada).getTime() >= trend30)
      .forEach(t => {
        const day = new Date(t.ts_entrada).toISOString().slice(0, 10);
        dayMap.set(day, (dayMap.get(day) || 0) + 1);
      });
    const dailyTrend = [...dayMap.entries()].map(([day, count]) => ({ day, count })).sort((a, b) => a.day.localeCompare(b.day));

    res.json({
      success: true,
      stats: {
        avgPredio: avgOf(predios),
        avgAtraque: avgOf(atraques),
        avgEspera: avgOf(esperas),
        totalCompleted: completed.length,
        byOperation: byOpArr,
        byWarehouse: byWhArr,
        byCarrier: byCarrierArr,
        byHour,
        dailyTrend
      },
      range, fromDate, toDate
    });
  } catch (err) {
    console.error('Error dashboard stats:', err);
    res.json({ success: false, error: 'Error de consulta' });
  }
});

// ===================== PÁGINAS HTML =====================

// Página raíz - redirige a entrada
app.get('/', (req, res) => {
  res.redirect('/entrada');
});

// ==================== PÁGINA ENTRADA (CHOFERES) ====================
app.get('/entrada', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html><head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      ${fontLink}
      <title>Bienvenido a Tortuguitas - OCASA</title>
      <style>${styles}
        label { display: block; text-align: left; color: ${colors.textMuted}; font-size: 14px; margin-bottom: 4px; margin-top: 12px; font-weight: 600; }
        .steps { text-align: left; margin: 0; padding: 0; list-style: none; counter-reset: step; }
        .step { display: flex; align-items: flex-start; gap: 14px; padding: 12px 0; border-bottom: 1px solid ${colors.borderLight}; }
        .step:last-child { border-bottom: none; }
        .step-num {
          flex: 0 0 32px; width: 32px; height: 32px; border-radius: 50%;
          background: ${colors.primary}; color: #fff; font-weight: 700; font-size: 15px;
          display: flex; align-items: center; justify-content: center;
        }
        .step-text { flex: 1; font-size: 15px; color: ${colors.textSecondary}; line-height: 1.4; padding-top: 4px; }
        .step-text strong { color: ${colors.textPrimary}; }
        .safety {
          background: rgba(255,171,64,0.12); border: 1px solid ${colors.orange};
          border-radius: 12px; padding: 16px; margin-top: 20px; text-align: left;
        }
        .safety h3 { margin: 0 0 8px 0; color: #b45309; font-size: 15px; }
        .safety p { margin: 0; font-size: 14px; color: ${colors.textSecondary}; }
        #prereg input, #prereg select { text-align: left; }
        .field-error { display:none; }
      </style>
    </head><body>
      <div class="container" style="text-align:center; padding-top:40px;">
        <img src="${logoSrc}" alt="OCASA" class="logo-large">
        <div class="icon-circle icon-primary" style="margin:0 auto 16px;">🚛</div>
        <h1>Bienvenido a Tortuguitas</h1>
        <p class="subtitle">Seguí estos pasos al llegar a la planta</p>

        <div class="card">
          <ol class="steps">
            <li class="step"><div class="step-num">1</div><div class="step-text">Presentate en la <strong>garita</strong> con tu documentación.</div></li>
            <li class="step"><div class="step-num">2</div><div class="step-text">La guardia <strong>registra tu ingreso</strong> y te entrega un <strong>código QR</strong>.</div></li>
            <li class="step"><div class="step-num">3</div><div class="step-text"><strong>Escaneá el QR</strong> para seguir el estado de tu turno en tiempo real.</div></li>
            <li class="step"><div class="step-num">4</div><div class="step-text">Dejá las <strong>llaves del camión</strong> en <strong>Seguridad Interna</strong>.</div></li>
            <li class="step"><div class="step-num">5</div><div class="step-text">Dirigite a la <strong>dársena asignada</strong>.</div></li>
            <li class="step"><div class="step-num">6</div><div class="step-text">Al terminar, <strong>retirá las llaves</strong> en Seguridad Interna y salí por garita.</div></li>
          </ol>
        </div>

        <div class="safety">
          <h3>⚠️ Seguridad</h3>
          <p>Usá <strong>zapatos de seguridad</strong> y <strong>chaleco reflectivo</strong> en todo momento dentro de la planta.</p>
        </div>

        <p class="refresh-notice">OCASA Dock Manager · Planta Tortuguitas</p>
      </div>
    </body></html>
  `);
});

// ==================== PÁGINA TURNO (ESTADO DEL CHOFER) ====================
app.get('/turno/:id', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html><head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      ${fontLink}
      <title>Mi Turno - OCASA Dock Manager</title>
      <style>${styles}</style>
    </head><body>
      <div class="container" style="padding-top: 20px;">
        <div style="text-align: center;">
          <img src="${logoSrc}" alt="OCASA" class="logo">
        </div>
        <div id="content">
          <div style="text-align: center; padding-top: 40px;">
            <div class="icon-circle icon-primary">⏳</div>
            <p>Cargando...</p>
          </div>
        </div>
      </div>
      
      <script>
        const turnoId = '${req.params.id}';

        async function loadTurno() {
          try {
            const res = await fetch('/api/turno/' + turnoId);
            const data = await res.json();

            if (data.success) {
              renderTurno(data.turno);
            } else {
              document.getElementById('content').innerHTML = '<div class="error">Turno no encontrado</div>';
            }
          } catch(e) {
            document.getElementById('content').innerHTML = '<div class="error">Error de conexión</div>';
          }
        }

        function renderTurno(t) {
          const naveTxt = t.warehouse ? ' (' + t.warehouse + ')' : '';
          let statusMsg = '';
          if (t.status === 'ESPERANDO_ASIGNACION') {
            statusMsg = '⏳ Esperando asignación de dársena';
          } else if (t.status === 'DARSENA_ASIGNADA') {
            statusMsg = '📍 Dirigite a la dársena ' + t.dock + naveTxt + ' y atracá';
          } else if (t.status === 'ATRACADO' && !t.llaves_recibidas) {
            statusMsg = '🔑 Atracado en ' + t.dock + ' — entregá las llaves en Seguridad Interna';
          } else if (t.status === 'ATRACADO' && !t.llaves_devueltas) {
            statusMsg = '🔄 Operación en curso en ' + t.dock + ' — al terminar retirá las llaves en Seguridad Interna';
          } else if (t.status === 'ATRACADO') {
            statusMsg = '✅ Llaves retiradas — ya podés desatracar';
          } else if (t.status === 'DESATRACADO') {
            statusMsg = '✅ Operación finalizada. Dirigite a la salida';
          } else if (t.status === 'EGRESADO') {
            statusMsg = '👋 ¡Hasta pronto!';
          }

          const iconClass = t.status === 'EGRESADO' || (t.status === 'DESATRACADO' && t.llaves_devueltas) ? 'icon-green' : 'icon-primary';

          let html = '<div style="text-align: center;">';
          html += '<div class="icon-circle ' + iconClass + '">🚛</div>';
          html += '<h1>' + t.truck + '</h1>';
          html += '<p class="subtitle">' + statusMsg + '</p>';
          html += '</div>';

          // Banner de dársena destacado cuando está asignada o atracando
          if ((t.status === 'DARSENA_ASIGNADA' || t.status === 'ATRACADO') && t.dock) {
            html += '<div class="card" style="background: rgba(0,153,168,0.08); border: 2px solid ${colors.primary}; text-align: center; margin-bottom: 16px;">';
            html += '<p style="margin:0; font-size:13px; color:${colors.textMuted}; font-weight:600;">TU DÁRSENA</p>';
            html += '<p style="margin:8px 0 4px 0; font-size:32px; font-weight:700; color:${colors.primary};">' + t.dock + '</p>';
            html += '<p style="margin:0; font-size:14px; color:${colors.textSecondary};">' + (t.warehouse || '') + (t.operation ? ' • ' + t.operation : '') + '</p>';
            html += '</div>';
          }

          html += '<div class="card">';
          html += '<div class="timeline">';

          html += renderTimelineItem(t.ts_entrada, 'Ingresó al predio', t.status === 'ESPERANDO_ASIGNACION');
          html += renderTimelineItem(t.ts_asignacion, 'Dársena asignada' + (t.dock ? ': ' + t.dock : ''), t.status === 'ESPERANDO_ASIGNACION');
          html += renderTimelineItem(t.ts_atracado, 'Atracado', t.status === 'DARSENA_ASIGNADA');
          html += renderTimelineItem(t.ts_llaves_entrega, 'Entregó llaves', t.status === 'ATRACADO' && !t.llaves_recibidas);
          html += renderTimelineItem(t.ts_llaves_retiro, 'Retiró llaves', t.status === 'ATRACADO' && t.llaves_recibidas && !t.llaves_devueltas);
          html += renderTimelineItem(t.ts_desatracado, 'Desatracado', t.status === 'ATRACADO' && t.llaves_devueltas);
          html += renderTimelineItem(t.ts_egreso, 'Egreso', t.status === 'DESATRACADO');

          html += '</div></div>';

          // Safety notice
          html += '<div class="card" style="background: #fffbeb; border: 1px solid #fde68a; margin-top: 16px;">';
          html += '<p style="margin: 0; font-weight: 600; color: #d97706;">⚠️ PUNTOS A TENER EN CUENTA</p>';
          html += '<p style="margin: 8px 0 0 0; font-size: 14px; color: ${colors.textPrimary};">• Usar <strong>zapatos de seguridad</strong></p>';
          html += '<p style="margin: 4px 0 0 0; font-size: 14px; color: ${colors.textPrimary};">• Usar <strong>chaleco reflectivo</strong></p>';
          html += '</div>';
          html += '<p class="refresh-notice">🔄 Actualizando automáticamente</p>';

          document.getElementById('content').innerHTML = html;
        }
        
        function renderTimelineItem(ts, text, isCurrent) {
          const done = ts ? 'done' : '';
          const current = isCurrent ? 'current' : '';
          return '<div class="timeline-item ' + done + ' ' + current + '">' +
            '<div class="timeline-time">' + formatTime(ts) + '</div>' +
            '<div class="timeline-text">' + text + '</div></div>';
        }
        
        function formatTime(ts) {
          if (!ts) return '--:--';
          return new Date(ts).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' });
        }
        
        loadTurno();
        setInterval(loadTurno, 5000);
      </script>
    </body></html>
  `);
});

// ==================== PÁGINA DOCK (QR DÁRSENA) ====================
app.get('/dock/:dockId', (req, res) => {
  const dockId = req.params.dockId;
  res.send(`
    <!DOCTYPE html>
    <html><head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      ${fontLink}
      <title>Dársena ${dockId} - OCASA Dock Manager</title>
      <style>${styles}</style>
    </head><body>
      <div class="container" style="text-align: center; padding-top: 40px;">
        <img src="${logoSrc}" alt="OCASA" class="logo">
        <div id="loading">
          <div class="icon-circle icon-primary">⚓</div>
          <h1>Dársena ${dockId}</h1>
          <p class="subtitle">Consultando estado...</p>
        </div>
        <div id="preview" style="display:none;"></div>
        <div id="result" style="display:none;"></div>
      </div>

      <script>
        async function cargarEstado() {
          try {
            const res = await fetch('/api/turnos');
            const data = await res.json();
            const turnos = data.turnos || [];
            const turno = turnos.find(t => t.dock === '${dockId}' && t.status !== 'EGRESADO' && t.status !== 'DESATRACADO');

            document.getElementById('loading').style.display = 'none';

            if (!turno) {
              document.getElementById('preview').style.display = 'block';
              document.getElementById('preview').innerHTML =
                '<div class="card">' +
                '<div class="icon-circle" style="background: ${colors.light};">✓</div>' +
                '<h2 style="color: ${colors.textMuted};">Dársena libre</h2>' +
                '<p class="subtitle">No hay ningún camión asignado a ${dockId}</p>' +
                '</div>';
              return;
            }

            const accion = turno.status === 'DARSENA_ASIGNADA' ? 'atracar' : 'desatracar';
            const accionLabel = accion === 'atracar' ? '⚓ Confirmar Atraque' : '🚪 Confirmar Desatraque';
            const accionColor = accion === 'atracar' ? 'btn-primary' : 'btn-orange';

            document.getElementById('preview').style.display = 'block';
            document.getElementById('preview').innerHTML =
              '<div class="card" style="text-align:left;">' +
              '<div style="text-align:center; margin-bottom: 16px;">' +
              '<div class="icon-circle icon-primary" style="margin: 0 auto 12px;">🚛</div>' +
              '<h1 style="margin:0;">' + turno.truck + '</h1>' +
              '<p style="color:${colors.textMuted}; margin-top:4px;">' + turno.carrier + '</p>' +
              '</div>' +
              '<div style="border-top: 1px solid ${colors.border}; padding-top: 16px; margin-top: 8px;">' +
              '<p style="margin: 6px 0;"><strong>Dársena:</strong> ${dockId}</p>' +
              '<p style="margin: 6px 0;"><strong>Operación:</strong> ' + (turno.operation || '-') + '</p>' +
              '<p style="margin: 6px 0;"><strong>Nave:</strong> ' + (turno.warehouse || '-') + '</p>' +
              '<p style="margin: 6px 0;"><strong>Estado:</strong> ' + turno.status.replace(/_/g, ' ') + '</p>' +
              '</div>' +
              '</div>' +
              '<p style="color:${colors.textSecondary}; font-size:14px; font-weight:500; margin-bottom: 8px;">¿Confirmar <strong>' + accion + '</strong> de este camión?</p>' +
              '<button class="btn ' + accionColor + '" onclick="ejecutar(\\'' + accion + '\\')" id="btnConfirm">' + accionLabel + '</button>' +
              '<button class="btn" style="background:${colors.light}; color:${colors.textSecondary}; margin-top:8px;" onclick="location.reload()">Cancelar</button>';
          } catch(e) {
            document.getElementById('loading').style.display = 'none';
            document.getElementById('preview').style.display = 'block';
            document.getElementById('preview').innerHTML =
              '<div class="card"><div class="icon-circle" style="background:#fef2f2;">❌</div>' +
              '<h1 style="color:#dc2626;">Error de conexión</h1>' +
              '<button class="btn btn-primary" onclick="location.reload()">Reintentar</button></div>';
          }
        }

        async function ejecutar(accion) {
          document.getElementById('btnConfirm').disabled = true;
          document.getElementById('btnConfirm').innerHTML = '⏳ Procesando...';

          try {
            const res = await fetch('/api/dock/${dockId}', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({})
            });
            const data = await res.json();

            document.getElementById('preview').style.display = 'none';
            document.getElementById('result').style.display = 'block';

            if (data.success) {
              if (data.action === 'atracado') {
                document.getElementById('result').innerHTML =
                  '<div class="card"><div class="icon-circle icon-green">✅</div>' +
                  '<h1 style="color:#16a34a;">¡Atracado!</h1>' +
                  '<p class="subtitle">Camión ' + data.truck + '</p>' +
                  '<p style="color:${colors.textMuted};">Dársena ${dockId}</p></div>' +
                  '<button class="btn btn-primary" onclick="location.reload()">Escanear otra dársena</button>';
              } else {
                let desatraqueHtml = '<div class="card"><div class="icon-circle icon-orange">🚪</div>' +
                  '<h1 style="color:#d97706;">¡Desatracado!</h1>' +
                  '<p class="subtitle">Camión ' + data.truck + '</p>';

                desatraqueHtml += '<div style="margin-top:16px; padding:16px; background:rgba(0,153,168,0.08); border:2px solid ${colors.primary}; border-radius:12px;">';
                desatraqueHtml += '<p style="margin:0; font-size:14px; font-weight:600; color:${colors.primary};">✅ Operación finalizada. El chofer puede dirigirse a la garita para el egreso.</p>';
                desatraqueHtml += '</div>';

                desatraqueHtml += '</div>';
                desatraqueHtml += '<button class="btn btn-primary" onclick="location.reload()">Escanear otra dársena</button>';
                document.getElementById('result').innerHTML = desatraqueHtml;
              }
            } else {
              document.getElementById('result').innerHTML =
                '<div class="card"><div class="icon-circle" style="background:#fef2f2;">❌</div>' +
                '<h1 style="color:#dc2626;">Error</h1>' +
                '<p class="subtitle">' + data.error + '</p>' +
                '<button class="btn btn-primary" onclick="location.reload()">Reintentar</button></div>';
            }
          } catch(e) {
            document.getElementById('result').innerHTML =
              '<div class="card"><div class="icon-circle" style="background:#fef2f2;">❌</div>' +
              '<h1 style="color:#dc2626;">Error de conexión</h1>' +
              '<button class="btn btn-primary" onclick="location.reload()">Reintentar</button></div>';
          }
        }

        cargarEstado();
      </script>
    </body></html>
  `);
});

// ==================== PÁGINA SALIDA ====================
app.get('/salida', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html><head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      ${fontLink}
      <title>Salida - OCASA Dock Manager</title>
      <style>${styles}</style>
    </head><body>
      <div class="container" style="text-align: center; padding-top: 40px;">
        <img src="${logoSrc}" alt="OCASA" class="logo-large">
        <div class="icon-circle icon-orange">🚪</div>
        <h1>Registro de Salida</h1>
        <p class="subtitle">Ingresá tu patente para registrar egreso</p>
        
        <div id="error" class="error" style="display:none;"></div>
        <div id="success" class="success" style="display:none;"></div>
        
        <div class="card">
          <input type="text" id="truck" placeholder="Ej: AA-123-BB" maxlength="10"
                 style="text-transform: uppercase; font-family: monospace; font-size: 24px; text-align: center;">
          <button class="btn btn-orange" onclick="registrar()" id="btnSubmit">
            🚪 Registrar Salida
          </button>
        </div>
      </div>
      
      <script>
        document.getElementById('truck').addEventListener('keyup', function(e) {
          this.value = this.value.toUpperCase();
          if (e.key === 'Enter') registrar();
        });
        document.getElementById('truck').focus();
        
        async function registrar() {
          const truck = document.getElementById('truck').value.trim();
          if (!truck) { showError('Ingresá tu patente'); return; }
          
          document.getElementById('btnSubmit').disabled = true;
          document.getElementById('btnSubmit').innerHTML = '⏳ Procesando...';
          
          try {
            const res = await fetch('/api/salida', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ truck })
            });
            const data = await res.json();
            
            if (data.success) {
              const t = data.turno;
              const entradaTime = t.ts_entrada ? new Date(t.ts_entrada) : null;
              const tiempoEnPredio = entradaTime ? Math.floor((Date.now() - entradaTime.getTime()) / 60000) : 0;
              const horas = Math.floor(tiempoEnPredio / 60);
              const mins = tiempoEnPredio % 60;
              const tiempoStr = horas > 0 ? horas + 'h ' + mins + 'min' : mins + ' min';

              document.getElementById('success').innerHTML =
                '<strong>✅ Egreso registrado</strong><br>' +
                '<span style="font-size:13px;">Patente: <strong>' + t.truck + '</strong> — ' +
                'Transportista: <strong>' + t.carrier + '</strong> — ' +
                'Tiempo en predio: <strong>' + tiempoStr + '</strong></span>';
              document.getElementById('success').style.display = 'block';
              document.getElementById('error').style.display = 'none';

              setTimeout(() => {
                document.getElementById('truck').value = '';
                document.getElementById('success').style.display = 'none';
                document.getElementById('btnSubmit').disabled = false;
                document.getElementById('btnSubmit').innerHTML = '🚪 Registrar Salida';
                document.getElementById('truck').focus();
              }, 5000);
            } else {
              showError(data.error);
              resetBtn();
            }
          } catch(e) {
            showError('Error de conexión');
            resetBtn();
          }
        }
        
        function resetBtn() {
          document.getElementById('btnSubmit').disabled = false;
          document.getElementById('btnSubmit').innerHTML = '🚪 Registrar Salida';
        }
        
        function showError(msg) {
          document.getElementById('success').style.display = 'none';
          document.getElementById('error').textContent = msg;
          document.getElementById('error').style.display = 'block';
        }
        function showSuccess(msg) {
          document.getElementById('error').style.display = 'none';
          document.getElementById('success').textContent = msg;
          document.getElementById('success').style.display = 'block';
        }
      </script>
    </body></html>
  `);
});

// ==================== PÁGINA OPERADOR ====================
app.get('/operador', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html><head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <meta name="theme-color" content="${colors.primary}">
      <link rel="manifest" href="/manifest.webmanifest">
      <link rel="apple-touch-icon" href="/public/icon-192.png">
      <meta name="apple-mobile-web-app-capable" content="yes">
      <meta name="apple-mobile-web-app-status-bar-style" content="default">
      <meta name="apple-mobile-web-app-title" content="Dock Operador">
      ${fontLink}
      <title>Panel Operador - OCASA Dock Manager</title>
      <style>${styles}
        .nav-tabs { display: flex; gap: 8px; margin-bottom: 16px; }
        .nav-tab { flex: 1; padding: 12px; border: 2px solid ${colors.primary}; background: ${colors.bgCard}; color: ${colors.primary}; border-radius: 8px; font-family: 'Montserrat', sans-serif; font-size: 15px; font-weight: 600; cursor: pointer; transition: all 0.2s; }
        .nav-tab:hover { background: rgba(0,153,168,0.06); }
        .nav-tab.active { background: ${colors.primary}; color: white; }
        .turno-row { display: flex; align-items: center; gap: 12px; padding: 14px; background: ${colors.bgCard}; border-radius: 10px; margin-bottom: 8px; flex-wrap: wrap; border: 1px solid ${colors.border}; box-shadow: 0 1px 2px ${colors.shadow}; transition: all 0.2s; }
        .turno-row:hover { border-color: ${colors.primary}; box-shadow: 0 2px 8px ${colors.shadowHover}; }
        .turno-info-main { flex: 1; min-width: 200px; }
        .turno-info-main h3 { margin: 0; font-size: 15px; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
        .turno-info-main p { margin: 4px 0 0 0; font-size: 13px; color: ${colors.textMuted}; }
        .turno-actions { display: flex; gap: 8px; align-items: center; }
        .turno-actions select { padding: 8px 12px; font-size: 14px; min-height: 40px; border-radius: 8px; min-width: 100px; }
        .turno-actions button { padding: 8px 16px; font-size: 14px; min-height: 40px; white-space: nowrap; border-radius: 8px; }
        .op-badge { font-size: 11px; padding: 2px 8px; border-radius: 4px; font-weight: 600; letter-spacing: 0.3px; }
        .op-descarga { background: #fef2f2; color: #dc2626; border: 1px solid #fecaca; }
        .op-colecta { background: #eff6ff; color: #2563eb; border: 1px solid #bfdbfe; }
        .op-carga { background: #f0fdf4; color: #16a34a; border: 1px solid #bbf7d0; }
        .dock-cell { cursor: pointer; transition: transform 0.1s, box-shadow 0.2s; }
        .dock-cell:hover { transform: scale(1.08); box-shadow: 0 2px 8px ${colors.shadowHover}; }

        /* ===== Móvil (uso principal en celular) ===== */
        @media (max-width: 600px) {
          .header { align-items: flex-start; }
          .header-left { gap: 10px; }
          .header .logo { height: 40px; padding: 7px 12px; margin-bottom: 0; }
          .nav-tabs { flex-wrap: wrap; gap: 6px; }
          .nav-tab { flex: 1 1 calc(50% - 6px); padding: 12px 6px; font-size: 14px; min-height: 46px; }
          .nav-tab-dashboard { flex: 1 1 100%; }
          .turno-row { padding: 12px; }
          .turno-info-main { min-width: 100%; }
          .turno-actions { width: 100%; flex-wrap: wrap; }
          .turno-actions select { flex: 1; min-height: 48px; font-size: 16px; }
          .turno-actions button { min-height: 48px; flex: 0 0 auto; }
          .dock-grid { grid-template-columns: repeat(auto-fill, minmax(60px, 1fr)); gap: 6px; }
          .dock { padding: 12px 4px; font-size: 13px; min-height: 44px; }
        }
      </style>
    </head><body>
      <div class="container-wide">
        <div class="header">
          <div class="header-left">
            <img src="${logoSrc}" alt="OCASA" class="logo">
            <div>
              <h1>Panel Operador</h1>
              <p class="subtitle" style="margin:0;">Gestión de dársenas y turnos</p>
            </div>
          </div>
          <div style="display:flex; gap:8px; align-items:center;">
            <a href="/qr-darsenas" style="background:${colors.primaryLight}; border:1px solid ${colors.primary}; color:${colors.primary}; padding:8px 16px; border-radius:8px; font-family:'Montserrat',sans-serif; font-size:13px; font-weight:600; text-decoration:none;">🔳 QR dársenas</a>
            <button id="audioBtn" onclick="enableAlerts()" style="background: #fffbeb; border: 1px solid #fde68a; color: #d97706; padding: 8px 16px; border-radius: 8px; font-family: 'Montserrat', sans-serif; font-size: 13px; font-weight: 600; cursor: pointer; transition: all 0.2s;">🔔 Activar avisos</button>
          </div>
        </div>
        
        <div class="nav-tabs">
          <button class="nav-tab active" onclick="setFilter('Nave 1')" id="tab-Nave 1">🏭 Nave 1</button>
          <button class="nav-tab" onclick="setFilter('Nave 2')" id="tab-Nave 2">🏭 Nave 2</button>
          <button class="nav-tab" onclick="setFilter('Nave 3')" id="tab-Nave 3">🏭 Nave 3</button>
          <button class="nav-tab" onclick="setFilter('TODOS')" id="tab-TODOS">📋 Todos</button>
          <div style="flex:1;"></div>
          <button class="nav-tab nav-tab-dashboard" onclick="toggleDashboard()" id="tab-DASHBOARD">📊 Dashboard</button>
        </div>

        <!-- Vista operador (turnos activos) -->
        <div id="operatorView">
          <div class="kpis-row" id="kpis">
            <div class="kpi"><div class="kpi-value">-</div><div class="kpi-label">En predio</div></div>
            <div class="kpi"><div class="kpi-value">-</div><div class="kpi-label">Esperando</div></div>
            <div class="kpi"><div class="kpi-value">-</div><div class="kpi-label">Atracados</div></div>
            <div class="kpi"><div class="kpi-value">-</div><div class="kpi-label">Dársenas libres</div></div>
          </div>

          <div style="display:flex; align-items:center; gap:12px; margin-bottom:12px; flex-wrap:wrap;">
            <h2 style="margin:0;">Turnos activos</h2>
            <input type="text" id="searchTurnos" placeholder="Buscar patente o transportista..."
                   oninput="renderTurnos()"
                   style="flex:1; min-width:200px; margin:0; padding:10px 14px; font-size:14px; min-height:40px;">
            <button onclick="toggleViewMode()" id="viewModeBtn" style="background:${colors.bgCard}; border:1px solid ${colors.border}; color:${colors.textSecondary}; padding:8px 14px; border-radius:8px; font-family:'Montserrat',sans-serif; font-size:13px; font-weight:600; cursor:pointer; white-space:nowrap;">📋 Vista tabla</button>
          </div>
          <div id="turnos"></div>

          <h2 style="margin-top: 24px;">Estado de dársenas</h2>
          <div id="docks"></div>

          <p class="refresh-notice">🔄 Actualizando automáticamente cada 5 segundos</p>
        </div>

        <!-- Vista dashboard (KPIs históricos) -->
        <div id="dashboardView" style="display:none;">
          <div class="date-range-bar">
            <button class="range-btn active" id="range-today" onclick="loadDashboardData('today')">Hoy</button>
            <button class="range-btn" id="range-week" onclick="loadDashboardData('week')">Semana</button>
            <button class="range-btn" id="range-month" onclick="loadDashboardData('month')">Mes</button>
            <button class="range-btn" id="range-custom" onclick="showCustomRange()">Personalizado</button>
            <input type="date" id="dash-from" style="display:none; width:auto; min-height:36px; padding:6px 10px; font-size:13px; border:1px solid ${colors.border}; border-radius:8px; font-family:'Montserrat',sans-serif;" onchange="loadDashboardData('custom')">
            <input type="date" id="dash-to" style="display:none; width:auto; min-height:36px; padding:6px 10px; font-size:13px; border:1px solid ${colors.border}; border-radius:8px; font-family:'Montserrat',sans-serif;" onchange="loadDashboardData('custom')">
          </div>
          <div id="dashboardContent">
            <div class="dash-empty">⏳ Cargando datos...</div>
          </div>
        </div>
      </div>
      
      <!-- Modal detalle -->
      <div class="modal-overlay" id="modal">
        <div class="modal">
          <div class="modal-header">
            <h2 id="modal-title">Detalle</h2>
            <button class="modal-close" onclick="closeModal()">✕</button>
          </div>
          <div id="modal-content"></div>
        </div>
      </div>
      
      <script>
        // Numeración POR NAVE (cada nave arranca en 1). IDs con prefijo para no pisarse: N1-01, N2-30, N3-06.
        const NAVE_DOCKS = { 'Nave 1': [1, 8], 'Nave 2': [1, 30], 'Nave 3': [7, 15] }; // [desde, hasta] por nave
        const NAVE_PREFIX = { 'Nave 1': 'N1', 'Nave 2': 'N2', 'Nave 3': 'N3' };
        function dockId(nave, i){ return (NAVE_PREFIX[nave] || 'N1') + '-' + String(i).padStart(2, '0'); }
        function docksDe(nave){ const a = []; const r = NAVE_DOCKS[nave]; if (!r) return a; for (let i = r[0]; i <= r[1]; i++) a.push(dockId(nave, i)); return a; }
        function allDocks(){ return Object.keys(NAVE_DOCKS).reduce((a, nv) => a.concat(docksDe(nv)), []); }
        function naveFromDock(dock){ const p = (dock || '').split('-')[0]; for (const k in NAVE_PREFIX) { if (NAVE_PREFIX[k] === p) return k; } return 'Nave 1'; }
        // Opciones de dársenas agrupadas por nave (la nave se elige al asignar la dársena)
        function dockOptionsHtml(){
          let h = '';
          Object.keys(NAVE_DOCKS).forEach(nv => {
            h += '<optgroup label="' + nv + '">';
            docksDe(nv).forEach(d => {
              const ocupada = allTurnos.some(x => x.dock === d && x.status !== 'EGRESADO' && x.status !== 'DESATRACADO');
              h += '<option value="' + d + '"' + (ocupada ? ' disabled' : '') + '>' + d + (ocupada ? ' (ocup)' : '') + '</option>';
            });
            h += '</optgroup>';
          });
          return h;
        }

        let allTurnos = [];
        let currentFilter = 'TODOS';
        let prevEsperando = -1;
        let audioEnabled = false;
        let activeSelect = null;
        let viewMode = 'cards'; // 'cards' o 'table'
        let collapsedGroups = {};
        let dashboardMode = false;
        let dashboardRange = 'today';
        let dashboardData = null;
        
        // Detectar cuando alguien está usando un select
        document.addEventListener('focus', (e) => {
          if (e.target.tagName === 'SELECT') activeSelect = e.target.id;
        }, true);
        document.addEventListener('blur', (e) => {
          if (e.target.tagName === 'SELECT') setTimeout(() => activeSelect = null, 100);
        }, true);
        
        function playAlert() {
          if (!audioEnabled) return;
          const ctx = new (window.AudioContext || window.webkitAudioContext)();
          const o = ctx.createOscillator();
          const g = ctx.createGain();
          o.connect(g);
          g.connect(ctx.destination);
          o.frequency.value = 800;
          g.gain.value = 0.3;
          o.start();
          o.stop(ctx.currentTime + 0.3);
        }
        
        function enableAudio() {
          audioEnabled = true;
        }

        function markAlertsOn(label) {
          const btn = document.getElementById('audioBtn');
          btn.innerHTML = label;
          btn.style.background = '#f0fdf4';
          btn.style.borderColor = '#bbf7d0';
          btn.style.color = '#16a34a';
        }

        // ===== Notificaciones push (PWA) =====
        const VAPID_PUBLIC = '${process.env.VAPID_PUBLIC_KEY || ''}';

        function urlBase64ToUint8Array(base64String) {
          const padding = '='.repeat((4 - base64String.length % 4) % 4);
          const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
          const rawData = window.atob(base64);
          return Uint8Array.from([...rawData].map(c => c.charCodeAt(0)));
        }

        async function subscribePush() {
          if (!VAPID_PUBLIC || !('serviceWorker' in navigator) || !('PushManager' in window)) return false;
          try {
            const reg = await navigator.serviceWorker.register('/sw.js');
            await navigator.serviceWorker.ready;
            const perm = await Notification.requestPermission();
            if (perm !== 'granted') return false;
            let sub = await reg.pushManager.getSubscription();
            if (!sub) {
              sub = await reg.pushManager.subscribe({
                userVisibleOnly: true,
                applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC)
              });
            }
            await fetch('/api/push/subscribe', {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(sub)
            });
            return true;
          } catch(e) {
            console.error('Push subscribe error:', e);
            return false;
          }
        }

        async function enableAlerts() {
          enableAudio();
          const pushOk = await subscribePush();
          markAlertsOn(pushOk ? '🔊 Avisos + notificaciones ON' : '🔊 Sonido activado (sin push)');
          if (!pushOk && VAPID_PUBLIC) {
            showToast('Para notificaciones con la app cerrada, permití las notificaciones en el navegador', 'error');
          }
        }

        // Si ya está suscripto de antes, reflejarlo al cargar
        (async () => {
          try {
            if ('serviceWorker' in navigator && Notification.permission === 'granted') {
              const reg = await navigator.serviceWorker.register('/sw.js');
              const sub = await reg.pushManager.getSubscription();
              if (sub) { enableAudio(); markAlertsOn('🔊 Avisos + notificaciones ON'); }
            }
          } catch(e) {}
        })();
        
        function setFilter(filter) {
          // Si estamos en dashboard, salir de él
          if (dashboardMode) {
            dashboardMode = false;
            document.getElementById('operatorView').style.display = '';
            document.getElementById('dashboardView').style.display = 'none';
            document.getElementById('tab-DASHBOARD').classList.remove('active');
          }
          currentFilter = filter;
          document.querySelectorAll('.nav-tab:not(.nav-tab-dashboard)').forEach(t => t.classList.remove('active'));
          document.getElementById('tab-' + filter).classList.add('active');
          renderTurnos();
          renderKPIs();
        }
        
        async function loadData() {
          try {
            const res = await fetch('/api/turnos');
            const data = await res.json();
            allTurnos = data.turnos || [];
            
            const esperando = allTurnos.filter(t => t.status === 'ESPERANDO_ASIGNACION').length;
            if (esperando > prevEsperando && prevEsperando >= 0) {
              playAlert();
            }
            prevEsperando = esperando;
            
            renderKPIs();
            if (!activeSelect) {
              renderTurnos();
              renderDocks();
            }
          } catch(e) {
            console.error(e);
          }
        }
        
        function getFilteredTurnos() {
          if (currentFilter === 'TODOS') return allTurnos;
          // Turnos sin nave todavía (esperando asignación) se ven en todas las pestañas
          return allTurnos.filter(t => t.warehouse === currentFilter || !t.warehouse);
        }
        
        function getTimeAgo(ts) {
          if (!ts) return '';
          const mins = Math.floor((Date.now() - new Date(ts).getTime()) / 60000);
          if (mins < 1) return 'ahora';
          if (mins < 60) return mins + ' min';
          const hrs = Math.floor(mins / 60);
          const remMins = mins % 60;
          return hrs + 'h ' + remMins + 'm';
        }

        function getTimeBadgeClass(ts) {
          if (!ts) return 'time-badge';
          const mins = Math.floor((Date.now() - new Date(ts).getTime()) / 60000);
          if (mins > 120) return 'time-badge danger';
          if (mins > 60) return 'time-badge warning';
          return 'time-badge';
        }

        function renderKPIs() {
          const filtered = getFilteredTurnos();
          const activos = filtered.filter(t => t.status !== 'EGRESADO');
          const enPredio = activos.length;
          const esperando = activos.filter(t => t.status === 'ESPERANDO_ASIGNACION').length;
          const atracados = activos.filter(t => t.status === 'ATRACADO').length;

          const totalDocks = currentFilter === 'TODOS' ? allDocks().length : docksDe(currentFilter).length;
          const docksOcupados = activos.filter(t => t.dock && t.status !== 'DESATRACADO').length;
          const docksLibres = totalDocks - docksOcupados;

          document.getElementById('kpis').innerHTML =
            '<div class="kpi"><div class="kpi-value">' + enPredio + '</div><div class="kpi-label">En predio</div></div>' +
            '<div class="kpi"><div class="kpi-value" style="color:#d97706;">' + esperando + '</div><div class="kpi-label">Esperando</div></div>' +
            '<div class="kpi"><div class="kpi-value">' + atracados + '</div><div class="kpi-label">Atracados</div></div>' +
            '<div class="kpi"><div class="kpi-value" style="color:#16a34a;">' + docksLibres + '</div><div class="kpi-label">Dársenas libres</div></div>';
        }
        
        function toggleViewMode() {
          viewMode = viewMode === 'cards' ? 'table' : 'cards';
          const btn = document.getElementById('viewModeBtn');
          btn.innerHTML = viewMode === 'cards' ? '📋 Vista tabla' : '🃏 Vista tarjetas';
          renderTurnos();
        }

        function toggleGroup(groupKey) {
          collapsedGroups[groupKey] = !collapsedGroups[groupKey];
          renderTurnos();
        }

        function renderTurnos() {
          const filtered = getFilteredTurnos();
          let activos = filtered.filter(t => t.status !== 'EGRESADO');

          // Filtro de búsqueda
          const search = (document.getElementById('searchTurnos') || {}).value || '';
          if (search.trim()) {
            const q = search.trim().toLowerCase();
            activos = activos.filter(t =>
              t.truck.toLowerCase().includes(q) ||
              (t.carrier || '').toLowerCase().includes(q) ||
              (t.dock || '').toLowerCase().includes(q)
            );
          }

          if (activos.length === 0) {
            document.getElementById('turnos').innerHTML = '<div class="card" style="text-align:center; opacity:0.6;">' + (search.trim() ? 'Sin resultados para "' + search.trim() + '"' : 'No hay turnos activos en ' + currentFilter) + '</div>';
            return;
          }

          // Agrupar por estado
          const statusOrder = ['ESPERANDO_ASIGNACION', 'DARSENA_ASIGNADA', 'ATRACADO', 'DESATRACADO'];
          const statusLabels = {
            'ESPERANDO_ASIGNACION': '⏳ Esperando asignación',
            'DARSENA_ASIGNADA': '📍 Dársena asignada',
            'ATRACADO': '⚓ Atracados',
            'DESATRACADO': '🚪 Desatracados'
          };
          const statusColors = {
            'ESPERANDO_ASIGNACION': '#d97706',
            'DARSENA_ASIGNADA': '${colors.primary}',
            'ATRACADO': '#16a34a',
            'DESATRACADO': '#ea580c'
          };

          const groups = {};
          statusOrder.forEach(s => { groups[s] = []; });
          activos.forEach(t => {
            if (groups[t.status]) groups[t.status].push(t);
          });

          let html = '';
          statusOrder.forEach(status => {
            const items = groups[status];
            if (items.length === 0) return;
            const collapsed = collapsedGroups[status];
            const color = statusColors[status];
            html += '<div style="margin-bottom:16px;">';
            html += '<div onclick="toggleGroup(\\'' + status + '\\')" style="cursor:pointer; display:flex; align-items:center; gap:8px; padding:10px 14px; background:' + color + '10; border:1px solid ' + color + '30; border-radius:10px; margin-bottom:' + (collapsed ? '0' : '8') + 'px; user-select:none;">';
            html += '<span style="font-size:13px; transform:rotate(' + (collapsed ? '-90' : '0') + 'deg); transition:transform 0.2s;">▼</span>';
            html += '<span style="font-weight:600; font-size:14px; color:' + color + ';">' + statusLabels[status] + '</span>';
            html += '<span style="background:' + color + '; color:white; font-size:11px; font-weight:700; padding:2px 8px; border-radius:10px; margin-left:4px;">' + items.length + '</span>';
            html += '</div>';

            if (!collapsed) {
              if (viewMode === 'table') {
                html += renderTurnosTable(items, status);
              } else {
                items.forEach(t => { html += renderTurnoCard(t); });
              }
            }
            html += '</div>';
          });

          document.getElementById('turnos').innerHTML = html;
        }

        function renderTurnoCard(t) {
          const opBadge = t.operation === 'Colecta'
            ? '<span class="op-badge op-colecta">COLECTA</span>'
            : (t.operation === 'Carga' ? '<span class="op-badge op-carga">CARGA</span>' : '<span class="op-badge op-descarga">DESCARGA</span>');

          let html = '<div class="turno-row" onclick="showDetail(\\'' + t.turno_id + '\\')">';
          html += '<div class="turno-info-main">';
          html += '<h3>' + t.truck + ' ' + getStatusBadge(t.status) + ' ' + opBadge + '</h3>';
          html += '<p>' + t.carrier + (t.dock ? ' • ' + t.dock : '') + '</p>';
          html += '</div>';
          html += '<div class="turno-actions">';

          if (t.status === 'ESPERANDO_ASIGNACION') {
            html += '<select id="dock-' + t.turno_id + '" onclick="event.stopPropagation();">' + dockOptionsHtml() + '</select>';
            html += '<button class="btn btn-green" onclick="event.stopPropagation(); asignar(\\'' + t.turno_id + '\\')">Asignar</button>';
          }

          if (t.status === 'DESATRACADO') {
            html += '<select id="reasign-' + t.turno_id + '" onclick="event.stopPropagation();">';
            html += '<option value="">🔄 Reasignar...</option>';
            allDocks().forEach(d => {
              const ocupada = allTurnos.some(x => x.dock === d && x.status !== 'EGRESADO' && x.status !== 'DESATRACADO');
              if (!ocupada) html += '<option value="' + d + '">' + d + '</option>';
            });
            html += '</select>';
            html += '<button class="btn btn-orange" onclick="event.stopPropagation(); reasignar(\\'' + t.turno_id + '\\')">Reasignar</button>';
          }

          html += '<div style="text-align:right;">';
          html += '<div class="' + getTimeBadgeClass(t.ts_entrada) + '">⏱ ' + getTimeAgo(t.ts_entrada) + '</div>';
          html += '<div class="time-badge">' + formatTime(t.ts_entrada) + '</div>';
          html += '</div>';
          html += '</div></div>';
          return html;
        }

        function renderTurnosTable(items, status) {
          let html = '<div style="overflow-x:auto;">';
          html += '<table style="width:100%; border-collapse:separate; border-spacing:0; font-size:13px; background:white; border-radius:10px; overflow:hidden; border:1px solid ${colors.border};">';
          html += '<thead><tr style="background:${colors.bg};">';
          html += '<th style="padding:10px 12px; text-align:left; font-weight:600; color:${colors.textSecondary}; font-size:11px; text-transform:uppercase; letter-spacing:0.5px;">Patente</th>';
          html += '<th style="padding:10px 12px; text-align:left; font-weight:600; color:${colors.textSecondary}; font-size:11px; text-transform:uppercase; letter-spacing:0.5px;">Transportista</th>';
          html += '<th style="padding:10px 12px; text-align:left; font-weight:600; color:${colors.textSecondary}; font-size:11px; text-transform:uppercase; letter-spacing:0.5px;">Op</th>';
          html += '<th style="padding:10px 12px; text-align:left; font-weight:600; color:${colors.textSecondary}; font-size:11px; text-transform:uppercase; letter-spacing:0.5px;">Dársena</th>';
          html += '<th style="padding:10px 12px; text-align:left; font-weight:600; color:${colors.textSecondary}; font-size:11px; text-transform:uppercase; letter-spacing:0.5px;">Tiempo</th>';
          html += '<th style="padding:10px 12px; text-align:center; font-weight:600; color:${colors.textSecondary}; font-size:11px; text-transform:uppercase; letter-spacing:0.5px;">Acción</th>';
          html += '</tr></thead><tbody>';

          items.forEach((t, idx) => {
            const rowBg = idx % 2 === 0 ? 'white' : '${colors.bg}';
            const opBadge = t.operation === 'Colecta'
              ? '<span class="op-badge op-colecta">COL</span>'
              : (t.operation === 'Carga' ? '<span class="op-badge op-carga">CAR</span>' : '<span class="op-badge op-descarga">DESC</span>');

            html += '<tr style="background:' + rowBg + '; cursor:pointer;" onclick="showDetail(\\'' + t.turno_id + '\\')" onmouseover="this.style.background=\\'${colors.bgCardHover}\\'" onmouseout="this.style.background=\\'' + rowBg + '\\'">';
            html += '<td style="padding:10px 12px; font-weight:600; white-space:nowrap;">' + t.truck + '</td>';
            html += '<td style="padding:10px 12px; max-width:180px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">' + t.carrier + '</td>';
            html += '<td style="padding:10px 12px;">' + opBadge + '</td>';
            html += '<td style="padding:10px 12px; font-weight:600;">' + (t.dock || '-') + '</td>';
            html += '<td style="padding:10px 12px;"><span class="' + getTimeBadgeClass(t.ts_entrada) + '">⏱ ' + getTimeAgo(t.ts_entrada) + '</span></td>';
            html += '<td style="padding:10px 12px; text-align:center;" onclick="event.stopPropagation();">';

            if (t.status === 'ESPERANDO_ASIGNACION') {
              html += '<div style="display:flex; gap:4px; justify-content:center;">';
              html += '<select id="dock-' + t.turno_id + '" style="min-height:32px; padding:4px 8px; font-size:12px; min-width:70px; margin:0;">' + dockOptionsHtml() + '</select>';
              html += '<button class="btn btn-green" style="min-height:32px; padding:4px 10px; font-size:12px; margin:0; width:auto; display:inline-block;" onclick="asignar(\\'' + t.turno_id + '\\')">✓</button>';
              html += '</div>';
            } else if (t.status === 'DESATRACADO') {
              html += '<div style="display:flex; gap:4px; justify-content:center;">';
              html += '<select id="reasign-' + t.turno_id + '" style="min-height:32px; padding:4px 8px; font-size:12px; min-width:70px; margin:0;">';
              html += '<option value="">🔄...</option>';
              allDocks().forEach(d => {
                const ocupada = allTurnos.some(x => x.dock === d && x.status !== 'EGRESADO' && x.status !== 'DESATRACADO');
                if (!ocupada) html += '<option value="' + d + '">' + d + '</option>';
              });
              html += '</select>';
              html += '<button class="btn btn-orange" style="min-height:32px; padding:4px 10px; font-size:12px; margin:0; width:auto; display:inline-block;" onclick="reasignar(\\'' + t.turno_id + '\\')">✓</button>';
              html += '</div>';
            } else {
              html += '<span style="color:${colors.textMuted};">—</span>';
            }

            html += '</td></tr>';
          });

          html += '</tbody></table></div>';
          return html;
        }
        
        function renderDocks() {
          let html = '';

          Object.keys(NAVE_DOCKS).forEach(nave => {
            const docks = docksDe(nave);
            const desde = docks[0];
            const hasta = docks[docks.length - 1];
            html += '<div class="warehouse"><h3>🏭 ' + nave + ' (' + desde + ' a ' + hasta + ')</h3><div class="dock-grid">';
            docks.forEach(d => {
              const turnoEnDock = allTurnos.find(t => t.dock === d && t.status !== 'EGRESADO' && t.status !== 'DESATRACADO');
              const ocupada = !!turnoEnDock;
              html += '<div class="dock dock-cell ' + (ocupada ? 'dock-occupied' : 'dock-free') + '" onclick="showDockDetail(\\'' + d + '\\')">' + d + '</div>';
            });
            html += '</div></div>';
          });

          document.getElementById('docks').innerHTML = html;
        }
        
        function showDockDetail(dockId) {
          const turno = allTurnos.find(t => t.dock === dockId && t.status !== 'EGRESADO' && t.status !== 'DESATRACADO');
          
          document.getElementById('modal-title').textContent = 'Dársena ' + dockId;
          
          let html = '';
          if (turno) {
            html += '<div style="text-align:center; padding: 16px 0;">';
            html += '<div class="icon-circle icon-green" style="margin: 0 auto 16px;">🚛</div>';
            html += '<h2 style="margin:0;">' + turno.truck + '</h2>';
            html += '<p style="color:' + colors.textMuted + ';">' + turno.carrier + '</p>';
            html += '<p>' + getStatusBadge(turno.status) + '</p>';
            if (turno.warehouse) html += '<p>Nave: <strong>' + turno.warehouse + '</strong></p>';
            if (turno.operation) html += '<p>Operación: <strong>' + turno.operation + '</strong></p>';
            html += '</div>';
            
            html += '<div class="timeline">';
            html += renderTimelineItem(turno.ts_entrada, 'Ingreso');
            html += renderTimelineItem(turno.ts_asignacion, 'Asignado a ' + dockId);
            html += renderTimelineItem(turno.ts_atracado, 'Atracado');
            html += '</div>';
          } else {
            html += '<div style="text-align:center; padding: 32px 0;">';
            html += '<div class="icon-circle" style="margin: 0 auto 16px; background: rgba(255,255,255,0.1);">✓</div>';
            html += '<h3 style="margin:0; color:' + colors.textMuted + ';">Dársena libre</h3>';
            html += '</div>';
          }
          
          document.getElementById('modal-content').innerHTML = html;
          document.getElementById('modal').classList.add('active');
        }
        
        async function asignar(turnoId) {
          const dock = document.getElementById('dock-' + turnoId).value;
          const warehouse = naveFromDock(dock);
          
          try {
            const res = await fetch('/api/asignar', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ turnoId, dock, warehouse })
            });
            const data = await res.json();
            if (data.success) {
              showToast('Dársena asignada correctamente', 'success');
              loadData();
            } else {
              showToast(data.error, 'error');
            }
          } catch(e) {
            showToast('Error de conexión', 'error');
          }
        }

        async function reasignar(turnoId) {
          const dock = document.getElementById('reasign-' + turnoId).value;
          if (!dock) {
            showToast('Seleccioná un dock para reasignar', 'error');
            return;
          }
          const warehouse = naveFromDock(dock);
          
          try {
            const res = await fetch('/api/reasignar', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ turnoId, dock, warehouse })
            });
            const data = await res.json();
            if (data.success) {
              showToast('Reasignación exitosa', 'success');
              loadData();
            } else {
              showToast(data.error, 'error');
            }
          } catch(e) {
            showToast('Error de conexión', 'error');
          }
        }

        function showDetail(turnoId) {
          const t = allTurnos.find(x => x.turno_id === turnoId);
          if (!t) return;

          document.getElementById('modal-title').textContent = t.truck;

          let html = '<div style="margin-bottom:16px;">';
          html += '<p><strong>Transportista:</strong> ' + t.carrier + '</p>';
          if (t.chofer) html += '<p><strong>Chofer:</strong> ' + t.chofer + '</p>';
          if (t.warehouse) html += '<p><strong>Nave:</strong> ' + t.warehouse + '</p>';
          if (t.operation) html += '<p><strong>Operación:</strong> ' + t.operation + '</p>';
          html += '</div>';

          html += '<div class="timeline">';
          html += renderTimelineItem(t.ts_entrada, 'Ingreso al predio');
          html += renderTimelineItem(t.ts_asignacion, 'Dársena asignada' + (t.dock ? ': ' + t.dock : ''));
          html += renderTimelineItem(t.ts_atracado, 'Atracado');
          html += renderTimelineItem(t.ts_llaves_entrega, 'Entregó llaves');
          html += renderTimelineItem(t.ts_llaves_retiro, 'Retiró llaves');
          html += renderTimelineItem(t.ts_desatracado, 'Desatracado');
          html += renderTimelineItem(t.ts_egreso, 'Egreso');
          html += '</div>';

          // Acciones de supervisor (requieren PIN)
          html += '<div style="display:flex; gap:8px; margin-top:18px; padding-top:14px; border-top:1px solid ${colors.border};">';
          html += '<button class="btn" style="flex:1; margin:0; min-height:44px; background:rgba(0,153,168,0.08); color:${colors.primary}; border:1px solid ${colors.primary};" onclick="showEditForm(\\'' + t.turno_id + '\\')">✏️ Editar</button>';
          html += '<button class="btn" style="flex:1; margin:0; min-height:44px; background:#fef2f2; color:#dc2626; border:1px solid #fecaca;" onclick="eliminarTurno(\\'' + t.turno_id + '\\')">🗑️ Eliminar</button>';
          html += '</div>';
          html += '<p style="margin:8px 0 0 0; font-size:11px; color:${colors.textMuted}; text-align:center;">🔒 Requiere PIN de supervisor</p>';

          document.getElementById('modal-content').innerHTML = html;
          document.getElementById('modal').classList.add('active');
        }

        // ===== Editar / eliminar turno (con PIN de supervisor) =====
        let cachedPin = sessionStorage.getItem('op_pin') || '';

        function pedirPin() {
          if (cachedPin) return cachedPin;
          const p = prompt('🔒 Ingresá el PIN de supervisor:');
          return p ? p.trim() : null;
        }
        function pinOk(p) { cachedPin = p; sessionStorage.setItem('op_pin', p); }
        function pinFail() { cachedPin = ''; sessionStorage.removeItem('op_pin'); }

        function showEditForm(turnoId) {
          const t = allTurnos.find(x => x.turno_id === turnoId);
          if (!t) return;

          document.getElementById('modal-title').textContent = '✏️ Editar ' + t.truck;

          let html = '<div>';
          html += '<label style="font-size:12px; font-weight:600; color:${colors.textSecondary};">PATENTE</label>';
          html += '<input type="text" id="edit-truck" value="' + (t.truck || '') + '" style="text-transform:uppercase;">';
          html += '<label style="font-size:12px; font-weight:600; color:${colors.textSecondary};">TRANSPORTISTA</label>';
          html += '<input type="text" id="edit-carrier" value="' + (t.carrier || '') + '">';
          html += '<label style="font-size:12px; font-weight:600; color:${colors.textSecondary};">CHOFER</label>';
          html += '<input type="text" id="edit-chofer" value="' + (t.chofer || '') + '">';
          html += '<label style="font-size:12px; font-weight:600; color:${colors.textSecondary};">OPERACIÓN</label>';
          html += '<select id="edit-op">';
          ['Descarga','Carga'].forEach(op => {
            html += '<option value="' + op + '"' + (t.operation === op ? ' selected' : '') + '>' + op + '</option>';
          });
          html += '</select>';
          html += '<label style="font-size:12px; font-weight:600; color:${colors.textSecondary};">DÁRSENA</label>';
          html += '<select id="edit-dock"><option value="">Sin asignar</option>';
          Object.keys(NAVE_DOCKS).forEach(nv => {
            html += '<optgroup label="' + nv + '">';
            docksDe(nv).forEach(d => {
              const ocupada = allTurnos.some(x => x.dock === d && x.status !== 'EGRESADO' && x.status !== 'DESATRACADO' && x.turno_id !== turnoId);
              html += '<option value="' + d + '"' + (t.dock === d ? ' selected' : '') + (ocupada ? ' disabled' : '') + '>' + d + (ocupada ? ' (ocup)' : '') + '</option>';
            });
            html += '</optgroup>';
          });
          html += '</select>';
          html += '<div style="display:flex; gap:8px; margin-top:14px;">';
          html += '<button class="btn btn-green" style="flex:1; margin:0; min-height:48px;" onclick="guardarEdicion(\\'' + turnoId + '\\')">💾 Guardar</button>';
          html += '<button class="btn" style="flex:1; margin:0; min-height:48px; background:${colors.light}; color:${colors.textSecondary};" onclick="showDetail(\\'' + turnoId + '\\')">Cancelar</button>';
          html += '</div>';
          html += '</div>';

          document.getElementById('modal-content').innerHTML = html;
        }

        async function guardarEdicion(turnoId) {
          const pin = pedirPin();
          if (!pin) return;
          const dock = document.getElementById('edit-dock').value;
          const body = {
            turnoId, pin,
            truck: document.getElementById('edit-truck').value.trim().toUpperCase(),
            carrier: document.getElementById('edit-carrier').value.trim(),
            chofer: document.getElementById('edit-chofer').value.trim(),
            operation: document.getElementById('edit-op').value,
            dock: dock,
            warehouse: dock ? naveFromDock(dock) : ''
          };
          try {
            const res = await fetch('/api/turno/editar', {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(body)
            });
            const data = await res.json();
            if (data.success) {
              pinOk(pin);
              showToast('✏️ Turno actualizado', 'success');
              closeModal();
              loadData();
            } else {
              if ((data.error || '').includes('PIN')) pinFail();
              showToast(data.error || 'No se pudo editar', 'error');
            }
          } catch(e) { showToast('Error de conexión', 'error'); }
        }

        async function eliminarTurno(turnoId) {
          const t = allTurnos.find(x => x.turno_id === turnoId);
          if (!confirm('¿Eliminar el turno de ' + (t ? t.truck : turnoId) + '? Esta acción no se puede deshacer.')) return;
          const pin = pedirPin();
          if (!pin) return;
          try {
            const res = await fetch('/api/turno/eliminar', {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ turnoId, pin })
            });
            const data = await res.json();
            if (data.success) {
              pinOk(pin);
              showToast('🗑️ Turno eliminado', 'success');
              closeModal();
              loadData();
            } else {
              if ((data.error || '').includes('PIN')) pinFail();
              showToast(data.error || 'No se pudo eliminar', 'error');
            }
          } catch(e) { showToast('Error de conexión', 'error'); }
        }
        
        function renderTimelineItem(ts, text) {
          const done = ts ? 'done' : '';
          return '<div class="timeline-item ' + done + '">' +
            '<div class="timeline-time">' + formatDateTime(ts) + '</div>' +
            '<div class="timeline-text">' + text + '</div></div>';
        }
        
        function closeModal() {
          document.getElementById('modal').classList.remove('active');
        }

        document.addEventListener('keydown', function(e) {
          if (e.key === 'Escape') closeModal();
        });

        document.getElementById('modal').addEventListener('click', function(e) {
          if (e.target === this) closeModal();
        });

        function showToast(msg, type) {
          let toast = document.getElementById('toast');
          if (!toast) {
            toast = document.createElement('div');
            toast.id = 'toast';
            document.body.appendChild(toast);
          }
          toast.className = 'toast toast-' + type;
          toast.textContent = msg;
          setTimeout(() => toast.classList.add('show'), 10);
          setTimeout(() => toast.classList.remove('show'), 3000);
        }

        function getStatusBadge(status) {
          const badges = {
            'ESPERANDO_ASIGNACION': '<span class="badge badge-yellow">Esperando</span>',
            'DARSENA_ASIGNADA': '<span class="badge badge-primary">Asignada</span>',
            'ATRACADO': '<span class="badge badge-green">Atracado</span>',
            'DESATRACADO': '<span class="badge badge-orange">Desatracado</span>',
            'EGRESADO': '<span class="badge badge-dark">Egresado</span>'
          };
          return badges[status] || status;
        }

        function formatTime(ts) {
          if (!ts) return '--:--';
          return new Date(ts).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' });
        }

        function formatDateTime(ts) {
          if (!ts) return '--:--';
          return new Date(ts).toLocaleString('es-AR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
        }

        // ========== DASHBOARD FUNCTIONS ==========
        function toggleDashboard() {
          dashboardMode = !dashboardMode;
          if (dashboardMode) {
            document.getElementById('operatorView').style.display = 'none';
            document.getElementById('dashboardView').style.display = '';
            document.querySelectorAll('.nav-tab:not(.nav-tab-dashboard)').forEach(t => t.classList.remove('active'));
            document.getElementById('tab-DASHBOARD').classList.add('active');
            if (!dashboardData) loadDashboardData();
          } else {
            document.getElementById('operatorView').style.display = '';
            document.getElementById('dashboardView').style.display = 'none';
            document.getElementById('tab-DASHBOARD').classList.remove('active');
            document.getElementById('tab-' + currentFilter).classList.add('active');
          }
        }

        function showCustomRange() {
          dashboardRange = 'custom';
          document.querySelectorAll('.range-btn').forEach(b => b.classList.remove('active'));
          document.getElementById('range-custom').classList.add('active');
          document.getElementById('dash-from').style.display = '';
          document.getElementById('dash-to').style.display = '';
          const today = new Date();
          const weekAgo = new Date(today);
          weekAgo.setDate(today.getDate() - 7);
          document.getElementById('dash-from').value = weekAgo.toISOString().slice(0,10);
          document.getElementById('dash-to').value = today.toISOString().slice(0,10);
          loadDashboardData('custom');
        }

        async function loadDashboardData(range) {
          if (range) dashboardRange = range;
          document.querySelectorAll('.range-btn').forEach(b => b.classList.remove('active'));
          const activeBtn = document.getElementById('range-' + dashboardRange);
          if (activeBtn) activeBtn.classList.add('active');
          if (dashboardRange !== 'custom') {
            document.getElementById('dash-from').style.display = 'none';
            document.getElementById('dash-to').style.display = 'none';
          }
          let url = '/api/dashboard/stats?range=' + dashboardRange;
          if (dashboardRange === 'custom') {
            const from = document.getElementById('dash-from').value;
            const to = document.getElementById('dash-to').value;
            if (from && to) url += '&from=' + from + '&to=' + to;
          }
          document.getElementById('dashboardContent').innerHTML = '<div class="dash-empty">⏳ Cargando datos...</div>';
          try {
            const res = await fetch(url);
            const data = await res.json();
            if (data.success) {
              dashboardData = data.stats;
              renderDashboard();
            } else {
              document.getElementById('dashboardContent').innerHTML = '<div class="dash-empty">❌ Error al cargar datos</div>';
            }
          } catch(e) {
            document.getElementById('dashboardContent').innerHTML = '<div class="dash-empty">❌ Error de conexión</div>';
          }
        }

        function formatDuration(secs) {
          if (!secs || secs <= 0) return '--';
          const h = Math.floor(secs / 3600);
          const m = Math.floor((secs % 3600) / 60);
          if (h > 0) return h + 'h ' + m + 'm';
          return m + ' min';
        }

        function renderDashboard() {
          const d = dashboardData;
          if (!d) return;
          let html = '';

          // KPI cards
          html += '<div class="kpis-row" style="margin-bottom:16px;">';
          html += '<div class="kpi"><div class="kpi-value">' + formatDuration(d.avgPredio) + '</div><div class="kpi-label">Prom. en predio</div></div>';
          html += '<div class="kpi"><div class="kpi-value">' + formatDuration(d.avgAtraque) + '</div><div class="kpi-label">Prom. atraque</div></div>';
          html += '<div class="kpi"><div class="kpi-value">' + formatDuration(d.avgEspera) + '</div><div class="kpi-label">Prom. espera</div></div>';
          html += '<div class="kpi"><div class="kpi-value" style="color:${colors.primary};">' + d.totalCompleted + '</div><div class="kpi-label">Camiones procesados</div></div>';
          html += '</div>';

          if (d.totalCompleted === 0) {
            html += '<div class="dash-empty">📭 No hay datos completados en este período</div>';
            document.getElementById('dashboardContent').innerHTML = html;
            return;
          }

          // Por operación + Por nave
          html += '<div class="dash-grid">';
          html += '<div class="dash-section"><h3>📦 Por operación</h3>';
          const maxOp = Math.max(...d.byOperation.map(o => o.count), 1);
          const opColors = { 'Descarga': 'bar-fill-primary', 'Colecta': 'bar-fill-orange', 'Carga': 'bar-fill-green' };
          d.byOperation.forEach(o => {
            const pct = (o.count / maxOp * 100).toFixed(0);
            const cls = opColors[o.operation] || 'bar-fill-primary';
            html += '<div class="bar-row"><div class="bar-label">' + (o.operation || 'S/T') + '</div>';
            html += '<div class="bar-track"><div class="bar-fill ' + cls + '" style="width:' + pct + '%;"></div></div>';
            html += '<div class="bar-value">' + o.count + ' <span style="font-size:10px;color:${colors.textMuted};">(' + formatDuration(o.avgPredio) + ')</span></div></div>';
          });
          html += '</div>';

          html += '<div class="dash-section"><h3>🏭 Por nave</h3>';
          const maxWh = Math.max(...d.byWarehouse.map(w => w.count), 1);
          d.byWarehouse.forEach(w => {
            const pct = (w.count / maxWh * 100).toFixed(0);
            const cls = 'bar-fill-primary';
            html += '<div class="bar-row"><div class="bar-label">' + (w.warehouse || 'S/N') + '</div>';
            html += '<div class="bar-track"><div class="bar-fill ' + cls + '" style="width:' + pct + '%;"></div></div>';
            html += '<div class="bar-value">' + w.count + ' <span style="font-size:10px;color:${colors.textMuted};">(' + formatDuration(w.avgPredio) + ')</span></div></div>';
          });
          html += '</div></div>';

          // Top transportistas
          if (d.byCarrier.length > 0) {
            html += '<div class="dash-grid"><div class="dash-section dash-full"><h3>🚛 Top transportistas</h3>';
            const maxCr = Math.max(...d.byCarrier.map(c => c.count), 1);
            d.byCarrier.forEach((c, i) => {
              const pct = (c.count / maxCr * 100).toFixed(0);
              html += '<div class="bar-row"><div class="bar-label" title="' + c.carrier + '">' + c.carrier + '</div>';
              html += '<div class="bar-track"><div class="bar-fill bar-fill-primary" style="width:' + pct + '%; opacity:' + (1 - i * 0.06) + ';"></div></div>';
              html += '<div class="bar-value">' + c.count + ' <span style="font-size:10px;color:${colors.textMuted};">(' + formatDuration(c.avgPredio) + ')</span></div></div>';
            });
            html += '</div></div>';
          }

          // Hora pico + Tendencia
          html += '<div class="dash-grid">';
          html += '<div class="dash-section"><h3>⏰ Distribución horaria</h3><div class="hour-chart">';
          const maxHour = Math.max(...d.byHour.map(h => h.count), 1);
          const hourMap = {};
          d.byHour.forEach(h => { hourMap[h.hour] = h.count; });
          for (let h = 0; h < 24; h++) {
            const count = hourMap[h] || 0;
            const pct = count > 0 ? Math.max((count / maxHour * 100), 5) : 0;
            html += '<div class="hour-bar-wrap"><div class="hour-bar" style="height:' + pct + '%;"><span class="hour-bar-tooltip">' + h + ':00 - ' + count + '</span></div>';
            html += '<div class="hour-label">' + (h % 3 === 0 ? h : '') + '</div></div>';
          }
          html += '</div></div>';

          html += '<div class="dash-section"><h3>📈 Tendencia diaria (30d)</h3>';
          if (d.dailyTrend.length > 0) {
            html += '<div class="trend-chart">';
            const maxDay = Math.max(...d.dailyTrend.map(t => t.count), 1);
            d.dailyTrend.forEach((t, i) => {
              const pct = Math.max((t.count / maxDay * 100), 5);
              const dayLabel = new Date(t.day).toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit' });
              const showLabel = i === 0 || i === d.dailyTrend.length - 1 || i % 5 === 0;
              html += '<div class="trend-bar-wrap"><div class="trend-bar" style="height:' + pct + '%;"><span class="trend-bar-tooltip">' + dayLabel + ': ' + t.count + '</span></div>';
              html += '<div class="trend-label">' + (showLabel ? dayLabel : '') + '</div></div>';
            });
            html += '</div>';
          } else {
            html += '<div class="dash-empty">Sin datos</div>';
          }
          html += '</div></div>';

          document.getElementById('dashboardContent').innerHTML = html;
        }

        loadData();
        setInterval(loadData, 5000);
      </script>
    </body></html>
  `);
});
// ==================== PÁGINA GARITA/SEGURIDAD ====================
app.get('/garita', (req, res) => {
  // Ruta legacy: redirige al panel de garita actual
  res.redirect('/garita-registro');
});
// ==================== PÁGINA GARITA-REGISTRO ====================
app.get('/garita-registro', (req, res) => {
  const carriers = [
    "Acaricia Transporte Logan","Adrian Servicio","Alfa Omega","Americantec","Andesmar","Andreani","Apicol","ASPELEYTER","Avaltrans","AYG Trucks",
    "Bahia SRL","Balboa","Bataglia","Beira Mar","Bessone","Better Catering","Biopak","BL Puerto y Logística","Blanca Luna","Brouclean","Bulonera Central","Bulonera Pacheco",
    "Camila Duarte","Cantarini","CASA Thames","CBC Group","CFA Fumigación","Ciari","Cimes","CISA","CLSA","Comercial Ñandubay","Container Leasing","CORREO Urbano","Cruz del Sur","CST Transporte",
    "DATULI","Del Valle","DHL","Don Antonio","Don Gumer","DPD","Duro",
    "Enviopack","EPSA","Erbas","EURO Packaging","Expreso Oro Negro",
    "Failde","FAILE","Flecha Lok","FM Transporte","FRATI","Fravega","FIS Logística",
    "Gabcin","Gentile","Grabet","Grasso","Grupo GLI","Grupo Luro","Grupo Silco","Guevara Fletes",
    "HDL Transporte","HECA","HFL","HIMP A","Hornero",
    "IAFRATELLI","IFLOW","Impresur","Internavegación","INTERMEDIO","Id Group",
    "Joaquin","JM Yaya e Hijos","Juarez",
    "La Sevillanita","La Tablada","LEO Trucks","Lir","Loginter","Logística del Valle","Logística Giménez","Logística Integral Romano","Logística Soria","Logitech","Lomas del Mirador","LTN","Luisito","Lugone","Ludamany",
    "Marra e Hijos","Marino","MARIANO","Maringa","MAV","Meli (Mercado Libre)","MICHELIN (Mantenimiento)","Mirtrans","Moova","Moreiro","Multarys Traslados",
    "Nahuel Remolques","Navarro","NB Cargo","Newsan","Nieva","Norlog","Norte",
    "OCA","OCASA","Oliveri Transporte","Onetrade","Oro Negro","Oriente Elevadores",
    "Pabile","Paganini","PANGEA","Parra","Pavile","PEF","PLK Group","Promei","Provenzano","PYTEL",
    "QX",
    "Ragazzi","Reyna Isabel","Romano","Ruta 21 DPD",
    "Saff","Sainz","SERVINTAR","SERVITRAN","SIARI","Sipe","Spineta","STC","SUMAR Servicio Industrial",
    "Técnica Lift","Techin","TGC Autoelevadores","Thames","Toledo","Transporte del Valle","Transporte Grasso","Transporte Juarez","Transporte Norte","Transporte Trejo","Tronador",
    "Unibrick","Unión Logística","Unitrans","Urbano Logística",
    "Vega","VOLKOV","Vento",
    "Webpack","WBL",
    "Otros"
  ];
  const carrierListJSON = JSON.stringify(carriers);

  res.send(`
    <!DOCTYPE html>
    <html><head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      ${fontLink}
      <title>Garita - Registro de Ingresos/Egresos</title>
      <script src="https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js"></script>
      <style>${styles}
        .grid-3 { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 12px; margin-bottom: 24px; }
        label { display: block; text-align: left; color: ${colors.textMuted}; font-size: 13px; margin-bottom: 4px; margin-top: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; }
        .row-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
        textarea { width: 100%; padding: 12px; border: 2px solid ${colors.border}; border-radius: 12px; font-size: 15px; background: ${colors.bgCard}; color: ${colors.textPrimary}; min-height: 80px; resize: vertical; font-family: 'Montserrat', sans-serif; }
        textarea::placeholder { color: ${colors.textMuted}; }
        textarea:focus { outline: none; border-color: ${colors.primary}; box-shadow: 0 0 0 3px rgba(0,153,168,0.12); }
        .banner-info { background: rgba(0,153,168,0.15); border: 1px solid ${colors.primary}; color: ${colors.primary}; padding: 12px; border-radius: 8px; margin-bottom: 12px; font-size: 14px; }
        .banner-error { background: rgba(239,68,68,0.15); border: 1px solid #ef4444; color: #fca5a5; padding: 12px; border-radius: 8px; margin-bottom: 12px; font-size: 14px; }
        .toast { position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%); background: ${colors.green}; color: white; padding: 14px 28px; border-radius: 12px; font-weight: 600; z-index: 2000; display: none; box-shadow: 0 4px 20px rgba(0,0,0,0.3); }
        .toast.active { display: block; animation: fadeInUp 0.3s ease; }
        @keyframes fadeInUp { from { opacity:0; transform: translateX(-50%) translateY(20px); } to { opacity:1; transform: translateX(-50%) translateY(0); } }
        .guard-header { display: flex; align-items: center; gap: 12px; margin-bottom: 8px; }
        .guard-header .guard-name { font-size: 14px; color: ${colors.primary}; font-weight: 600; }
        .egreso-card { background: rgba(255,255,255,0.08); border-radius: 12px; padding: 16px; margin: 16px 0; border: 1px solid rgba(255,255,255,0.1); }
        .egreso-card .row { display: flex; justify-content: space-between; margin-bottom: 8px; }
        .egreso-card .label { color: ${colors.textMuted}; font-size: 13px; }
        .egreso-card .value { font-weight: 600; font-size: 15px; }
        .hist-table-wrap { overflow-x: auto; -webkit-overflow-scrolling: touch; }
        .hist-table { width: 100%; border-collapse: collapse; font-size: 13px; min-width: 700px; }
        .hist-table th { background: rgba(0,153,168,0.2); color: ${colors.primary}; padding: 10px 8px; text-align: left; font-weight: 600; position: sticky; top: 0; }
        .hist-table td { padding: 10px 8px; border-bottom: 1px solid rgba(255,255,255,0.05); }
        .hist-table tr:hover { background: rgba(255,255,255,0.03); }
        .range-btns { display: flex; gap: 8px; margin-bottom: 12px; }
        .range-btn { padding: 8px 16px; border-radius: 8px; border: 1px solid rgba(255,255,255,0.1); background: rgba(255,255,255,0.05); color: ${colors.light}; cursor: pointer; font-weight: 600; font-size: 13px; }
        .range-btn.active { background: ${colors.primary}; color: white; border-color: ${colors.primary}; }
        .carrier-dropdown { position: relative; }
        .carrier-list { position: absolute; top: 100%; left: 0; right: 0; max-height: 200px; overflow-y: auto; background: ${colors.darkBlue}; border: 1px solid rgba(255,255,255,0.15); border-radius: 0 0 12px 12px; z-index: 100; display: none; }
        .carrier-list.open { display: block; }
        .carrier-item { padding: 12px 16px; cursor: pointer; font-size: 15px; color: ${colors.light}; }
        .carrier-item:hover { background: rgba(0,153,168,0.2); }
        .carrier-item.highlighted { background: rgba(0,153,168,0.15); }
        .seguro-box { background: rgba(0,153,168,0.05); border: 1px solid rgba(0,153,168,0.25); border-radius: 12px; padding: 14px 16px; margin-top: 16px; }
        .seguro-title { margin: 0; font-size: 13px; font-weight: 700; color: ${colors.primary}; text-transform: uppercase; letter-spacing: 0.5px; }
        .seguro-alert { background: #fef2f2; border: 1px solid #dc2626; color: #dc2626; padding: 10px 12px; border-radius: 8px; margin-top: 10px; font-size: 13px; font-weight: 600; }
        .seguro-ok { background: #f0fdf4; border: 1px solid #16a34a; color: #16a34a; padding: 8px 12px; border-radius: 8px; margin-top: 10px; font-size: 12px; font-weight: 600; }
        @media (max-width: 768px) {
          .row-2 { grid-template-columns: 1fr; }
          .grid-3 { grid-template-columns: 1fr 1fr 1fr; gap: 8px; }
          .kpi { padding: 12px; }
          .kpi-value { font-size: 28px; }
        }
        @media (max-width: 500px) {
          .grid-3 { grid-template-columns: 1fr; }
        }
      </style>
    </head><body>
      <div class="container-wide">
        <!-- LOGIN -->
        <div id="login-section">
          <div style="text-align:center; padding-top:60px;">
            <img src="${logoSrc}" alt="OCASA" class="logo-large">
            <div class="icon-circle icon-primary">🛡️</div>
            <h1>Acceso Garita</h1>
            <p class="subtitle">Ingresá tus credenciales</p>
          </div>
          <div class="card" style="max-width:400px; margin:0 auto;">
            <div id="login-error" class="error" style="display:none;"></div>
            <label>EMAIL</label>
            <input type="email" id="login-email" placeholder="guardia@ocasa.com">
            <label>CONTRASEÑA</label>
            <input type="password" id="login-pass" placeholder="Contraseña">
            <button class="btn btn-primary" onclick="doLogin()">Ingresar</button>
          </div>
        </div>

        <!-- PANEL PRINCIPAL (oculto hasta login) -->
        <div id="main-panel" style="display:none;">
          <div class="header">
            <div class="header-left">
              <img src="${logoSrc}" alt="OCASA" class="logo">
              <div>
                <h1>Registro de Garita</h1>
                <div class="guard-header">
                  <span class="guard-name" id="guard-name-display"></span>
                </div>
              </div>
            </div>
            <a href="/interna" style="background:${colors.primaryLight}; border:1px solid ${colors.primary}; color:${colors.primary}; padding:8px 16px; border-radius:8px; font-size:13px; font-weight:600; text-decoration:none; white-space:nowrap;">🔑 Seguridad Interna</a>
          </div>

          <!-- KPIs -->
          <div class="grid-3" id="kpis-garita">
            <div class="kpi"><div class="kpi-value">-</div><div class="kpi-label">En predio</div></div>
            <div class="kpi"><div class="kpi-value">-</div><div class="kpi-label">Ingresos hoy</div></div>
            <div class="kpi"><div class="kpi-value">-</div><div class="kpi-label">Egresos hoy</div></div>
          </div>

          <!-- TABS -->
          <div class="tabs">
            <button class="tab active" onclick="showTab('ingreso', this)">Ingreso</button>
            <button class="tab" onclick="showTab('egreso', this)">Egreso</button>
            <button class="tab" onclick="showTab('historial', this)">Historial</button>
          </div>

          <!-- TAB INGRESO -->
          <div id="tab-ingreso">
            <div class="card">
              <div id="ingreso-banner"></div>
              <div id="ingreso-error" class="error" style="display:none;"></div>

              <label>PATENTE TRACTOR *</label>
              <input type="text" id="ing-truck" placeholder="Ej: AA-123-BB" maxlength="10"
                     style="text-transform:uppercase; font-family:monospace; font-size:22px; text-align:center;"
                     onblur="checkPatente()">

              <label>TRANSPORTISTA *</label>
              <div class="carrier-dropdown">
                <input type="text" id="ing-carrier" placeholder="Escribí para buscar..." autocomplete="off"
                       oninput="filterCarriers()" onfocus="filterCarriers()">
                <div class="carrier-list" id="carrier-list"></div>
              </div>

              <label>NOMBRE Y APELLIDO DEL CHOFER *</label>
              <input type="text" id="ing-chofer" placeholder="Nombre completo">

              <div class="row-2">
                <div>
                  <label>DNI CHOFER</label>
                  <input type="text" id="ing-dni" placeholder="Ej: 12345678" maxlength="10" onblur="buscarLegajoChofer()">
                </div>
                <div>
                  <label>CELULAR</label>
                  <input type="tel" id="ing-celular" placeholder="Ej: 1155554444">
                </div>
              </div>
              <div id="legajo-banner"></div>

              <div class="seguro-box" id="art-box">
                <p class="seguro-title">🦺 ART del chofer</p>
                <div class="row-2">
                  <div><label>EMPRESA ART</label><input type="text" id="ing-art-empresa" placeholder="Ej: Galeno ART"></div>
                  <div><label>N° PÓLIZA</label><input type="text" id="ing-art-poliza" placeholder="Póliza"></div>
                </div>
                <label>VIGENCIA (hasta)</label>
                <input type="date" id="ing-art-vigencia" onchange="checkVigencia('art')">
                <div id="art-alert"></div>
              </div>

              <div class="seguro-box" id="seguro-box">
                <p class="seguro-title">🚗 Seguro del vehículo</p>
                <div class="row-2">
                  <div><label>ASEGURADORA</label><input type="text" id="ing-seguro-empresa" placeholder="Ej: Sancor Seguros"></div>
                  <div><label>N° PÓLIZA</label><input type="text" id="ing-seguro-poliza" placeholder="Póliza"></div>
                </div>
                <label>VIGENCIA (hasta)</label>
                <input type="date" id="ing-seguro-vigencia" onchange="checkVigencia('seguro')">
                <div id="seguro-alert"></div>
              </div>

              <div class="row-2">
                <div>
                  <label>PATENTE SEMI</label>
                  <input type="text" id="ing-semi" placeholder="Semi/Acoplado" style="text-transform:uppercase;" maxlength="10">
                </div>
                <div>
                  <label>N° CONTENEDOR</label>
                  <input type="text" id="ing-contenedor" placeholder="Contenedor">
                </div>
              </div>

              <label>PRECINTO</label>
              <input type="text" id="ing-precinto" placeholder="N° precinto">

              <label>ENTRA VACÍO O CON CARGA *</label>
              <select id="ing-carga">
                <option value="" disabled selected>Seleccioná...</option>
                <option value="VACIO">Vacío</option>
                <option value="CON_CARGA">Con carga</option>
              </select>

              <label>OBSERVACIONES DE INGRESO</label>
              <textarea id="ing-obs" placeholder="Observaciones..."></textarea>

              <button class="btn btn-primary" id="btn-ingreso" onclick="registrarIngreso()">Registrar Ingreso</button>
            </div>
          </div>

          <!-- TAB EGRESO -->
          <div id="tab-egreso" style="display:none;">
            <div class="card">
              <div id="egreso-error" class="error" style="display:none;"></div>

              <label>BUSCAR POR PATENTE</label>
              <div style="display:flex; gap:8px;">
                <input type="text" id="egr-truck" placeholder="Patente del tractor"
                       style="text-transform:uppercase; font-family:monospace; font-size:20px; text-align:center; flex:1;"
                       onkeydown="if(event.key==='Enter')buscarParaEgreso()">
                <button class="btn btn-primary" onclick="buscarParaEgreso()" style="width:auto; margin-top:0; padding:12px 24px;">Buscar</button>
              </div>

              <div id="egreso-result" style="display:none;">
                <div class="egreso-card" id="egreso-info"></div>
                <label>OBSERVACIONES DE EGRESO</label>
                <textarea id="egr-obs" placeholder="Observaciones de salida..."></textarea>
                <button class="btn btn-orange" id="btn-egreso" onclick="confirmarEgreso()">Confirmar Egreso</button>
              </div>
            </div>
          </div>

          <!-- TAB HISTORIAL -->
          <div id="tab-historial" style="display:none;">
            <div class="card">
              <div class="range-btns">
                <button class="range-btn" onclick="loadHistorial(0, this)">Hoy</button>
                <button class="range-btn active" onclick="loadHistorial(7, this)">7 días</button>
                <button class="range-btn" onclick="loadHistorial(30, this)">30 días</button>
              </div>
              <input type="text" id="hist-filter" placeholder="Filtrar por patente..." style="font-size:14px; margin-bottom:12px;"
                     oninput="filterHistorial()">
              <div class="hist-table-wrap">
                <table class="hist-table">
                  <thead>
                    <tr>
                      <th>Fecha</th><th>Patente</th><th>Semi</th><th>Chofer</th>
                      <th>Empresa</th><th>Nave</th><th>Estado</th><th>Obs</th>
                    </tr>
                  </thead>
                  <tbody id="hist-body"></tbody>
                </table>
              </div>
            </div>
          </div>

          <p class="refresh-notice">🔄 Actualizando automáticamente</p>
        </div>
      </div>

      <!-- Toast -->
      <div class="toast" id="toast"></div>

      <!-- Modal QR -->
      <div class="modal-overlay" id="qr-modal" style="display:none; align-items:center; justify-content:center;">
        <div class="modal" style="max-width:360px; text-align:center; padding:32px 24px;">
          <h2 style="margin-bottom:4px;" id="qr-turno-title">Turno registrado</h2>
          <p style="color:${colors.textMuted}; font-size:14px; margin-bottom:20px;">Mostrá este QR al chofer: con él sigue el estado de su turno desde el celular. Recordale que debe entregar las <strong>llaves del camión</strong> en <strong>Seguridad Interna</strong>.</p>
          <div id="qr-container" style="display:flex; justify-content:center; margin-bottom:20px;"></div>
          <p style="font-size:12px; color:${colors.textMuted}; margin-bottom:16px;" id="qr-url-text"></p>
          <a id="qr-wa-btn" href="#" target="_blank" rel="noopener" class="btn" style="background:#25D366; color:#fff; margin-bottom:8px;">📲 Enviar link por WhatsApp</a>
          <p id="qr-wa-hint" style="font-size:12px; color:${colors.textMuted}; margin:0 0 16px 0;"></p>
          <button class="btn btn-primary" onclick="closeQRModal()" style="margin-bottom:8px;">Registrar otro ingreso</button>
          <button class="btn" onclick="printQR()" style="background:${colors.light}; color:${colors.textPrimary};">Imprimir QR</button>
        </div>
      </div>

      <!-- Modal detalle -->
      <div class="modal-overlay" id="modal">
        <div class="modal">
          <div class="modal-header">
            <h2 id="modal-title">Detalle</h2>
            <button class="modal-close" onclick="closeModal()">✕</button>
          </div>
          <div id="modal-content"></div>
        </div>
      </div>

      <script>
        const CARRIERS = ${carrierListJSON};
        let guardNombre = '';
        let guardEmail = '';
        let allTurnos = [];
        let historialData = [];
        let enrichingTurno = null;

        // ===== LOGIN =====
        document.getElementById('login-pass').addEventListener('keydown', e => { if(e.key==='Enter') doLogin(); });

        async function doLogin() {
          const email = document.getElementById('login-email').value.trim();
          const pass = document.getElementById('login-pass').value;
          if (!email || !pass) { showLoginError('Completá email y contraseña'); return; }

          try {
            const res = await fetch('/api/garita/login', {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ email, password: pass })
            });
            const data = await res.json();
            if (!data.success) { showLoginError(data.error); return; }

            guardNombre = data.nombre;
            guardEmail = data.email;
            document.getElementById('guard-name-display').textContent = '🛡️ ' + guardNombre;
            document.getElementById('login-section').style.display = 'none';
            document.getElementById('main-panel').style.display = 'block';
            loadKPIs();
            document.getElementById('ing-truck').focus();
          } catch(e) {
            showLoginError('Error de conexión');
          }
        }

        function showLoginError(msg) {
          const el = document.getElementById('login-error');
          el.textContent = msg; el.style.display = 'block';
          setTimeout(() => el.style.display = 'none', 4000);
        }

        // ===== TABS =====
        function showTab(tab, btn) {
          document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
          if (btn) btn.classList.add('active');
          document.getElementById('tab-ingreso').style.display = tab === 'ingreso' ? 'block' : 'none';
          document.getElementById('tab-egreso').style.display = tab === 'egreso' ? 'block' : 'none';
          document.getElementById('tab-historial').style.display = tab === 'historial' ? 'block' : 'none';
          if (tab === 'historial') loadHistorial(7);
        }

        // ===== KPIs =====
        async function loadKPIs() {
          try {
            const res = await fetch('/api/turnos');
            const data = await res.json();
            allTurnos = data.turnos || [];

            const enPredio = allTurnos.filter(t => t.status !== 'EGRESADO').length;
            const today = new Date().toDateString();
            const ingresosHoy = allTurnos.filter(t => new Date(t.ts_entrada).toDateString() === today).length;
            const egresosHoy = allTurnos.filter(t => t.status === 'EGRESADO' && t.ts_egreso && new Date(t.ts_egreso).toDateString() === today).length;

            document.getElementById('kpis-garita').innerHTML =
              '<div class="kpi"><div class="kpi-value">' + enPredio + '</div><div class="kpi-label">En predio</div></div>' +
              '<div class="kpi"><div class="kpi-value">' + ingresosHoy + '</div><div class="kpi-label">Ingresos hoy</div></div>' +
              '<div class="kpi"><div class="kpi-value">' + egresosHoy + '</div><div class="kpi-label">Egresos hoy</div></div>';
          } catch(e) { console.error(e); }
        }

        // ===== COMBOBOX CARRIERS =====
        let carrierHighlight = -1;

        function filterCarriers() {
          const val = document.getElementById('ing-carrier').value.toLowerCase();
          const list = document.getElementById('carrier-list');
          const filtered = CARRIERS.filter(c => c.toLowerCase().includes(val));
          carrierHighlight = -1;

          if (filtered.length === 0 || !val) { list.classList.remove('open'); return; }

          list.innerHTML = filtered.map(c =>
            '<div class="carrier-item" onclick="selectCarrier(\\'' + c.replace(/'/g, "\\\\'") + '\\')">' + c + '</div>'
          ).join('');
          list.classList.add('open');
        }

        function selectCarrier(name) {
          document.getElementById('ing-carrier').value = name;
          document.getElementById('carrier-list').classList.remove('open');
        }

        document.addEventListener('click', e => {
          if (!e.target.closest('.carrier-dropdown')) {
            document.getElementById('carrier-list').classList.remove('open');
          }
        });

        document.getElementById('ing-carrier').addEventListener('keydown', e => {
          const list = document.getElementById('carrier-list');
          const items = list.querySelectorAll('.carrier-item');
          if (!list.classList.contains('open') || items.length === 0) return;

          if (e.key === 'ArrowDown') { e.preventDefault(); carrierHighlight = Math.min(carrierHighlight + 1, items.length - 1); updateCarrierHighlight(items); }
          else if (e.key === 'ArrowUp') { e.preventDefault(); carrierHighlight = Math.max(carrierHighlight - 1, 0); updateCarrierHighlight(items); }
          else if (e.key === 'Enter' && carrierHighlight >= 0) { e.preventDefault(); items[carrierHighlight].click(); }
        });

        function updateCarrierHighlight(items) {
          items.forEach((it, i) => it.classList.toggle('highlighted', i === carrierHighlight));
          if (items[carrierHighlight]) items[carrierHighlight].scrollIntoView({ block: 'nearest' });
        }

        // ===== CHECK PATENTE (auto-check on blur) =====
        async function checkPatente() {
          const truck = document.getElementById('ing-truck').value.trim().toUpperCase();
          const banner = document.getElementById('ingreso-banner');
          enrichingTurno = null;
          banner.innerHTML = '';

          if (!truck || truck.length < 3) return;

          try {
            const dupRes = await fetch('/api/garita/check-duplicado/' + encodeURIComponent(truck));
            const dupData = await dupRes.json();

            if (dupData.exists) {
              const turno = dupData.turnos[0];
              if ((dupData.registrado_por || 'driver') === 'driver') {
                enrichingTurno = turno;
                banner.innerHTML = '<div class="banner-info">ℹ️ Vehículo pre-registrado por el chofer (turno ' + turno.turno_id + '), completá los datos</div>';
                if (turno.carrier) document.getElementById('ing-carrier').value = turno.carrier;
              } else {
                banner.innerHTML = '<div class="banner-error">⚠️ Vehículo ya registrado en predio</div>';
              }
            }
          } catch(e) { console.error(e); banner.innerHTML = ''; }
        }

        // ===== LEGAJO DE CHOFER (ART + seguro del vehículo, por DNI) =====
        async function buscarLegajoChofer() {
          const dni = document.getElementById('ing-dni').value.trim();
          const banner = document.getElementById('legajo-banner');
          banner.innerHTML = '';

          if (dni && dni.length >= 6) {
            try {
              const res = await fetch('/api/choferes/' + encodeURIComponent(dni));
              const data = await res.json();
              if (data.found) {
                const c = data.chofer;
                document.getElementById('ing-art-empresa').value = c.art_empresa || '';
                document.getElementById('ing-art-poliza').value = c.art_poliza || '';
                document.getElementById('ing-art-vigencia').value = c.art_vigencia || '';
                document.getElementById('ing-seguro-empresa').value = c.seguro_empresa || '';
                document.getElementById('ing-seguro-poliza').value = c.seguro_poliza || '';
                document.getElementById('ing-seguro-vigencia').value = c.seguro_vigencia || '';
                banner.innerHTML = '<div class="banner-info">📋 Legajo encontrado — se cargaron ART y seguro registrados para este DNI. Revisá las vigencias.</div>';
              }
            } catch(e) { console.error(e); }
          }
          checkVigencia('art');
          checkVigencia('seguro');
        }

        // Pinta en vivo si una vigencia (ART o seguro) está vencida; devuelve true si está OK
        function checkVigencia(tipo) {
          const input = document.getElementById('ing-' + tipo + '-vigencia');
          const alertEl = document.getElementById(tipo + '-alert');
          const val = input.value;
          const label = tipo === 'art' ? 'La ART del chofer' : 'El seguro del vehículo';
          if (!val) { alertEl.innerHTML = ''; return true; }
          const hoy = new Date().toISOString().slice(0,10);
          if (val < hoy) {
            alertEl.innerHTML = '<div class="seguro-alert">🚫 ' + label + ' está VENCIDO/A (venció el ' + val + '). Actualizá la fecha para poder registrar el ingreso.</div>';
            return false;
          }
          alertEl.innerHTML = '<div class="seguro-ok">✅ Vigente hasta ' + val + '</div>';
          return true;
        }

        // ===== REGISTRAR INGRESO =====
        async function registrarIngreso() {
          const truck = document.getElementById('ing-truck').value.trim().toUpperCase();
          const carrier = document.getElementById('ing-carrier').value.trim();
          const chofer = document.getElementById('ing-chofer').value.trim();
          const carga_estado = document.getElementById('ing-carga').value;

          if (!truck || !carrier || !chofer) {
            showIngresoError('Completá patente, transportista y nombre del chofer');
            return;
          }
          if (!carga_estado) {
            showIngresoError('Indicá si el camión entra vacío o con carga');
            return;
          }
          const artOk = checkVigencia('art');
          const seguroOk = checkVigencia('seguro');
          if (!artOk || !seguroOk) {
            showIngresoError('No se puede registrar el ingreso: hay un seguro vencido. Actualizá la vigencia arriba.');
            return;
          }

          const btn = document.getElementById('btn-ingreso');
          btn.disabled = true; btn.textContent = '⏳ Procesando...';

          try {
            const res = await fetch('/api/garita/entrada', {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                truck,
                carrier,
                chofer,
                dni_chofer: document.getElementById('ing-dni').value.trim(),
                celular_chofer: document.getElementById('ing-celular').value.trim(),
                patente_semi: document.getElementById('ing-semi').value.trim().toUpperCase(),
                contenedor: document.getElementById('ing-contenedor').value.trim(),
                precinto: document.getElementById('ing-precinto').value.trim(),
                obs_ingreso: document.getElementById('ing-obs').value.trim(),
                carga_estado,
                art_empresa: document.getElementById('ing-art-empresa').value.trim(),
                art_poliza: document.getElementById('ing-art-poliza').value.trim(),
                art_vigencia: document.getElementById('ing-art-vigencia').value,
                seguro_empresa: document.getElementById('ing-seguro-empresa').value.trim(),
                seguro_poliza: document.getElementById('ing-seguro-poliza').value.trim(),
                seguro_vigencia: document.getElementById('ing-seguro-vigencia').value
              })
            });
            const data = await res.json();

            if (!data.success) { showIngresoError(data.error); return; }

            const celForWa = document.getElementById('ing-celular').value.trim();
            resetIngresoForm();
            loadKPIs();
            showQRModal(data.turno_id, celForWa);
          } catch(e) {
            showIngresoError('Error de conexión');
          } finally {
            btn.disabled = false; btn.textContent = 'Registrar Ingreso';
          }
        }

        // ===== MODAL QR =====
        function showQRModal(turnoId, celular) {
          const url = window.location.origin + '/turno/' + turnoId;
          document.getElementById('qr-turno-title').textContent = 'Turno ' + turnoId;
          document.getElementById('qr-url-text').textContent = url;
          const container = document.getElementById('qr-container');
          container.innerHTML = '';
          new QRCode(container, { text: url, width: 220, height: 220, correctLevel: QRCode.CorrectLevel.M });

          // Botón WhatsApp: si hay celular, abre el chat de ese número; si no, abre el selector de contacto
          const msg = 'OCASA Tortuguitas - Seguí el estado de tu turno ' + turnoId + ' acá: ' + url;
          let digits = (celular || '').replace(/\\D/g, '');
          const waBtn = document.getElementById('qr-wa-btn');
          const waHint = document.getElementById('qr-wa-hint');
          if (digits) {
            if (!digits.startsWith('54')) digits = '549' + digits.replace(/^0/, '').replace(/^15/, '');
            waBtn.href = 'https://wa.me/' + digits + '?text=' + encodeURIComponent(msg);
            waHint.textContent = 'Se enviará al ' + (celular || '');
          } else {
            waBtn.href = 'https://wa.me/?text=' + encodeURIComponent(msg);
            waHint.textContent = 'Sin celular cargado: se abrirá WhatsApp para elegir el contacto.';
          }

          const modal = document.getElementById('qr-modal');
          modal.style.display = 'flex';
        }

        function closeQRModal() {
          document.getElementById('qr-modal').style.display = 'none';
          document.getElementById('ing-truck').focus();
        }

        function printQR() {
          const url = document.getElementById('qr-url-text').textContent;
          const title = document.getElementById('qr-turno-title').textContent;
          const qrImg = document.querySelector('#qr-container img');
          if (!qrImg) return;
          const win = window.open('', '_blank');
          win.document.write('<html><body style="text-align:center;font-family:sans-serif;padding:40px;">' +
            '<h2>' + title + '</h2><img src="' + qrImg.src + '" style="width:220px;height:220px;"><br>' +
            '<p style="font-size:12px;color:#666;">' + url + '</p>' +
            '<p style="font-size:13px;">Escaneá para seguir tu turno en OCASA</p></body></html>');
          win.document.close();
          win.print();
        }

        function showIngresoError(msg) {
          const el = document.getElementById('ingreso-error');
          el.textContent = msg; el.style.display = 'block';
          setTimeout(() => el.style.display = 'none', 5000);
        }

        function resetIngresoForm() {
          ['ing-truck','ing-carrier','ing-chofer','ing-dni','ing-celular','ing-semi','ing-contenedor','ing-precinto',
           'ing-art-empresa','ing-art-poliza','ing-art-vigencia','ing-seguro-empresa','ing-seguro-poliza','ing-seguro-vigencia'].forEach(id => {
            document.getElementById(id).value = '';
          });
          document.getElementById('ing-carga').value = '';
          document.getElementById('ing-obs').value = '';
          document.getElementById('ingreso-banner').innerHTML = '';
          document.getElementById('legajo-banner').innerHTML = '';
          document.getElementById('art-alert').innerHTML = '';
          document.getElementById('seguro-alert').innerHTML = '';
          enrichingTurno = null;
        }

        // ===== BUSCAR PARA EGRESO =====
        let egresoTurno = null;

        async function buscarParaEgreso() {
          const truck = document.getElementById('egr-truck').value.trim().toUpperCase();
          if (!truck) return;

          const errorEl = document.getElementById('egreso-error');
          const resultEl = document.getElementById('egreso-result');
          errorEl.style.display = 'none';
          resultEl.style.display = 'none';
          egresoTurno = null;

          try {
            const res = await fetch('/api/garita/check-duplicado/' + encodeURIComponent(truck));
            const data = await res.json();

            if (!data.exists) {
              errorEl.textContent = 'No se encontró vehículo activo con patente ' + truck;
              errorEl.style.display = 'block';
              return;
            }

            const t = data.turnos[0];
            egresoTurno = t;

            const tiempoMs = Date.now() - new Date(t.ts_entrada).getTime();
            const hrs = Math.floor(tiempoMs / 3600000);
            const mins = Math.floor((tiempoMs % 3600000) / 60000);
            const tiempoStr = hrs > 0 ? hrs + 'h ' + mins + 'm' : mins + ' min';

            // Alerta llaves: algún turno de esta patente con llaves entregadas y no retiradas
            const debeLlaves = (data.turnos || []).some(x => x.llaves_recibidas && !x.llaves_devueltas);
            let alertaLlaves = '';
            if (debeLlaves) {
              alertaLlaves =
                '<div style="background:#fef2f2; border:2px solid #dc2626; color:#991b1b; padding:14px 16px; border-radius:10px; margin-bottom:12px; font-weight:600;">' +
                '🔑 El chofer debe RETIRAR LAS LLAVES en Seguridad Interna antes de salir' +
                '</div>';
            }

            // Estado de llaves: agregado contra todos los turnos de la patente
            let llavesTexto = '⏳ Sin entregar';
            let llavesColor = '${colors.textMuted}';
            const algunaRecibida = (data.turnos || []).some(x => x.llaves_recibidas);
            if (algunaRecibida) {
              if (debeLlaves) {
                llavesTexto = '⚠️ Entregadas — NO retiradas';
                llavesColor = '#dc2626';
              } else {
                llavesTexto = '✅ Entregadas y retiradas';
                llavesColor = '#16a34a';
              }
            }

            document.getElementById('egreso-info').innerHTML = alertaLlaves +
              '<div class="row"><span class="label">Patente</span><span class="value">' + t.truck + '</span></div>' +
              '<div class="row"><span class="label">Transportista</span><span class="value">' + (t.carrier || '-') + '</span></div>' +
              '<div class="row"><span class="label">Chofer</span><span class="value">' + (t.chofer || '-') + '</span></div>' +
              '<div class="row"><span class="label">Tiempo en predio</span><span class="value">' + tiempoStr + '</span></div>' +
              '<div class="row"><span class="label">Estado actual</span><span class="value">' + getStatusBadge(t.status) + '</span></div>' +
              '<div class="row"><span class="label">Ingreso</span><span class="value">' + formatDateTime(t.ts_entrada) + '</span></div>' +
              '<div class="row"><span class="label">Llaves</span><span class="value" style="color:' + llavesColor + '; font-weight:600;">' + llavesTexto + '</span></div>';

            resultEl.style.display = 'block';
          } catch(e) {
            errorEl.textContent = 'Error de conexión';
            errorEl.style.display = 'block';
          }
        }

        async function confirmarEgreso() {
          if (!egresoTurno) return;

          const btn = document.getElementById('btn-egreso');
          btn.disabled = true; btn.textContent = '⏳ Procesando...';

          try {
            const res = await fetch('/api/garita/salida', {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                truck: egresoTurno.truck,
                obs_egreso: document.getElementById('egr-obs').value.trim()
              })
            });
            const data = await res.json();

            if (!data.success) {
              const errEl = document.getElementById('egreso-error');
              if (data.blocked === 'llaves') {
                errEl.textContent = '🔑 ' + (data.error || 'El chofer debe RETIRAR LAS LLAVES en Seguridad Interna antes de salir');
              } else {
                errEl.textContent = data.error;
              }
              errEl.style.display = 'block';
              return;
            }

            const turno = data.turno;
            const tiempoMs = new Date(turno.ts_egreso).getTime() - new Date(turno.ts_entrada).getTime();
            const hrs = Math.floor(tiempoMs / 3600000);
            const mins = Math.floor((tiempoMs % 3600000) / 60000);
            showToast('✅ Egreso confirmado — ' + turno.truck + ' (' + (hrs > 0 ? hrs + 'h ' : '') + mins + 'm en predio)');

            document.getElementById('egr-truck').value = '';
            document.getElementById('egr-obs').value = '';
            document.getElementById('egreso-result').style.display = 'none';
            egresoTurno = null;
            loadKPIs();
          } catch(e) {
            document.getElementById('egreso-error').textContent = 'Error de conexión';
            document.getElementById('egreso-error').style.display = 'block';
          } finally {
            btn.disabled = false; btn.textContent = 'Confirmar Egreso';
          }
        }

        // ===== HISTORIAL =====
        let currentDays = 7;

        async function loadHistorial(days, btn) {
          if (days !== undefined) currentDays = days;
          if (btn) {
            document.querySelectorAll('.range-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
          }

          const d = currentDays === 0 ? 1 : currentDays;
          try {
            const res = await fetch('/api/garita/historial?days=' + d);
            const data = await res.json();
            historialData = data.turnos || [];

            if (currentDays === 0) {
              const today = new Date().toDateString();
              historialData = historialData.filter(t => new Date(t.ts_entrada).toDateString() === today);
            }

            renderHistorial();
          } catch(e) { console.error(e); }
        }

        function filterHistorial() {
          renderHistorial();
        }

        function renderHistorial() {
          const filter = (document.getElementById('hist-filter').value || '').toUpperCase();
          let filtered = historialData;
          if (filter) filtered = filtered.filter(t => t.truck.toUpperCase().includes(filter));

          const tbody = document.getElementById('hist-body');
          if (filtered.length === 0) {
            tbody.innerHTML = '<tr><td colspan="8" style="text-align:center; opacity:0.5; padding:24px;">Sin registros</td></tr>';
            return;
          }

          tbody.innerHTML = filtered.map(t =>
            '<tr onclick="showDetail(\\'' + t.turno_id + '\\')" style="cursor:pointer;">' +
            '<td>' + formatDateTime(t.ts_entrada) + '</td>' +
            '<td style="font-weight:600;">' + t.truck + '</td>' +
            '<td>' + (t.patente_semi || '-') + '</td>' +
            '<td>' + (t.chofer || '-') + '</td>' +
            '<td>' + (t.carrier || '-') + '</td>' +
            '<td>' + (t.warehouse || '-') + '</td>' +
            '<td>' + getStatusBadge(t.status) + '</td>' +
            '<td>' + (t.obs_ingreso || '-') + '</td></tr>'
          ).join('');
        }

        // ===== MODAL DETALLE (reutilizado de /garita) =====
        function showDetail(turnoId) {
          const t = (historialData.length > 0 ? historialData : allTurnos).find(x => x.turno_id === turnoId);
          if (!t) return;

          document.getElementById('modal-title').textContent = t.truck + ' — ' + (t.carrier || '');

          let html = '<div style="margin-bottom:16px;">';
          if (t.chofer) html += '<div class="row" style="display:flex; justify-content:space-between; margin-bottom:6px;"><span style="opacity:0.6;">Chofer</span><span style="font-weight:600;">' + t.chofer + '</span></div>';
          if (t.carga_estado) html += '<div class="row" style="display:flex; justify-content:space-between; margin-bottom:6px;"><span style="opacity:0.6;">Carga</span><span>' + (t.carga_estado === 'CON_CARGA' ? 'Con carga' : 'Vacío') + '</span></div>';
          if (t.dni_chofer) html += '<div class="row" style="display:flex; justify-content:space-between; margin-bottom:6px;"><span style="opacity:0.6;">DNI</span><span>' + t.dni_chofer + '</span></div>';
          if (t.celular_chofer) html += '<div class="row" style="display:flex; justify-content:space-between; margin-bottom:6px;"><span style="opacity:0.6;">Celular</span><span>' + t.celular_chofer + '</span></div>';
          if (t.patente_semi) html += '<div class="row" style="display:flex; justify-content:space-between; margin-bottom:6px;"><span style="opacity:0.6;">Semi</span><span>' + t.patente_semi + '</span></div>';
          if (t.contenedor) html += '<div class="row" style="display:flex; justify-content:space-between; margin-bottom:6px;"><span style="opacity:0.6;">Contenedor</span><span>' + t.contenedor + '</span></div>';
          if (t.precinto) html += '<div class="row" style="display:flex; justify-content:space-between; margin-bottom:6px;"><span style="opacity:0.6;">Precinto</span><span>' + t.precinto + '</span></div>';
          html += '</div>';

          html += '<div class="timeline">';
          html += renderTimelineItem(t.ts_entrada, 'Ingreso al predio');
          html += renderTimelineItem(t.ts_asignacion, 'Dársena asignada' + (t.dock ? ': ' + t.dock : ''));
          html += renderTimelineItem(t.ts_atracado, 'Atracado');
          html += renderTimelineItem(t.ts_llaves_entrega, 'Entregó llaves');
          html += renderTimelineItem(t.ts_llaves_retiro, 'Retiró llaves');
          html += renderTimelineItem(t.ts_desatracado, 'Desatracado');
          html += renderTimelineItem(t.ts_egreso, 'Egreso');
          html += '</div>';

          if (t.obs_ingreso) html += '<div style="margin-top:12px; padding:10px; background:rgba(255,255,255,0.05); border-radius:8px; font-size:13px;"><strong>Obs. Ingreso:</strong> ' + t.obs_ingreso + '</div>';
          if (t.obs_egreso) html += '<div style="margin-top:8px; padding:10px; background:rgba(255,255,255,0.05); border-radius:8px; font-size:13px;"><strong>Obs. Egreso:</strong> ' + t.obs_egreso + '</div>';

          document.getElementById('modal-content').innerHTML = html;
          document.getElementById('modal').classList.add('active');
        }

        function renderTimelineItem(ts, text) {
          const done = ts ? 'done' : '';
          return '<div class="timeline-item ' + done + '">' +
            '<div class="timeline-time">' + formatDateTime(ts) + '</div>' +
            '<div class="timeline-text">' + text + '</div></div>';
        }

        function closeModal() { document.getElementById('modal').classList.remove('active'); }

        document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });
        document.getElementById('modal').addEventListener('click', e => { if (e.target === document.getElementById('modal')) closeModal(); });

        // ===== UTILS =====
        function getStatusBadge(status) {
          const badges = {
            'ESPERANDO_ASIGNACION': '<span class="badge badge-yellow">Esperando</span>',
            'DARSENA_ASIGNADA': '<span class="badge badge-primary">Asignada</span>',
            'ATRACADO': '<span class="badge badge-green">Atracado</span>',
            'DESATRACADO': '<span class="badge badge-orange">Desatracado</span>',
            'EGRESADO': '<span class="badge badge-dark">Egresado</span>'
          };
          return badges[status] || status;
        }

        function formatTime(ts) {
          if (!ts) return '--:--';
          return new Date(ts).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' });
        }

        function formatDateTime(ts) {
          if (!ts) return '--:--';
          return new Date(ts).toLocaleString('es-AR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
        }

        function showToast(msg) {
          const toast = document.getElementById('toast');
          toast.textContent = msg;
          toast.classList.add('active');
          setTimeout(() => toast.classList.remove('active'), 4000);
        }

        // ===== AUTO-REFRESH =====
        setInterval(loadKPIs, 10000);
      </script>
    </body></html>
  `);
});

// ==================== PÁGINA SEGURIDAD INTERNA (LLAVES) ====================
app.get('/interna', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html><head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      ${fontLink}
      <title>Seguridad Interna - Llaves</title>
      <style>${styles}
        label { display: block; text-align: left; color: ${colors.textMuted}; font-size: 13px; margin-bottom: 4px; margin-top: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; }
        .ki-card { background: ${colors.bgCard}; border: 1px solid ${colors.border}; border-radius: 12px; padding: 16px; margin-bottom: 12px; box-shadow: 0 1px 2px ${colors.shadow}; }
        .ki-card h3 { margin: 0 0 4px 0; font-size: 16px; font-weight: 700; }
        .ki-card p { margin: 0; font-size: 13px; color: ${colors.textSecondary}; }
        .ki-row { display: flex; gap: 8px; margin-top: 12px; flex-wrap: wrap; }
        .ki-row select { flex: 1; min-width: 120px; margin: 0; }
        .ki-row button { flex: 0 0 auto; width: auto; margin: 0; padding: 12px 18px; white-space: nowrap; }
        .ki-empty { text-align: center; padding: 32px 16px; color: ${colors.textMuted}; font-size: 14px; }
        @media (max-width: 600px) { .grid-3 { grid-template-columns: 1fr; } .ki-row { flex-direction: column; } .ki-row button { width: 100%; } }
      </style>
    </head><body>
      <div class="container">
        <!-- LOGIN -->
        <div id="login-section">
          <div style="text-align:center; padding-top:60px;">
            <img src="${logoSrc}" alt="OCASA" class="logo-large">
            <div class="icon-circle icon-primary">🔑</div>
            <h1>Seguridad Interna</h1>
            <p class="subtitle">Gestión de llaves — Tortuguitas</p>
          </div>
          <div class="card">
            <div id="login-error" class="error" style="display:none;"></div>
            <label>EMAIL</label>
            <input type="email" id="login-email" placeholder="interna@ocasa.com">
            <label>CONTRASEÑA</label>
            <input type="password" id="login-pass" placeholder="Contraseña">
            <button class="btn btn-primary" onclick="doLogin()">Ingresar</button>
          </div>
        </div>

        <!-- PANEL -->
        <div id="main-panel" style="display:none;">
          <div class="header">
            <div class="header-left">
              <img src="${logoSrc}" alt="OCASA" class="logo">
              <div>
                <h1 style="font-size:20px;">Seguridad Interna</h1>
                <p class="subtitle" style="margin:0; font-size:13px;">Gestión de llaves — Tortuguitas</p>
              </div>
            </div>
            <button onclick="logout()" style="background:${colors.light}; border:1px solid ${colors.border}; color:${colors.textSecondary}; padding:8px 16px; border-radius:8px; font-family:'Montserrat',sans-serif; font-size:13px; font-weight:600; cursor:pointer; white-space:nowrap;">Salir</button>
          </div>

          <div class="grid-3" id="kpis">
            <div class="kpi"><div class="kpi-value">-</div><div class="kpi-label">Pendientes de entregar llaves</div></div>
            <div class="kpi"><div class="kpi-value">-</div><div class="kpi-label">En nave / llaves entregadas</div></div>
            <div class="kpi"><div class="kpi-value">-</div><div class="kpi-label">Pendientes de retirar llaves</div></div>
          </div>

          <div class="tabs">
            <button class="tab active" id="tabbtn-entrega" onclick="showTab('entrega')">Entrega de llaves</button>
            <button class="tab" id="tabbtn-devolucion" onclick="showTab('devolucion')">Devolución de llaves</button>
          </div>

          <div id="tab-entrega"></div>
          <div id="tab-devolucion" style="display:none;"></div>

          <p class="refresh-notice">🔄 Actualizando automáticamente cada 5 segundos</p>
        </div>
      </div>

      <div class="toast" id="toast"></div>

      <script>
        const NAVES = ['Nave 1','Nave 2','Nave 3'];
        let allTurnos = [];
        let currentTab = 'entrega';

        // ===== LOGIN =====
        const savedUser = localStorage.getItem('interna_user');
        if (savedUser) {
          try { const u = JSON.parse(savedUser); enterPanel(u); } catch(e) { localStorage.removeItem('interna_user'); }
        }

        document.getElementById('login-pass').addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });

        async function doLogin() {
          const email = document.getElementById('login-email').value.trim();
          const password = document.getElementById('login-pass').value;
          if (!email || !password) { showLoginError('Completá email y contraseña'); return; }
          try {
            const res = await fetch('/api/interna/login', {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ email, password })
            });
            const data = await res.json();
            if (!data.success) { showLoginError(data.error || 'Credenciales inválidas'); return; }
            const u = { nombre: data.nombre, email: data.email };
            localStorage.setItem('interna_user', JSON.stringify(u));
            enterPanel(u);
          } catch(e) { showLoginError('Error de conexión'); }
        }

        function enterPanel(u) {
          document.getElementById('login-section').style.display = 'none';
          document.getElementById('main-panel').style.display = 'block';
          loadData();
        }

        function logout() {
          localStorage.removeItem('interna_user');
          document.getElementById('main-panel').style.display = 'none';
          document.getElementById('login-section').style.display = 'block';
        }

        function showLoginError(msg) {
          const el = document.getElementById('login-error');
          el.textContent = msg; el.style.display = 'block';
          setTimeout(() => el.style.display = 'none', 4000);
        }

        // ===== TABS =====
        function showTab(tab) {
          currentTab = tab;
          document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
          document.getElementById('tabbtn-' + tab).classList.add('active');
          document.getElementById('tab-entrega').style.display = tab === 'entrega' ? 'block' : 'none';
          document.getElementById('tab-devolucion').style.display = tab === 'devolucion' ? 'block' : 'none';
        }

        // ===== DATA =====
        async function loadData() {
          if (document.getElementById('main-panel').style.display === 'none') return;
          try {
            const res = await fetch('/api/turnos');
            const data = await res.json();
            allTurnos = data.turnos || [];
            render();
          } catch(e) { console.error(e); }
        }

        function pendientesEntrega() {
          return allTurnos.filter(t => t.status === 'ATRACADO' && !t.llaves_recibidas);
        }
        function enNave() {
          return allTurnos.filter(t => t.llaves_recibidas && !t.llaves_devueltas && t.status !== 'EGRESADO');
        }
        function pendientesDevolucion() {
          return allTurnos.filter(t => t.status === 'ATRACADO' && t.llaves_recibidas && !t.llaves_devueltas);
        }

        function render() {
          const ent = pendientesEntrega();
          const nave = enNave();
          const dev = pendientesDevolucion();

          document.getElementById('kpis').innerHTML =
            '<div class="kpi"><div class="kpi-value" style="color:#d97706;">' + ent.length + '</div><div class="kpi-label">Pendientes de entregar llaves</div></div>' +
            '<div class="kpi"><div class="kpi-value">' + nave.length + '</div><div class="kpi-label">En nave / llaves entregadas</div></div>' +
            '<div class="kpi"><div class="kpi-value" style="color:${colors.primary};">' + dev.length + '</div><div class="kpi-label">Pendientes de retirar llaves</div></div>';

          // Tab entrega
          let he = '';
          if (ent.length === 0) {
            he = '<div class="ki-empty">No hay camiones esperando entregar llaves</div>';
          } else {
            ent.forEach(t => {
              he += '<div class="ki-card">';
              he += '<h3>' + t.truck + '</h3>';
              he += '<p>' + (t.carrier || 'Sin transportista') + (t.chofer ? ' · ' + t.chofer : '') + '</p>';
              he += '<p style="margin:6px 0; font-weight:700; color:${colors.primary};">📍 ' + (t.warehouse || '') + ' · Dársena ' + (t.dock || '-') + '</p>';
              he += '<div class="ki-row">';
              he += '<select id="op-' + t.turno_id + '"><option value="Descarga"' + (t.operation === 'Descarga' ? ' selected' : '') + '>Descarga</option><option value="Carga"' + (t.operation === 'Carga' ? ' selected' : '') + '>Carga</option></select>';
              he += '</div>';
              he += '<button class="btn btn-primary" style="margin-top:10px;" onclick="entregar(\\'' + t.turno_id + '\\')">Registrar entrega de llaves</button>';
              he += '</div>';
            });
          }
          document.getElementById('tab-entrega').innerHTML = he;

          // Tab devolución
          let hd = '';
          if (dev.length === 0) {
            hd = '<div class="ki-empty">No hay camiones para retirar llaves</div>';
          } else {
            dev.forEach(t => {
              hd += '<div class="ki-card">';
              hd += '<h3>' + t.truck + '</h3>';
              hd += '<p>' + (t.carrier || 'Sin transportista') + (t.chofer ? ' · ' + t.chofer : '') + ' · ' + (t.warehouse || 'Sin nave') + '</p>';
              hd += '<button class="btn btn-green" style="margin-top:10px;" onclick="devolver(\\'' + t.turno_id + '\\')">Confirmar retiro de llaves</button>';
              hd += '</div>';
            });
          }
          document.getElementById('tab-devolucion').innerHTML = hd;
        }

        async function entregar(turnoId) {
          const operation = document.getElementById('op-' + turnoId).value;
          try {
            const res = await fetch('/api/interna/entrega', {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ turnoId, operation })
            });
            const data = await res.json();
            if (data.success) {
              showToast('🔑 Llaves registradas');
              loadData();
            } else {
              showToast(data.error || 'No se pudo registrar', true);
            }
          } catch(e) { showToast('Error de conexión', true); }
        }

        async function devolver(turnoId) {
          try {
            const res = await fetch('/api/interna/devolucion', {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ turnoId })
            });
            const data = await res.json();
            if (data.success) {
              showToast('✅ Llaves retiradas');
              loadData();
            } else {
              showToast(data.error || 'No se pudo registrar', true);
            }
          } catch(e) { showToast('Error de conexión', true); }
        }

        function showToast(msg, isError) {
          const toast = document.getElementById('toast');
          toast.textContent = msg;
          toast.style.background = isError ? '#dc2626' : '${colors.green}';
          toast.classList.add('active');
          setTimeout(() => toast.classList.remove('active'), 4000);
        }

        setInterval(loadData, 5000);
      </script>
    </body></html>
  `);
});

// ==================== QR DE DÁRSENAS (para imprimir y pegar en cada muelle) ====================
app.get('/qr-darsenas', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html><head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      ${fontLink}
      <title>QR de Dársenas - OCASA Tortuguitas</title>
      <style>
        ${styles}
        .qr-toolbar { display:flex; align-items:center; gap:12px; flex-wrap:wrap; margin-bottom:20px; }
        .nave-block { margin-bottom: 28px; }
        .nave-block h2 { margin: 0 0 12px 0; }
        .qr-grid { display:grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap:14px; }
        .qr-item {
          border:1px solid ${colors.border}; border-radius:12px; padding:16px; text-align:center;
          background:#fff; box-shadow:0 1px 2px ${colors.shadow}; break-inside:avoid;
        }
        .qr-item .qr-box { display:flex; justify-content:center; margin-bottom:10px; }
        .qr-item .dock-name { font-size:20px; font-weight:700; color:${colors.textPrimary}; }
        .qr-item .dock-sub { font-size:12px; color:${colors.textMuted}; margin-top:2px; }
        @media print {
          .qr-toolbar, .logo, .no-print { display:none !important; }
          body { background:#fff; }
          .container-wide { padding:0; max-width:none; }
          .qr-item { border:1px solid #ccc; box-shadow:none; }
          .nave-block { page-break-inside:auto; }
        }
      </style>
    </head><body>
      <div class="container-wide">
        <div style="text-align:center;"><img src="${logoSrc}" alt="OCASA" class="logo"></div>
        <h1 class="no-print">QR de Dársenas</h1>
        <p class="subtitle no-print">Imprimí esta hoja y pegá cada QR en su muelle. Al escanearlo se abre la pantalla de atraque/desatraque de esa dársena.</p>
        <div class="qr-toolbar">
          <button class="btn btn-primary" style="width:auto;" onclick="window.print()">🖨️ Imprimir</button>
          <a class="btn" style="width:auto; background:${colors.light}; color:${colors.textPrimary};" href="/operador">← Volver al panel</a>
        </div>
        <div id="content"></div>
      </div>

      <script src="https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js"></script>
      <script>
        const NAVE_DOCKS = { 'Nave 1': [1, 8], 'Nave 2': [1, 30], 'Nave 3': [7, 15] }; // [desde, hasta] por nave
        const NAVE_PREFIX = { 'Nave 1': 'N1', 'Nave 2': 'N2', 'Nave 3': 'N3' };
        const origin = window.location.origin;
        const content = document.getElementById('content');

        Object.keys(NAVE_DOCKS).forEach(nave => {
          const block = document.createElement('div');
          block.className = 'nave-block';
          block.innerHTML = '<h2>🏭 ' + nave + '</h2>';
          const grid = document.createElement('div');
          grid.className = 'qr-grid';
          for (let i = NAVE_DOCKS[nave][0]; i <= NAVE_DOCKS[nave][1]; i++) {
            const id = NAVE_PREFIX[nave] + '-' + String(i).padStart(2, '0');
            const url = origin + '/dock/' + id;
            const item = document.createElement('div');
            item.className = 'qr-item';
            const box = document.createElement('div');
            box.className = 'qr-box';
            item.appendChild(box);
            const name = document.createElement('div');
            name.className = 'dock-name';
            name.textContent = id;
            item.appendChild(name);
            const sub = document.createElement('div');
            sub.className = 'dock-sub';
            sub.textContent = nave;
            item.appendChild(sub);
            grid.appendChild(item);
            new QRCode(box, { text: url, width: 150, height: 150, correctLevel: QRCode.CorrectLevel.M });
          }
          block.appendChild(grid);
          content.appendChild(block);
        });
      </script>
    </body></html>
  `);
});

// ==================== PÁGINA ADMIN (OCULTA) ====================
app.get('/admin', (req, res) => {
  const carriers = [
    "Acaricia Transporte Logan","Adrian Servicio","Alfa Omega","Americantec","Andesmar","Andreani","Apicol","ASPELEYTER","Avaltrans","AYG Trucks",
    "Bahia SRL","Balboa","Bataglia","Beira Mar","Bessone","Better Catering","Biopak","BL Puerto y Logística","Blanca Luna","Brouclean","Bulonera Central","Bulonera Pacheco",
    "Camila Duarte","Cantarini","CASA Thames","CBC Group","CFA Fumigación","Ciari","Cimes","CISA","CLSA","Comercial Ñandubay","Container Leasing","CORREO Urbano","Cruz del Sur","CST Transporte",
    "DATULI","Del Valle","DHL","Don Antonio","Don Gumer","DPD","Duro",
    "Enviopack","EPSA","Erbas","EURO Packaging","Expreso Oro Negro",
    "Failde","FAILE","Flecha Lok","FM Transporte","FRATI","Fravega","FIS Logística",
    "Gabcin","Gentile","Grabet","Grasso","Grupo GLI","Grupo Luro","Grupo Silco","Guevara Fletes",
    "HDL Transporte","HECA","HFL","HIMP A","Hornero",
    "IAFRATELLI","IFLOW","Impresur","Internavegación","INTERMEDIO","Id Group",
    "Joaquin","JM Yaya e Hijos","Juarez",
    "La Sevillanita","La Tablada","LEO Trucks","Lir","Loginter","Logística del Valle","Logística Giménez","Logística Integral Romano","Logística Soria","Logitech","Lomas del Mirador","LTN","Luisito","Lugone","Ludamany",
    "Marra e Hijos","Marino","MARIANO","Maringa","MAV","Meli (Mercado Libre)","MICHELIN (Mantenimiento)","Mirtrans","Moova","Moreiro","Multarys Traslados",
    "Nahuel Remolques","Navarro","NB Cargo","Newsan","Nieva","Norlog","Norte",
    "OCA","OCASA","Oliveri Transporte","Onetrade","Oro Negro","Oriente Elevadores",
    "Pabile","Paganini","PANGEA","Parra","Pavile","PEF","PLK Group","Promei","Provenzano","PYTEL",
    "QX",
    "Ragazzi","Reyna Isabel","Romano","Ruta 21 DPD",
    "Saff","Sainz","SERVINTAR","SERVITRAN","SIARI","Sipe","Spineta","STC","SUMAR Servicio Industrial",
    "Técnica Lift","Techin","TGC Autoelevadores","Thames","Toledo","Transporte del Valle","Transporte Grasso","Transporte Juarez","Transporte Norte","Transporte Trejo","Tronador",
    "Unibrick","Unión Logística","Unitrans","Urbano Logística",
    "Vega","VOLKOV","Vento",
    "Webpack","WBL",
    "Otros"
  ];
  const carrierOptions = carriers.map(c => `<option value="${c}">${c}</option>`).join('');
  
  res.send(`
    <!DOCTYPE html>
    <html><head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      ${fontLink}
      <title>Admin - OCASA Dock Manager</title>
      <style>${styles}
        .turno-admin { background: rgba(255,255,255,0.05); border-radius: 8px; padding: 12px; margin-bottom: 8px; }
        .turno-admin-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; }
        .turno-admin-header h3 { margin: 0; }
        .turno-admin-actions { display: flex; gap: 8px; }
        .turno-admin-actions button { padding: 6px 12px; font-size: 12px; }
        .edit-form { display: none; margin-top: 12px; padding-top: 12px; border-top: 1px solid rgba(255,255,255,0.1); }
        .edit-form.active { display: block; }
        .edit-form label { display: block; font-size: 12px; color: ${colors.textMuted}; margin: 8px 0 4px; }
        .edit-form input, .edit-form select { width: 100%; padding: 8px; font-size: 14px; margin-bottom: 4px; }
        .edit-form .row-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
        @media (max-width: 600px) { .edit-form .row-2 { grid-template-columns: 1fr; } }
        .btn-delete { background: #dc3545 !important; }
        .btn-edit { background: #ffc107 !important; color: #000 !important; }
        .btn-save { background: #28a745 !important; }
      </style>
    </head><body>
      <div class="container-wide">
        <img src="${logoSrc}" alt="OCASA" class="logo">
        <h1>🔐 Panel de Administración</h1>
        
        <div id="login" class="card">
          <input type="password" id="pass" placeholder="Contraseña" style="width:100%; padding:16px; font-size:18px; border-radius:8px; border:none; margin-bottom:12px;">
          <button onclick="login()" style="width:100%;">Ingresar</button>
        </div>
        
        <div id="panel" style="display:none;">
          <div class="card">
            <h2 style="margin-top:0;">🧹 Limpiar Base de Datos</h2>
            <button onclick="limpiar('egresados')" style="width:100%; background:#ffc107; color:#000; margin-bottom:8px;">Borrar turnos finalizados</button>
            <button onclick="limpiar('viejos')" style="width:100%; background:#ff9800; margin-bottom:8px;">Borrar turnos +7 días</button>
            <button onclick="limpiar('todos')" style="width:100%; background:#dc3545;">⚠️ Borrar TODOS</button>
          </div>
          
          <h2 style="margin-top:24px;">📋 Gestión de Turnos</h2>
          <div id="turnos-admin"></div>
        </div>
      </div>
      
      <script>
        const PASS = '${ADMIN_PASS}';
        const carrierOptions = \`${carrierOptions}\`;
        let allTurnos = [];
        
        function login() {
          if (document.getElementById('pass').value === PASS) {
            document.getElementById('login').style.display = 'none';
            document.getElementById('panel').style.display = 'block';
            loadTurnos();
          } else {
            alert('Contraseña incorrecta');
          }
        }
        
        async function loadTurnos() {
          const res = await fetch('/api/turnos');
          const data = await res.json();
          allTurnos = data.turnos || [];
          renderTurnos();
        }
        
        function renderTurnos() {
          const activos = allTurnos.filter(t => t.status !== 'EGRESADO');
          if (activos.length === 0) {
            document.getElementById('turnos-admin').innerHTML = '<div class="card" style="text-align:center; opacity:0.6;">No hay turnos activos</div>';
            return;
          }
          
          let html = '';
          activos.forEach(t => {
            html += '<div class="turno-admin" id="turno-' + t.turno_id + '">';
            html += '<div class="turno-admin-header">';
            html += '<h3>' + t.truck + ' <span class="badge badge-primary">' + t.status + '</span></h3>';
            html += '<div class="turno-admin-actions">';
            html += '<button class="btn btn-edit" onclick="toggleEdit(\\'' + t.turno_id + '\\')">✏️ Editar</button>';
            html += '<button class="btn btn-delete" onclick="eliminar(\\'' + t.turno_id + '\\')">🗑️ Eliminar</button>';
            html += '</div></div>';
            html += '<p style="margin:0; font-size:13px; color:#aaa;">' + t.carrier + ' • ' + (t.warehouse || 'Sin nave') + ' • ' + (t.operation || 'Sin op') + (t.dock ? ' • ' + t.dock : '') + '</p>';

            html += '<div class="edit-form" id="edit-' + t.turno_id + '">';
            html += '<div class="row-2">';
            html += '<div><label>Patente</label><input type="text" id="truck-' + t.turno_id + '" value="' + t.truck + '"></div>';
            html += '<div><label>Transportista</label><select id="carrier-' + t.turno_id + '"><option value="">Seleccionar...</option>' + carrierOptions + '</select></div>';
            html += '</div>';
            html += '<div class="row-2">';
            html += '<div><label>Nave</label><select id="warehouse-' + t.turno_id + '"><option value="Nave 1"' + (t.warehouse === 'Nave 1' ? ' selected' : '') + '>Nave 1</option><option value="Nave 2"' + (t.warehouse === 'Nave 2' ? ' selected' : '') + '>Nave 2</option><option value="Nave 3"' + (t.warehouse === 'Nave 3' ? ' selected' : '') + '>Nave 3</option></select></div>';
            html += '<div><label>Operación</label><select id="operation-' + t.turno_id + '"><option value="Descarga"' + (t.operation === 'Descarga' ? ' selected' : '') + '>Descarga</option><option value="Colecta"' + (t.operation === 'Colecta' ? ' selected' : '') + '>Colecta</option><option value="Carga"' + (t.operation === 'Carga' ? ' selected' : '') + '>Carga</option></select></div>';
            html += '</div>';
            html += '<label>Dársena</label><select id="dock-' + t.turno_id + '"><option value="">Sin asignar</option>';
            const ADMIN_NAVE_DOCKS = { 'Nave 1': [1, 8], 'Nave 2': [1, 30], 'Nave 3': [7, 15] };
            const ADMIN_PREFIX = { 'Nave 1': 'N1', 'Nave 2': 'N2', 'Nave 3': 'N3' };
            Object.keys(ADMIN_NAVE_DOCKS).forEach(nv => {
              for (let i = ADMIN_NAVE_DOCKS[nv][0]; i <= ADMIN_NAVE_DOCKS[nv][1]; i++) {
                const d = ADMIN_PREFIX[nv] + '-' + String(i).padStart(2, '0');
                html += '<option value="' + d + '"' + (t.dock === d ? ' selected' : '') + '>' + d + '</option>';
              }
            });
            html += '</select>';
            html += '<button class="btn btn-save" onclick="guardar(\\'' + t.turno_id + '\\')" style="width:100%; margin-top:12px;">💾 Guardar cambios</button>';
            html += '</div></div>';
          });
          
          document.getElementById('turnos-admin').innerHTML = html;
          
          // Set carrier values after render
          activos.forEach(t => {
            const sel = document.getElementById('carrier-' + t.turno_id);
            if (sel && t.carrier) sel.value = t.carrier;
          });
        }
        
        function toggleEdit(id) {
          document.getElementById('edit-' + id).classList.toggle('active');
        }
        
        async function eliminar(id) {
          if (!confirm('¿Eliminar este turno?')) return;
          const res = await fetch('/api/admin/eliminar', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ turnoId: id, pass: PASS })
          });
          const data = await res.json();
          if (data.success) {
            loadTurnos();
          } else {
            alert(data.error);
          }
        }
        
        async function guardar(id) {
          const turno = {
            turnoId: id,
            truck: document.getElementById('truck-' + id).value,
            carrier: document.getElementById('carrier-' + id).value,
            warehouse: document.getElementById('warehouse-' + id).value,
            operation: document.getElementById('operation-' + id).value,
            dock: document.getElementById('dock-' + id).value,
            pass: PASS
          };
          
          const res = await fetch('/api/admin/editar', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(turno)
          });
          const data = await res.json();
          if (data.success) {
            alert('✅ Guardado');
            loadTurnos();
          } else {
            alert(data.error);
          }
        }
        
        async function limpiar(tipo) {
          const msgs = {
            'egresados': '¿Borrar turnos FINALIZADOS?',
            'viejos': '¿Borrar turnos +7 días?',
            'todos': '⚠️ ¿BORRAR TODO?'
          };
          if (!confirm(msgs[tipo])) return;
          if (tipo === 'todos' && !confirm('¿SEGURO? No se puede deshacer.')) return;
          
          const res = await fetch('/api/admin/limpiar', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ tipo, pass: PASS })
          });
          const data = await res.json();
          alert(data.success ? '✅ ' + data.mensaje : '❌ ' + data.error);
          loadTurnos();
        }
      </script>
    </body></html>
  `);
});

app.post('/api/admin/limpiar', async (req, res) => {
  const { tipo, pass } = req.body;
  if (pass !== ADMIN_PASS) return res.json({ success: false, error: 'No autorizado' });
  
  try {
    let count;
    switch(tipo) {
      case 'egresados':
        count = await db.deleteWhere(t => t.status === 'EGRESADO');
        break;
      case 'viejos': {
        const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
        count = await db.deleteWhere(t => t.ts_entrada && new Date(t.ts_entrada).getTime() < cutoff);
        break;
      }
      case 'todos':
        count = await db.deleteWhere(() => true);
        break;
      default:
        return res.json({ success: false, error: 'Tipo inválido' });
    }
    res.json({ success: true, mensaje: count + ' turnos eliminados' });
  } catch(e) {
    res.json({ success: false, error: e.message });
  }
});

app.post('/api/admin/eliminar', async (req, res) => {
  const { turnoId, pass } = req.body;
  if (pass !== ADMIN_PASS) return res.json({ success: false, error: 'No autorizado' });

  try {
    await db.deleteTurno(turnoId);
    res.json({ success: true });
  } catch(e) {
    res.json({ success: false, error: e.message });
  }
});

app.post('/api/admin/editar', async (req, res) => {
  const { turnoId, truck, carrier, warehouse, operation, dock, pass } = req.body;
  if (pass !== ADMIN_PASS) return res.json({ success: false, error: 'No autorizado' });

  try {
    await db.updateTurno(turnoId, {
      truck: (truck || '').toUpperCase(), carrier, warehouse,
      operation, dock: dock || null
    });
    res.json({ success: true });
  } catch(e) {
    res.json({ success: false, error: e.message });
  }
});

// ===================== INICIAR SERVIDOR =====================
// En local (y en cualquier host con proceso persistente) escuchamos el puerto.
// En Vercel (serverless) NO se llama a listen: se exporta el handler de Express.
if (!process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`🚛 OCASA Dock Manager (Tortuguitas) corriendo en puerto ${PORT}`);
  });
}

module.exports = app;
