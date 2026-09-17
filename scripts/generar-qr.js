// Genera PNGs de QR (con el logo OCASA a color al centro y un rótulo abajo) en la carpeta QRs/.
//   - QRs/darsenas/Nx-yy.png  -> apuntan a <BASE>/dock/<id>   (rótulo: dársena + nave)
//   - QRs/paginas/<pagina>.png -> apuntan a <BASE>/<ruta>      (rótulo: nombre de la página)
// Uso:  node scripts/generar-qr.js            (usa BASE por defecto, producción)
//       BASE_URL=http://localhost:3000 node scripts/generar-qr.js
//
// Requiere devDependencies: qrcode, sharp.

const fs = require('fs');
const path = require('path');
const QRCode = require('qrcode');
const sharp = require('sharp');
const { createCanvas, GlobalFonts } = require('@napi-rs/canvas');

// Registrar Montserrat (para el rótulo de los QR)
const FONTS = path.join(__dirname, '..', 'assets', 'fonts');
GlobalFonts.registerFromPath(path.join(FONTS, 'Montserrat-Bold.ttf'), 'Montserrat');
GlobalFonts.registerFromPath(path.join(FONTS, 'Montserrat-SemiBold.ttf'), 'Montserrat SemiBold');

const BASE = (process.env.BASE_URL || 'https://dock-tortuguitas.vercel.app').replace(/\/$/, '');
const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'QRs');
const LOGO = path.join(ROOT, 'public', 'logo_ocasa_color.png'); // logo oficial a color

// Marca OCASA
const CALYPSO = '#0099A8';
const DARK = '#056572';

// Dársenas por nave (mismo modelo que la app): [desde, hasta]
const NAVE_DOCKS = { 'Nave 1': [1, 8], 'Nave 2': [1, 30], 'Nave 3': [7, 15] };
const NAVE_PREFIX = { 'Nave 1': 'N1', 'Nave 2': 'N2', 'Nave 3': 'N3' };

// Links de páginas
const PAGINAS = [
  { file: 'garita',       ruta: '/garita-registro', label: 'Garita' },
  { file: 'interna',      ruta: '/interna',         label: 'Seguridad Interna' },
  { file: 'operador',     ruta: '/operador',        label: 'Operador' },
  { file: 'entrada',      ruta: '/entrada',         label: 'Choferes' },
  { file: 'qr-darsenas',  ruta: '/qr-darsenas',     label: 'QR de dársenas' },
];

const SIZE = 700;        // px del QR
const EMBLEM = 200;      // px del recuadro central con el logo
const CAP_H = 130;       // px del área de rótulo (abajo)

function mkdir(p) { fs.mkdirSync(p, { recursive: true }); }

async function emblemBuffer() {
  // Recuadro BLANCO redondeado con borde Calypso + logo OCASA a color centrado
  const boxSvg = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${EMBLEM}" height="${EMBLEM}">
       <rect x="5" y="5" width="${EMBLEM - 10}" height="${EMBLEM - 10}" rx="26" ry="26" fill="#ffffff" stroke="${CALYPSO}" stroke-width="8"/>
     </svg>`
  );
  const box = await sharp(boxSvg).png().toBuffer();
  const logo = await sharp(LOGO).resize({ width: EMBLEM - 56, fit: 'inside' }).png().toBuffer();
  return sharp(box).composite([{ input: logo, gravity: 'center' }]).png().toBuffer();
}

function captionPng(caption, sub) {
  // Rótulo en Montserrat renderizado con canvas
  const c = createCanvas(SIZE, CAP_H);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, SIZE, CAP_H);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = DARK;
  ctx.font = '50px Montserrat';
  ctx.fillText(caption, SIZE / 2, sub ? 58 : 78);
  if (sub) {
    ctx.fillStyle = CALYPSO;
    ctx.font = '32px "Montserrat SemiBold"';
    ctx.fillText(sub, SIZE / 2, 104);
  }
  return c.toBuffer('image/png');
}

async function generarQR(url, outPath, caption, sub) {
  const qr = await QRCode.toBuffer(url, {
    errorCorrectionLevel: 'H',     // alta corrección: tolera el logo al centro
    margin: 2,
    width: SIZE,
    color: { dark: DARK, light: '#ffffff' },
  });
  const emblem = await emblemBuffer();
  const qrConLogo = await sharp(qr).composite([{ input: emblem, gravity: 'center' }]).png().toBuffer();

  const final = await sharp({ create: { width: SIZE, height: SIZE + CAP_H, channels: 4, background: '#ffffff' } })
    .composite([
      { input: qrConLogo, top: 0, left: 0 },
      { input: captionPng(caption, sub), top: SIZE, left: 0 },
    ])
    .png()
    .toBuffer();

  fs.writeFileSync(outPath, final);
}

(async () => {
  mkdir(path.join(OUT, 'darsenas'));
  mkdir(path.join(OUT, 'paginas'));

  let nDarsenas = 0;
  for (const nave of Object.keys(NAVE_DOCKS)) {
    for (let i = NAVE_DOCKS[nave][0]; i <= NAVE_DOCKS[nave][1]; i++) {
      const id = NAVE_PREFIX[nave] + '-' + String(i).padStart(2, '0');
      await generarQR(BASE + '/dock/' + id, path.join(OUT, 'darsenas', id + '.png'), id, nave);
      nDarsenas++;
    }
  }

  for (const p of PAGINAS) {
    await generarQR(BASE + p.ruta, path.join(OUT, 'paginas', p.file + '.png'), p.label, null);
  }

  console.log('✅ QRs generados en ' + OUT);
  console.log('   • Dársenas: ' + nDarsenas + ' (QRs/darsenas/)');
  console.log('   • Páginas : ' + PAGINAS.length + ' (QRs/paginas/)');
  console.log('   • Logo    : ' + path.basename(LOGO));
  console.log('   • Base URL: ' + BASE);
})().catch(e => { console.error('❌ Error generando QRs:', e); process.exit(1); });
