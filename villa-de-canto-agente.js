const Anthropic = require("@anthropic-ai/sdk");
const { google } = require("googleapis");
const express = require("express");
const bodyParser = require("body-parser");
const sqlite3 = require("sqlite3").verbose();
const path = require("path");

const app = express();
app.use(bodyParser.json({ limit: "2mb", strict: false }));

const client = new Anthropic.Anthropic({ apiKey: process.env.CLAUDE_API_KEY });
const auth = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  "http://localhost:8080/callback"
);
const calendar = google.calendar({ version: "v3", auth });
const CALENDAR_ID = process.env.CALENDAR_ID;

const db = new sqlite3.Database(path.join("/tmp", "conversations.db"));
db.run(`CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  messages TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
)`);

function hoyMexico() {
  return new Date().toLocaleDateString("es-MX", { timeZone: "America/Mexico_City", day: "2-digit", month: "2-digit", year: "numeric", weekday: "long" });
}

const SYSTEM_PROMPT = `Eres Canto, el asistente de Villa de Canto en Amazcala, El Marques, Queretaro.

FECHA DE HOY: ${hoyMexico()} (usa esto para resolver "manana", "el viernes", "este fin de semana", etc. sin preguntar)

FORMATO DE FECHAS: El cliente puede escribir fechas de cualquier forma (22/09/2026, 22-09-2026, "22 de septiembre", "manana", "el viernes que entra"). Acepta y entiende cualquier formato, nunca rechaces una fecha por su formato ni pidas que la repita en un formato especifico.

DATOS:
- Capacidad: 15 adultos + 2 ninos maximo
- Direccion: Boulevard Rodolfo Gaona 106, Campestre Amazcala
- Check-in 13:00 | Check-out 12:00
- Contacto: David 33 1769 2871

DISTRIBUCION DE HABITACIONES (5 habitaciones, todas con aire acondicionado):
1. Cama King Size + Sofa Cama Individual + bano completo
2. Litera con 2 camas Queen + cama individual + bano completo
3. Cama King Size + cama Individual + bano completo
4. Cama King Size + bano completo
5. 2 Camas Matrimoniales + medio bano

SERVICIOS: alberca climatizada 33-35C, horno de pizza, asador, gym, area de juegos, estacionamiento 4 autos, limpieza incluida.

PAQUETES ADICIONALES (mejoran la experiencia, se cotizan aparte de la renta):
- Cumpleanos: decoracion del cuarto con globos, pastel con vela de bengala, decoracion de "Feliz Cumpleanos"
- Hay otros paquetes disponibles (bodas, aniversarios, eventos especiales, etc.)
Si preguntan por paquetes, confirma que existen y menciona el de cumpleanos como ejemplo. Los precios exactos aun no estan definidos, dilo con naturalidad ("estamos por confirmar el costo de ese paquete, en breve te doy el numero exacto") sin inventar cifras ni remitir a otra persona.

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
- Nunca pidas correo electronico; no es necesario para la reserva

TONO: calido, pausado, conversacional. Emojis ocasionales. Nunca robotico.

EXTRACCION DE DATOS: El cliente puede darte varios datos juntos en un solo mensaje (separados por comas, saltos de linea, o mezclados en una frase) o uno por uno en mensajes distintos. Lee TODO el mensaje completo con cuidado antes de responder y extrae cada dato que encuentres (nombre, fechas, adultos, ninos, motivo), sin importar el orden, formato, o si vienen juntos o separados, incluso si van despues de palabras como "nombre completo:" o "correo:". Nunca vuelvas a pedir un dato que el cliente ya te dio en cualquier mensaje anterior de la conversacion, y nunca digas que no lo recibiste si ya esta en el historial.

FLUJO: saluda, pregunta que necesita, recoge nombre/fechas DD-MM-AAAA/adultos/ninos/motivo de forma natural, calcula noches y total, presenta cotizacion, si acepta manda datos bancarios y pide comprobante.`;

app.get("/", (req, res) => res.json({ status: "ok", agente: "Canto" }));

app.post("/webhook", async (req, res) => {
  const { phoneNumber, message } = req.body;
  if (!phoneNumber || !message) return res.status(400).json({ error: "phoneNumber y message requeridos" });

  db.get("SELECT messages FROM conversations WHERE id = ?", [phoneNumber], async (err, row) => {
    let history = row ? JSON.parse(row.messages) : [];
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
      
      db.run("INSERT OR REPLACE INTO conversations (id, messages, updated_at) VALUES (?, ?, datetime('now'))", 
        [phoneNumber, JSON.stringify(history)]);
      
      res.json({ response: reply });
    } catch (error) {
      console.error(error);
      res.status(500).json({ error: error.message });
    }
  });
});

app.use((err, req, res, next) => {
  if (err.type === "entity.parse.failed") return res.status(200).json({ response: "No entendi bien ese mensaje, me lo repites?" });
  next(err);
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Agente Canto en puerto ${PORT}`));
