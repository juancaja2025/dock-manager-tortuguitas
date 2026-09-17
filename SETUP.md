# OCASA Dock Manager — Tortuguitas · Guía de puesta en marcha

App web responsive para gestionar el circuito de camiones en Tortuguitas (3 naves).
Persistencia sobre un **Google Sheet** mediante una **cuenta de servicio** de Google.

## Circuito

1. **Garita (seguridad de predio)** → registra el **ingreso al predio** y entrega un QR al chofer.
2. **Seguridad Interna (rol propio)** → recibe las **llaves** y registra el **ingreso a nave** (define Nave 1/2/3 y carga/descarga).
3. **Operador** → asigna dársena.
4. **Muelle** → atraque / desatraque.
5. **Seguridad Interna** → **devolución de llaves** (flujo inverso).
6. **Garita** → egreso (bloqueado si el chofer no retiró las llaves).

Dársenas (numeración por nave, IDs con prefijo): **Nave 1 = N1-01..N1-06**, **Nave 2 = N2-01..N2-30**, **Nave 3 = N3-01..N3-06**.
Se configuran en `server.js` (objeto `NAVE_DOCKS` dentro de la vista `/operador`).

---

## 1. Crear la cuenta de servicio de Google (una vez)

1. Entrá a https://console.cloud.google.com/ y creá (o elegí) un proyecto.
2. **APIs y servicios → Biblioteca** → buscá **Google Sheets API** → **Habilitar**.
3. **APIs y servicios → Credenciales → Crear credenciales → Cuenta de servicio**.
   - Nombre: `dock-tortuguitas`. Crear y continuar (sin roles). Listo.
4. Abrí la cuenta de servicio creada → pestaña **Claves → Agregar clave → Crear clave → JSON**.
   - Se descarga un archivo `.json`. **Ese es el secreto.** Guardalo bien, no lo subas al repo.
5. Anotá el **client_email** del JSON (algo como `dock-tortuguitas@tu-proyecto.iam.gserviceaccount.com`).

## 2. Crear el Google Sheet

1. Creá una planilla nueva en Google Sheets (vacía).
2. De la URL copiá el **SHEET_ID**: `https://docs.google.com/spreadsheets/d/`**`<SHEET_ID>`**`/edit`.
3. **Compartí** la planilla con el **client_email** de la cuenta de servicio, con rol **Editor**.
   - (La app crea sola las pestañas `turnos`, `garita_usuarios`, `interna_usuarios` y los usuarios iniciales.)

## 3. Correr local

1. Copiá `.env.example` a `.env`.
2. Completá en `.env`:
   - `SHEET_ID=` el id del paso 2.
   - `GOOGLE_SERVICE_ACCOUNT_JSON=` el contenido **completo** del JSON en **una sola línea**.
     (Tip: abrí el .json, copiá todo y pegalo tal cual entre comillas no hace falta — pegá el JSON crudo).
3. Instalá dependencias y arrancá:
   ```bash
   npm install
   npm run dev
   ```
4. Abrí http://localhost:3000

### Usuarios iniciales (se crean solos)
- **Garita:** `guardia@ocasa.com` / `garita2026`
- **Seguridad Interna:** `interna@ocasa.com` / `llaves2026`
- **Admin** (`/admin`): contraseña `Tortuguitas2026` (o la que pongas en `ADMIN_PASS`).

> Cambiá estas contraseñas editando las filas en las pestañas `garita_usuarios` / `interna_usuarios` del Sheet.

### Rutas
- `/entrada` — info para el chofer al llegar.
- `/garita-registro` — panel de garita (ingreso / egreso / historial).
- `/interna` — panel de seguridad interna (entrega / devolución de llaves).
- `/operador` — asignación de dársenas + dashboard.
- `/dock/:id` — atraque/desatraque por dársena (ej. `/dock/N2-05`).
- `/turno/:id` — seguimiento en vivo del chofer (link del QR).
- `/admin` — edición/limpieza de turnos.

---

## 4. Desplegar en Vercel

1. `npm i -g vercel` (ya está) y `vercel login`.
2. Desde la carpeta del proyecto: `vercel` (crea el proyecto) y luego `vercel --prod`.
3. Cargá las variables de entorno en Vercel (Dashboard → Project → Settings → Environment Variables, o por CLI):
   ```bash
   vercel env add SHEET_ID
   vercel env add GOOGLE_SERVICE_ACCOUNT_JSON
   vercel env add ADMIN_PASS
   ```
   Pegá los mismos valores del `.env`. Aplicá a Production (y Preview si querés).
4. Re-deploy: `vercel --prod`.

`vercel.json` ya enruta todo a `api/index.js` (la app Express corre como función serverless) e incluye `public/**` (logo).

---

## Notas técnicas
- **Sin tacos de goma** y **sin número de viaje** (a diferencia de la versión Pilar).
- Google Sheets **no tiene transacciones**: la asignación de dársenas es lectura-verificación-escritura. Para el volumen de Tortuguitas es suficiente; si en el futuro hay mucha concurrencia, migrar a Postgres es directo (la capa de datos está aislada en `lib/sheetsDb.js`).
- El acceso al Sheet se cachea 1,5 s para no agotar la cuota de la API durante el auto-refresh del panel.
