// Punto de entrada serverless para Vercel.
// Vercel define process.env.VERCEL, por lo que server.js NO llama a app.listen
// y exporta la app de Express, que funciona como handler (req, res).
module.exports = require('../server.js');
