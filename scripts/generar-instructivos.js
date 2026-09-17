// Genera un INSTRUCTIVO en PDF por cada link/rol del sistema (Garita, Seguridad
// Interna, Operador, Muelle y Chofer). Cada PDF lleva la marca OCASA, el QR de la
// pantalla y los pasos numerados. Salida en instructivos/.
//
// Uso:  node scripts/generar-instructivos.js
//       BASE_URL=http://localhost:3000 node scripts/generar-instructivos.js
//
// Requiere devDependencies: pdfkit, qrcode, sharp.

const fs = require('fs');
const path = require('path');
const QRCode = require('qrcode');
const sharp = require('sharp');
const PDFDocument = require('pdfkit');

const BASE = (process.env.BASE_URL || 'https://dock-tortuguitas.vercel.app').replace(/\/$/, '');
const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'instructivos');
const LOGO = path.join(ROOT, 'public', 'logo_ocasa_color.png');
const FONTS = path.join(ROOT, 'assets', 'fonts');

const CALYPSO = '#0099A8';
const DARK = '#056572';
const INK = '#1a2b32';
const MUTED = '#5a6b73';

// ---------- Contenido de cada instructivo ----------
const ROLES = [
  {
    file: 'instructivo-garita',
    titulo: 'Garita',
    badge: 'Seguridad de predio',
    url: BASE + '/garita-registro',
    intro: 'Registrás el ingreso de cada camión al predio, le entregás el QR de su turno y das el egreso cuando se va.',
    pasos: [
      ['Iniciá sesión', 'Entrá con tu email y contraseña. Usuario inicial: guardia@ocasa.com.'],
      ['Registrá el ingreso', 'En la pestaña INGRESO cargá la patente (el sistema avisa si ya está en el predio), el transportista, el chofer y el estado de la carga. DNI, celular, semi, contenedor y precinto son opcionales pero recomendados.'],
      ['Entregá el QR al chofer', 'Al registrar se genera un QR. Mostráselo o tocá "Enviar link por WhatsApp" para mandárselo. Con ese QR el chofer sigue el estado de su turno desde el celular.'],
      ['El chofer avanza', 'El operador le asignará una dársena; el chofer la verá en su QR y se dirigirá a atracar.'],
      ['Dá el egreso', 'En la pestaña EGRESO buscá la patente, verificá el tiempo en predio y el estado de las llaves, y confirmá el egreso. El sistema NO deja salir si el chofer no retiró las llaves en Seguridad Interna.'],
    ],
    accesos: ['Garita: guardia@ocasa.com  /  garita2026'],
    nota: 'En la pestaña HISTORIAL podés consultar los movimientos de los últimos días.',
  },
  {
    file: 'instructivo-seguridad-interna',
    titulo: 'Seguridad Interna',
    badge: 'Gestión de llaves',
    url: BASE + '/interna',
    intro: 'Recibís y devolvés las llaves del camión. Trabajás sobre los camiones que ya atracaron.',
    pasos: [
      ['Iniciá sesión', 'Entrá con tu usuario. Usuario inicial: interna@ocasa.com.'],
      ['Recibí las llaves (entrega)', 'En la pestaña ENTREGA DE LLAVES aparecen los camiones que YA ATRACARON. Elegí la operación (Descarga o Carga), recibí las llaves del chofer y tocá "Registrar entrega de llaves".'],
      ['Guardá las llaves', 'Las llaves quedan en Seguridad Interna mientras se hace la carga o descarga.'],
      ['Devolvé las llaves (devolución)', 'Cuando termina la operación, en la pestaña DEVOLUCIÓN DE LLAVES entregá las llaves al chofer y confirmá el retiro.'],
      ['Recién ahí desatraca', 'El muelle no puede desatracar el camión hasta que registres la devolución de las llaves.'],
    ],
    accesos: ['Seguridad Interna: interna@ocasa.com  /  llaves2026'],
    nota: null,
  },
  {
    file: 'instructivo-operador',
    titulo: 'Operador',
    badge: 'Asignación de dársenas',
    url: BASE + '/operador',
    intro: 'Asignás las dársenas a los camiones y seguís el estado de la operación.',
    pasos: [
      ['Abrí el panel', 'No requiere usuario. Vas a ver los turnos agrupados por estado.'],
      ['Asigná una dársena', 'A los camiones en "Esperando asignación" elegí una dársena libre del desplegable (agrupado por Nave 1, 2 y 3) y tocá "Asignar". El chofer verá la dársena en su QR.'],
      ['Seguí la operación', 'Los turnos van pasando por Atracado y Desatracado. Podés filtrar por nave y ver el estado de cada dársena en la grilla.'],
      ['Imprimí los QR de dársenas', 'El botón "QR dársenas" abre la hoja con los QR de cada muelle para imprimir y pegar.'],
      ['Mirá las métricas', 'La pestaña Dashboard muestra tiempos promedio, volumen por nave, por transportista y por hora.'],
    ],
    accesos: null,
    nota: null,
  },
  {
    file: 'instructivo-muelle',
    titulo: 'Muelle (Dársena)',
    badge: 'Atraque y desatraque',
    url: BASE + '/qr-darsenas',
    intro: 'Confirmás el atraque y el desatraque de cada camión escaneando el QR pegado en la dársena.',
    pasos: [
      ['Escaneá el QR de la dársena', 'Cada muelle tiene su QR (ej. N2-05). Escanealo para abrir la pantalla de esa dársena.'],
      ['Confirmá el ATRAQUE', 'Cuando el camión atraca en su dársena, tocá "Confirmar atraque".'],
      ['El chofer entrega las llaves', 'Después del atraque, el chofer deja las llaves en Seguridad Interna para que se haga la operación.'],
      ['Confirmá el DESATRAQUE', 'Al terminar, y con las llaves ya devueltas al chofer, volvé a escanear y tocá "Confirmar desatraque". El sistema no lo permite si el chofer todavía no retiró las llaves.'],
    ],
    accesos: null,
    nota: 'El QR de este instructivo abre la hoja imprimible con los QR de todas las dársenas.',
  },
  {
    file: 'instructivo-chofer',
    titulo: 'Chofer',
    badge: 'Qué hacer al llegar',
    url: BASE + '/entrada',
    intro: 'Estos son los pasos desde que entrás a la planta hasta que salís.',
    pasos: [
      ['Presentate en la garita', 'Llevá tu documentación. La guardia registra tu ingreso al predio.'],
      ['Recibí y escaneá tu QR', 'La guardia te da un QR (o te lo manda por WhatsApp). Escanealo para seguir el estado de tu turno.'],
      ['Andá a la dársena asignada', 'Cuando te asignen una dársena, dirigite y atracá.'],
      ['Dejá las llaves en Seguridad Interna', 'Ya atracado, entregá las llaves del camión en Seguridad Interna.'],
      ['Retirá las llaves al terminar', 'Cuando termina la carga o descarga, retirá las llaves en Seguridad Interna.'],
      ['Desatracá y salí por garita', 'Con las llaves en tu poder, desatracá y dirigite a la garita para el egreso.'],
    ],
    accesos: null,
    nota: 'Usá siempre zapatos de seguridad y chaleco reflectivo dentro de la planta.',
  },
];

// ---------- QR con logo (para el instructivo) ----------
const QPX = 600;
const EMBLEM = Math.round(QPX * 0.26);
async function qrConLogo(url) {
  const boxSvg = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${EMBLEM}" height="${EMBLEM}">
       <rect x="4" y="4" width="${EMBLEM - 8}" height="${EMBLEM - 8}" rx="20" ry="20" fill="#ffffff" stroke="${CALYPSO}" stroke-width="7"/>
     </svg>`
  );
  const box = await sharp(boxSvg).png().toBuffer();
  const logo = await sharp(LOGO).resize({ width: EMBLEM - 44, fit: 'inside' }).png().toBuffer();
  const emblem = await sharp(box).composite([{ input: logo, gravity: 'center' }]).png().toBuffer();
  const qr = await QRCode.toBuffer(url, { errorCorrectionLevel: 'H', margin: 2, width: QPX, color: { dark: DARK, light: '#ffffff' } });
  return sharp(qr).composite([{ input: emblem, gravity: 'center' }]).png().toBuffer();
}

// ---------- Render de un instructivo ----------
const PAGE = [595.28, 841.89];
const M = 44;
const CW = PAGE[0] - 2 * M;

function render(role, qrBuf, outPath) {
  const doc = new PDFDocument({ size: 'A4', margin: 0 });
  doc.registerFont('Bold', path.join(FONTS, 'Montserrat-Bold.ttf'));
  doc.registerFont('Semi', path.join(FONTS, 'Montserrat-SemiBold.ttf'));
  doc.registerFont('Med', path.join(FONTS, 'Montserrat-Medium.ttf'));
  doc.registerFont('Reg', path.join(FONTS, 'Montserrat-Regular.ttf'));
  const stream = fs.createWriteStream(outPath);
  doc.pipe(stream);

  // Header: logo + QR
  const QSZ = 118;
  doc.image(LOGO, M, M, { height: 26 });
  doc.image(qrBuf, PAGE[0] - M - QSZ, M, { width: QSZ, height: QSZ });
  doc.font('Reg').fontSize(7.5).fillColor(MUTED)
    .text('Escaneá para abrir', PAGE[0] - M - QSZ, M + QSZ + 3, { width: QSZ, align: 'center' });

  // Título
  let y = M + 46;
  const titleW = CW - QSZ - 16;
  doc.font('Bold').fontSize(23).fillColor(DARK).text('Instructivo', M, y, { width: titleW });
  doc.font('Bold').fontSize(23).fillColor(INK).text(role.titulo, M, doc.y, { width: titleW });
  doc.font('Semi').fontSize(12).fillColor(CALYPSO).text(role.badge, M, doc.y + 2, { width: titleW });

  y = Math.max(doc.y + 10, M + QSZ + 22);

  // Intro
  doc.font('Med').fontSize(11).fillColor(INK);
  doc.text(role.intro, M, y, { width: CW, lineGap: 2 });
  y = doc.y + 12;

  // Pill URL
  const pillH = 26;
  doc.roundedRect(M, y, CW, pillH, 8).fill('#e7f5f7');
  doc.font('Semi').fontSize(9.5).fillColor(DARK)
    .text('Link:  ' + role.url, M + 12, y + 8, { width: CW - 24, lineBreak: false });
  y += pillH + 18;

  // Pasos
  role.pasos.forEach((p, i) => {
    const [titulo, desc] = p;
    const cx = M + 13, cy = y + 12, r = 13;
    const textX = M + 40, textW = CW - 40;
    doc.font('Semi').fontSize(11.5);
    const hT = doc.heightOfString(titulo, { width: textW });
    doc.font('Reg').fontSize(10.5);
    const hD = doc.heightOfString(desc, { width: textW, lineGap: 1.5 });
    const blockH = hT + 2 + hD;

    // salto de página si no entra
    if (y + Math.max(blockH, 26) > PAGE[1] - 70) { doc.addPage(); y = M; }

    // círculo numerado
    doc.circle(cx, y + 12, r).fill(CALYPSO);
    doc.font('Bold').fontSize(12).fillColor('#ffffff')
      .text(String(i + 1), cx - r, y + 6, { width: 2 * r, align: 'center' });

    // texto
    doc.font('Semi').fontSize(11.5).fillColor(DARK).text(titulo, textX, y, { width: textW });
    doc.font('Reg').fontSize(10.5).fillColor(MUTED).text(desc, textX, doc.y + 1, { width: textW, lineGap: 1.5 });
    y = Math.max(y + 26, doc.y) + 12;
  });

  // Accesos
  if (role.accesos && role.accesos.length) {
    const boxH = 24 + role.accesos.length * 15;
    if (y + boxH > PAGE[1] - 60) { doc.addPage(); y = M; }
    doc.roundedRect(M, y, CW, boxH, 8).fillAndStroke('#f2fafb', CALYPSO);
    doc.font('Semi').fontSize(10).fillColor(DARK).text('Accesos', M + 12, y + 8);
    doc.font('Med').fontSize(10).fillColor(INK);
    role.accesos.forEach((a, i) => doc.text(a, M + 12, y + 24 + i * 15, { width: CW - 24 }));
    y += boxH + 14;
  }

  // Nota
  if (role.nota) {
    doc.font('Med').fontSize(9.5).fillColor(MUTED);
    const hN = doc.heightOfString(role.nota, { width: CW - 24, lineGap: 1.5 });
    const boxH = hN + 18;
    if (y + boxH > PAGE[1] - 55) { doc.addPage(); y = M; }
    doc.roundedRect(M, y, CW, boxH, 8).fill('#fff7ec');
    doc.font('Med').fontSize(9.5).fillColor('#8a5a1a').text('Nota:  ' + role.nota, M + 12, y + 9, { width: CW - 24, lineGap: 1.5 });
    y += boxH + 10;
  }

  // Footer
  doc.font('Reg').fontSize(8).fillColor(MUTED)
    .text('OCASA Dock Manager · Planta Tortuguitas', M, PAGE[1] - 34, { width: CW, align: 'center' });

  doc.end();
  return new Promise((res) => stream.on('finish', res));
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  for (const role of ROLES) {
    const qrBuf = await qrConLogo(role.url);
    await render(role, qrBuf, path.join(OUT, role.file + '.pdf'));
    console.log('  ✓ ' + role.file + '.pdf  (' + role.titulo + ')');
  }
  console.log('✅ Instructivos generados en ' + OUT + '  ·  Base URL: ' + BASE);
})().catch(e => { console.error('❌ Error generando instructivos:', e); process.exit(1); });
