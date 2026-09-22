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
if (process.env.GOOGLE_REFRESH_TOKEN) auth.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });

async function hayDisponibilidad(llegada, salida) {
  const [dl, ml, al] = llegada.split("/");
  const [ds, ms, as] = salida.split("/");
  const start = new Date(al, ml - 1, dl, 0, 0, 0);
  const end = new Date(as, ms - 1, ds, 23, 59, 59);
  const existentes = await calendar.events.list({
    calendarId: CALENDAR_ID, timeMin: start.toISOString(), timeMax: end.toISOString(),
  });
  return !(existentes.data.items && existentes.data.items.length > 0);
}

async function crearEventoCalendar(datos) {
  const [dl, ml, al] = datos.llegada.split("/");
  const [ds, ms, as] = datos.salida.split("/");
  const start = new Date(al, ml - 1, dl, 13, 0, 0);
  const end = new Date(as, ms - 1, ds, 12, 0, 0);
  const existentes = await calendar.events.list({
    calendarId: CALENDAR_ID, timeMin: start.toISOString(), timeMax: end.toISOString(), q: datos.nombre,
  });
  if (existentes.data.items && existentes.data.items.length > 0) return { duplicado: true };
  const evento = await calendar.events.insert({
    calendarId: CALENDAR_ID,
    resource: {
      summary: `Reserva - ${datos.nombre}`,
      description: `Adultos: ${datos.adultos}\nNinos: ${datos.ninos || 0}\nMotivo: ${datos.motivo || "-"}`,
      start: { dateTime: start.toISOString(), timeZone: "America/Mexico_City" },
      end: { dateTime: end.toISOString(), timeZone: "America/Mexico_City" },
    },
  });
  return { duplicado: false, id: evento.data.id };
}

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

FORMATO DE FECHAS: El cliente puede escribir fechas de cualquier forma (22/09/2026, 22-09-2026, "22 de septiembre", "manana", "el viernes que entra"). Acepta y entiende cualquier formato, nunca rechaces una fecha por su formato ni pidas que la repita en un formato especifico.NUNCA INVENTES DATOS: usa solo lo que el cliente escribio literalmente. Si dice "2 adultos" y no menciona ninos, pregunta "¿van ninos?" o asume 0; jamas agregues personas, fechas o motivos que no dijo.

FECHAS - CONFIRMA SIEMPRE: cuando el cliente te de una fecha, repitela con el dia de la semana para confirmar (ej: "entonces llegan el sabado 26/09/2026, ¿verdad?"). Si es ambigua, pregunta dia y mes en numeros.

LONGITUD: estas en WhatsApp. Responde CORTO, maximo 4-6 lineas por mensaje, como una persona. No mandes toda la informacion de golpe; da solo lo que pregunto y ofrece mas si lo quiere.

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

EXTRACCION DE DATOS: El cliente puede darte varios datos juntos en un solo mensaje (separados por comas, saltos de linea, o mezclados en una frase) o uno por uno en mensajes distintos. Lee TODO el mensaje completo con cuidado antes de responder y extrae cada dato que encuentres (nombre, fechas, adultos, ninos, motivo), sin importar el orden, formato, o si vienen juntos o separados, incluso si van despues de palabras como "nombre completo:" o "correo:". Nunca vuelvas a pedir un dato que el cliente ya te dio en cualquier mensaje anterior de la conversacion, y nunca digas que no lo recibiste si ya esta en el historial. SIEMPRE responde algo despues de recibir cualquier mensaje del cliente, aunque sea solo confirmar el dato recibido (ej: "Perfecto, ya tengo tu nombre completo, [nombre]. Ahora dime..."); nunca dejes un mensaje sin respuesta.

FECHAS - CONFIRMA SIEMPRE: cuando el cliente te de una fecha, antes de seguir, repitela de vuelta con el dia de la semana para confirmar que la entendiste bien (ej: "entonces llegan el sabado 26/09/2026, ¿verdad?"). Si la fecha es ambigua o no puedes resolverla con certeza, pregunta el dia y mes exactos en numeros.

FLUJO: saluda, pregunta que necesita, recoge nombre/fechas DD-MM-AAAA/adultos/ninos/motivo de forma natural, calcula noches y total, presenta cotizacion, si acepta manda datos bancarios y pide comprobante.

CUANDO TENGAS nombre, fecha de llegada, fecha de salida y numero de adultos completos y el cliente haya confirmado que quiere reservar, agrega al FINAL de tu respuesta, en su propia linea, exactamente esto (el cliente no lo vera, se procesa aparte):
RESERVA_JSON:{"nombre":"...","llegada":"DD/MM/AAAA","salida":"DD/MM/AAAA","adultos":N,"ninos":N,"motivo":"..."}
Solo agrega esa linea UNA vez por reserva confirmada, no la repitas en mensajes posteriores de la misma conversacion.`;

app.get("/", (req, res) => res.json({ status: "ok", agente: "Canto" }));

app.post("/webhook", async (req, res) => {
  const { phoneNumber, message } = req.body;
  if (!phoneNumber || !message) return res.status(400).json({ error: "phoneNumber y message requeridos" });

  db.get("SELECT messages FROM conversations WHERE id = ?", [phoneNumber], async (err, row) => {
    let history = row ? JSON.parse(row.messages) : [];
    history.push({ role: "user", content: message });

    try {
      const response = await client.messages.create({
        model: "claude-sonnet-4-5",
        max_tokens: 1024,
        system: SYSTEM_PROMPT,
        messages: history,
      });
      const reply = response.content.filter(b => b.type === "text").map(b => b.text).join("\n");
      let mensajeCliente = reply;
      const match = reply.match(/RESERVA_JSON:(\{.*\})/);
      if (match) {
        mensajeCliente = reply.replace(match[0], "").trim();
        try {
          const datosReserva = JSON.parse(match[1]);
          const libre = await hayDisponibilidad(datosReserva.llegada, datosReserva.salida);
          if (!libre) {
            mensajeCliente = mensajeCliente.replace(/\n?$/, "") + "\n\nAy, justo revisé y esas fechas ya estan ocupadas 😔 ¿Quieres que busquemos otras fechas cercanas?";
          } else {
            const resultado = await crearEventoCalendar(datosReserva);
            if (resultado.duplicado) console.log("Reserva duplicada, no se creo evento:", datosReserva.nombre);
            else console.log("Evento creado en Calendar:", resultado.id);
          }
        } catch (e) {
          console.error("Error creando evento de Calendar:", e.message);
        }
      }
      if (!mensajeCliente || !mensajeCliente.trim()) {
        mensajeCliente = "Perfecto, ya quedo anotado. ¿Algo mas en lo que te pueda ayudar?";
      }
      history.push({ role: "assistant", content: reply });
      if (history.length > 20) history.splice(0, history.length - 20);
      
      db.run("INSERT OR REPLACE INTO conversations (id, messages, updated_at) VALUES (?, ?, datetime('now'))", 
        [phoneNumber, JSON.stringify(history)]);
      
      res.json({ response: mensajeCliente });
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
