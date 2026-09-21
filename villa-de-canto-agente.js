
const Anthropic = require("@anthropic-ai/sdk");
const { google } = require("googleapis");
const express = require("express");
const bodyParser = require("body-parser");

const app = express();
app.use(bodyParser.json({
  limit: "2mb",
  strict: false
}));
app.use((err, req, res, next) => {
  if (err.type === "entity.parse.failed") return res.status(200).json({ response: "No entendí bien ese mensaje, ¿me lo repites en una sola línea?" });
  next(err);
});

const client = new Anthropic.Anthropic({ apiKey: process.env.CLAUDE_API_KEY });
const auth = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  "http://localhost:8080/callback"
);
const calendar = google.calendar({ version: "v3", auth });
const CALENDAR_ID = process.env.CALENDAR_ID;

const conversations = new Map();

const SYSTEM_PROMPT = `Eres Canto, el asistente de Villa de Canto en Amazcala, El Marques, Queretaro.

DATOS:
- Capacidad: 15 adultos + 2 ninos maximo
- Direccion: Boulevard Rodolfo Gaona 106, Campestre Amazcala
- Check-in 13:00 | Check-out 12:00
- Contacto: David 33 1769 2871

SERVICIOS: alberca climatizada 33-35C, horno de pizza, asador, gym, area de juegos, estacionamiento 4 autos, limpieza incluida.

TARIFAS POR NOCHE:
- Lunes a jueves y domingo: $10,500
- Viernes: $12,000
- Sabado: $14,000

PAGO:
- Anticipo 50% del total
- Banco Inbursa, CLABE 036680500511854406, Titular Villa de Canto
- Deposito en garantia $5,000 reembolsable 48h despues del checkout

REGLAS:
- No des descuentos
- No inventes disponibilidad
- Pide contrato firmado + INE al confirmar

TONO: calido, pausado, conversacional. Emojis ocasionales. Nunca robotico.

FLUJO: saluda, pregunta que necesita, recoge nombre/fechas/adultos/ninos/motivo/correo de forma natural, calcula noches y total, presenta cotizacion, si acepta manda datos bancarios y pide comprobante.

IMPORTANTE SOBRE FECHAS: El cliente puede escribir fechas en cualquier formato (22-09-2026, 22/09/2026, "22 de septiembre", "22 sept 2026", etc.) y puede venir junto con otras palabras en la misma linea (ej "check in 22-09-2026"). SIEMPRE reconoce cualquier fecha que el cliente mencione, sin importar el formato o si viene acompañada de texto. Nunca digas que no recibiste una fecha si el cliente ya escribio una - revisa TODO el mensaje, no solo el inicio.`;

app.get("/", (req, res) => res.json({ status: "ok", agente: "Canto" }));

app.post("/webhook", async (req, res) => {
  const { phoneNumber, message } = req.body;
  if (!phoneNumber || !message) return res.status(400).json({ error: "phoneNumber y message requeridos" });

  if (!conversations.has(phoneNumber)) conversations.set(phoneNumber, []);
  const history = conversations.get(phoneNumber);
  history.push({ role: "user", content: message });

  try {
    const response = await client.messages.create({
      model: "claude-sonnet-5",
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      messages: history,
    });
    const reply = response.content.filter(b => b.type === "text").map(b => b.text).join("\n");
    history.push({ role: "assistant", content: reply });
    if (history.length > 20) history.splice(0, history.length - 20);
    res.json({ response: reply });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Agente Canto en puerto ${PORT}`));
