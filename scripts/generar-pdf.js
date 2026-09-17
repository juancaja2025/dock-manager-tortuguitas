// Genera un PDF imprimible con TODOS los QR (dársenas + páginas).
// Cada QR se imprime a 8,5 x 8,5 cm exactos, con el logo OCASA a color al centro
// y el rótulo (dársena/nave o nombre de página) en Montserrat debajo.
//
// Uso:  node scripts/generar-pdf.js
//       BASE_URL=http://localhost:3000 node scripts/generar-pdf.js
//
// Requiere devDependencies: pdfkit, qrcode, sharp.

const fs = require('fs');
const path = require('path');
const QRCode = require('qrcode');
const sharp = require('sharp');
const PDFDocument = require('pdfkit');

const BASE = (process.env.BASE_URL || 'https://dock-tortuguitas.vercel.app').replace(/\/$/, '');
const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'QRs', 'OCASA-QRs-8.5x8.5.pdf');
const LOGO = path.join(ROOT, 'public', 'logo_ocasa_color.png');
const FONTS = path.join(ROOT, 'assets', 'fonts');

const CALYPSO = '#0099A8';
const DARK = '#056572';

const NAVE_DOCKS = { 'Nave 1': [1, 8], 'Nave 2': [1, 30], 'Nave 3': [7, 15] };
const NAVE_PREFIX = { 'Nave 1': 'N1', 'Nave 2': 'N2', 'Nave 3': 'N3' };
const PAGINAS = [
  { ruta: '/garita-registro', label: 'Garita' },
  { ruta: '/interna',         label: 'Seguridad Interna' },
  { ruta: '/operador',        label: 'Operador' },
  { ruta: '/entrada',         label: 'Choferes' },
  { ruta: '/qr-darsenas',     label: 'QR de dársenas' },
];

// ---- Generación del QR (cuadrado, con logo al centro) ----
const QPX = 900;                         // resolución del QR en px
const EMBLEM = Math.round(QPX * 0.26);   // recuadro central

async function emblemBuffer() {
  const boxSvg = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${EMBLEM}" height="${EMBLEM}">
       <rect x="6" y="6" width="${EMBLEM - 12}" height="${EMBLEM - 12}" rx="30" ry="30" fill="#ffffff" stroke="${CALYPSO}" stroke-width="9"/>
     </svg>`
  );
  const box = await sharp(boxSvg).png().toBuffer();
  const logo = await sharp(LOGO).resize({ width: EMBLEM - 64, fit: 'inside' }).png().toBuffer();
  return sharp(box).composite([{ input: logo, gravity: 'center' }]).png().toBuffer();
}

async function qrPng(url, emblem) {
  const qr = await QRCode.toBuffer(url, {
    errorCorrectionLevel: 'H',
    margin: 2,
    width: QPX,
    color: { dark: DARK, light: '#ffffff' },
  });
  return sharp(qr).composite([{ input: emblem, gravity: 'center' }]).png().toBuffer();
}

// ---- Layout PDF (cm reales) ----
const CM = 72 / 2.54;      // pt por cm
const S = 8.5 * CM;        // lado del QR = 8,5 cm
const LABEL_H = 40;        // alto reservado para el rótulo (pt)
const COL_GAP = 26;
const ROW_GAP = 24;
const A4 = [595.28, 841.89];

(async () => {
  const emblem = await emblemBuffer();

  // Armar lista de items en orden: dársenas (por nave) + páginas
  const items = [];
  for (const nave of Object.keys(NAVE_DOCKS)) {
    const [desde, hasta] = NAVE_DOCKS[nave];
    for (let i = desde; i <= hasta; i++) {
      const id = NAVE_PREFIX[nave] + '-' + String(i).padStart(2, '0');
      items.push({ url: BASE + '/dock/' + id, big: id, sub: nave });
    }
  }
  for (const p of PAGINAS) {
    items.push({ url: BASE + p.ruta, big: p.label, sub: 'Página' });
  }

  // Generar todos los buffers de QR
  for (const it of items) it.buf = await qrPng(it.url, emblem);

  // Construir el PDF
  const doc = new PDFDocument({ size: 'A4', margin: 0 });
  doc.registerFont('MontBold', path.join(FONTS, 'Montserrat-Bold.ttf'));
  doc.registerFont('MontSemi', path.join(FONTS, 'Montserrat-SemiBold.ttf'));
  const stream = fs.createWriteStream(OUT);
  doc.pipe(stream);

  const cols = 2;
  const tileH = S + LABEL_H;
  const gridW = cols * S + (cols - 1) * COL_GAP;
  const marginX = (A4[0] - gridW) / 2;
  const rowsPerPage = Math.max(1, Math.floor((A4[1] - 40 + ROW_GAP) / (tileH + ROW_GAP)));
  const gridH = rowsPerPage * tileH + (rowsPerPage - 1) * ROW_GAP;
  const marginY = (A4[1] - gridH) / 2;

  items.forEach((it, idx) => {
    const posInPage = idx % (cols * rowsPerPage);
    if (idx > 0 && posInPage === 0) doc.addPage();
    const col = posInPage % cols;
    const row = Math.floor(posInPage / cols);
    const x = marginX + col * (S + COL_GAP);
    const y = marginY + row * (tileH + ROW_GAP);

    // Guía de corte (borde suave)
    doc.roundedRect(x - 6, y - 6, S + 12, tileH + 6, 10).lineWidth(0.5).strokeColor('#d8dee6').stroke();

    // QR a 8,5 x 8,5 cm
    doc.image(it.buf, x, y, { width: S, height: S });

    // Rótulo
    doc.font('MontBold').fontSize(17).fillColor(DARK)
      .text(it.big, x, y + S + 6, { width: S, align: 'center' });
    doc.font('MontSemi').fontSize(11).fillColor(CALYPSO)
      .text(it.sub, x, y + S + 25, { width: S, align: 'center' });
  });

  doc.end();
  await new Promise((res) => stream.on('finish', res));

  console.log('✅ PDF generado: ' + OUT);
  console.log('   • Total QRs: ' + items.length + ' (dársenas + páginas)');
  console.log('   • Tamaño de cada QR: 8,5 x 8,5 cm');
  console.log('   • ' + (cols * rowsPerPage) + ' por hoja A4 · Base URL: ' + BASE);
})().catch(e => { console.error('❌ Error generando el PDF:', e); process.exit(1); });
