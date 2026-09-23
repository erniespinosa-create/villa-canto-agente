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
if (process.env.GOOGLE_REFRESH_TOKEN) auth.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
const calendar = google.calendar({ version: "v3", auth });
const CALENDAR_ID = process.env.CALENDAR_ID;

function aISO(fecha) {
  const [d, m, a] = String(fecha).trim().split(/[\/\-\.]/);
  return `${a}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
}

async function consultarDisponibilidad(llegada, salida) {
  const r = await calendar.events.list({
    calendarId: CALENDAR_ID,
    timeMin: `${aISO(llegada)}T13:00:00-06:00`,
    timeMax: `${aISO(salida)}T12:00:00-06:00`,
    singleEvents: true,
  });
  const ocupados = (r.data.items || []).filter(e => e.status !== "cancelled");
  return { disponible: ocupados.length === 0 };
}

async function crearEventoCalendar(datos) {
  const { disponible } = await consultarDisponibilidad(datos.llegada, datos.salida);
  if (!disponible) return { ocupado: true };
  const evento = await calendar.events.insert({
    calendarId: CALENDAR_ID,
    resource: {
      summary: `⏳ PENDIENTE - ${datos.nombre}`,
      colorId: "5",
      extendedProperties: { private: { telefono: String(datos.telefono || ""), estado: "pendiente" } },
      description: `Adultos: ${datos.adultos}\nNinos: ${datos.ninos || 0}\nMotivo: ${datos.motivo || "-"}\nTelefono: ${datos.telefono || "-"}`,
      start: { dateTime: `${aISO(datos.llegada)}T13:00:00`, timeZone: "America/Mexico_City" },
      end: { dateTime: `${aISO(datos.salida)}T12:00:00`, timeZone: "America/Mexico_City" },
    },
  });
  return { ocupado: false, id: evento.data.id };
}

async function confirmarReservas(telefono) {
  const r = await calendar.events.list({
    calendarId: CALENDAR_ID,
    privateExtendedProperty: [`telefono=${telefono}`, "estado=pendiente"],
    singleEvents: true,
  });
  const pendientes = (r.data.items || []).filter(e => e.status !== "cancelled");
  for (const e of pendientes) {
    await calendar.events.patch({
      calendarId: CALENDAR_ID,
      eventId: e.id,
      resource: {
        summary: e.summary.replace("⏳ PENDIENTE", "✅ CONFIRMADA"),
        colorId: "10",
        extendedProperties: { private: { telefono: String(telefono), estado: "confirmada" } },
      },
    });
    console.log("Reserva confirmada en Calendar:", e.id);
  }
  return pendientes.length;
}
const TOOLS = [
  {
    name: "consultar_disponibilidad",
    description: "Revisa en el calendario si la villa esta libre entre la fecha de llegada y la de salida. Usala SIEMPRE en cuanto tengas ambas fechas, antes de cotizar.",
    input_schema: {
      type: "object",
      properties: {
        llegada: { type: "string", description: "DD/MM/AAAA" },
        salida: { type: "string", description: "DD/MM/AAAA" },
      },
      required: ["llegada", "salida"],
    },
  },
];

const db = new sqlite3.Database(path.join(process.env.DB_DIR || "/tmp", "conversations.db"));
db.run(`CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  messages TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
)`);

function hoyMexico() {
  return new Date().toLocaleDateString("es-MX", { timeZone: "America/Mexico_City", day: "2-digit", month: "2-digit", year: "numeric", weekday: "long" });
}
function systemPrompt() {
  return `Eres Canto, el asistente de Villa de Canto en Amazcala, El Marques, Queretaro.

FECHA DE HOY: ${hoyMexico()} (usa esto para resolver "manana", "el viernes", "este fin de semana", etc. sin preguntar)

FORMATO DE FECHAS: El cliente puede escribir fechas de cualquier forma (22/09/2026, 22-09-2026, "22 de septiembre", "manana", "el viernes que entra"). Acepta y entiende cualquier formato, nunca rechaces una fecha por su formato.

NUNCA INVENTES DATOS: usa solo lo que el cliente escribio literalmente. Si dice "2 adultos" y no menciona ninos, pregunta "¿van ninos?" o asume 0; jamas agregues personas, fechas o motivos que no dijo.

DISPONIBILIDAD: en cuanto tengas fecha de llegada y de salida, usa la herramienta consultar_disponibilidad ANTES de cotizar. Si no esta disponible, dilo con calidez y ofrece buscar otras fechas. Nunca digas que hay disponibilidad sin haberla consultado.

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

PAQUETES ADICIONALES (se cotizan aparte de la renta):
- Cumpleanos: decoracion del cuarto con globos, pastel con vela de bengala, decoracion de "Feliz Cumpleanos"
- Hay otros paquetes disponibles (bodas, aniversarios, eventos especiales, etc.)
Si preguntan por paquetes, confirma que existen y menciona el de cumpleanos como ejemplo. Los precios aun no estan definidos: dilo con naturalidad ("estamos por confirmar el costo de ese paquete, en breve te doy el numero exacto") sin inventar cifras ni remitir a otra persona.

TARIFAS POR NOCHE (cada noche se cobra segun el dia en que se duerme):
- Lunes a jueves y domingo: $10,500
- Viernes: $12,000
- Sabado: $14,000
Noches = dias entre llegada y salida (llegar martes y salir miercoles = 1 noche, la del martes).

PAGO:
- Anticipo 50% del total
- Banco Inbursa, CLABE 036680500511854406, Titular Villa de Canto
- Deposito en garantia $5,000 reembolsable 48h despues del checkout

REGLAS:
- No des descuentos
- Pide contrato firmado + INE al confirmar
- Nunca pidas correo electronico

TONO: calido, pausado, conversacional. Emojis ocasionales. Nunca robotico.

LONGITUD: estas en WhatsApp. Responde CORTO, maximo 4-6 lineas por mensaje, como una persona. No mandes toda la informacion de golpe; da solo lo que pregunto y ofrece mas si lo quiere.

EXTRACCION DE DATOS: el cliente puede darte varios datos en un solo mensaje o uno por uno. Lee todo el mensaje y extrae nombre, fechas, adultos, ninos y motivo sin importar el orden o formato. Nunca vuelvas a pedir un dato que ya te dio. SIEMPRE responde algo a cada mensaje.

FLUJO: saluda, pregunta que necesita, recoge nombre/fechas/adultos/ninos/motivo de forma natural, consulta disponibilidad, calcula noches y total, presenta cotizacion, si acepta manda datos bancarios y pide comprobante.

CUANDO el cliente confirme que quiere reservar (y ya consultaste disponibilidad y esta libre), agrega al FINAL de tu respuesta, en su propia linea, exactamente esto (el cliente no lo vera):
RESERVA_JSON:{"nombre":"...","llegada":"DD/MM/AAAA","salida":"DD/MM/AAAA","adultos":N,"ninos":N,"motivo":"..."}
Solo UNA vez por cada reserva confirmada (no la repitas si solo estan platicando de la misma reserva).

VARIAS RESERVAS: un mismo cliente puede hacer mas de una reserva. Si dice que quiere una reserva NUEVA u OTRA, o da fechas distintas a las de una reserva anterior, tratala como reserva nueva: pregunta las fechas y datos que falten (puedes reutilizar su nombre), consulta disponibilidad, cotiza y, cuando confirme, agrega un NUEVO RESERVA_JSON con las nuevas fechas. Nunca digas "ya la tenemos registrada" si las fechas son distintas.

AVISO DE PAGO: si el cliente dice que ya deposito, ya pago, ya transfirio, o manda su comprobante, agradecele con calidez, dile que en breve confirmamos el pago, y agrega al FINAL de tu respuesta, en su propia linea, exactamente: AVISO_PAGO (el cliente no lo vera).

FOTOS: si el cliente pide fotos, imagenes, ver la casa, las habitaciones o la alberca, responde con calidez algo breve como "¡Claro! Te comparto algunas fotos de la villa 📸" y agrega al FINAL de tu respuesta, en su propia linea, exactamente: ENVIAR_FOTOS (el cliente no lo vera). Las fotos se envian automaticamente; no digas que no puedes mandar fotos.

MENSAJES DEL SISTEMA: si recibes un mensaje que empieza con [SISTEMA] PAGO_CONFIRMADO, no lo escribio el cliente: significa que el administrador ya verifico el deposito. Escribele al cliente con calidez que su pago fue recibido y su reserva esta confirmada, pidele el contrato firmado y una foto de su INE, y dale los datos de llegada (direccion, check-in 13:00, check-out 12:00, contacto David 33 1769 2871). Nunca menciones la palabra SISTEMA.`;
}
PARTE 4 de 4: Claude y webhook

async function responderConClaude(history) {
  const msgs = history.map(m => ({ role: m.role, content: m.content }));
  for (let i = 0; i < 4; i++) {
    const response = await client.messages.create({
      model: "claude-sonnet-5",
      max_tokens: 450,
      thinking: { type: "disabled" },
      system: systemPrompt(),
      tools: TOOLS,
      messages: msgs,
    });
    if (response.stop_reason !== "tool_use") {
      return response.content.filter(b => b.type === "text").map(b => b.text).join("\n");
    }
    msgs.push({ role: "assistant", content: response.content });
    const resultados = [];
    for (const b of response.content) {
      if (b.type !== "tool_use") continue;
      let out;
      try {
        out = await consultarDisponibilidad(b.input.llegada, b.input.salida);
        console.log("Disponibilidad", b.input.llegada, "-", b.input.salida, out.disponible ? "LIBRE" : "OCUPADO");
      } catch (e) {
        console.error("Error consultando disponibilidad:", e.message);
        out = { error: "No se pudo consultar el calendario, dile al cliente que confirmaras la disponibilidad en breve" };
      }
      resultados.push({ type: "tool_result", tool_use_id: b.id, content: JSON.stringify(out) });
    }
    msgs.push({ role: "user", content: resultados });
  }
  return "Dame un momento, estoy revisando la disponibilidad y te confirmo enseguida 😊";
}

app.get("/", (req, res) => res.json({ status: "ok", agente: "Canto" }));

app.post("/webhook", (req, res) => {
  const { phoneNumber, message } = req.body || {};
  if (!phoneNumber || !message) return res.status(400).json({ error: "phoneNumber y message requeridos" });

  db.get("SELECT messages FROM conversations WHERE id = ?", [phoneNumber], async (err, row) => {
    let history = row ? JSON.parse(row.messages) : [];
    history.push({ role: "user", content: String(message) });

    try {
      if (String(message).startsWith("[SISTEMA] PAGO_CONFIRMADO")) {
        try {
          const n = await confirmarReservas(phoneNumber);
          if (n === 0) console.log("No habia reservas pendientes para", phoneNumber);
        } catch (e) {
          console.error("Error confirmando reserva en Calendar:", e.message);
        }
      }
      const reply = await responderConClaude(history);
      let mensajeCliente = reply;
      const match = reply.match(/RESERVA_JSON:(\{.*\})/);
      if (match) {
        mensajeCliente = reply.replace(match[0], "").trim();
        try {
          const datos = JSON.parse(match[1]);
          datos.telefono = phoneNumber;
          const r = await crearEventoCalendar(datos);
          if (r.ocupado) {
            mensajeCliente += "\n\nAy, justo acabo de revisar y esas fechas se acaban de ocupar 😔 ¿Buscamos otras fechas cercanas?";
          } else {
            console.log("Evento creado en Calendar:", r.id);
          }
        } catch (e) {
          console.error("Error creando evento de Calendar:", e.message);
        }
      }
      let avisoPago = "no";
      if (mensajeCliente.includes("AVISO_PAGO")) {
        avisoPago = "si";
        mensajeCliente = mensajeCliente.replace(/AVISO_PAGO/g, "").trim();
        console.log("AVISO DE PAGO de", phoneNumber);
      }
      let enviarFotos = "no";
      if (mensajeCliente.includes("ENVIAR_FOTOS")) {
        enviarFotos = "si";
        mensajeCliente = mensajeCliente.replace(/ENVIAR_FOTOS/g, "").trim();
        console.log("FOTOS solicitadas por", phoneNumber);
      }
      if (!mensajeCliente.trim()) mensajeCliente = "Perfecto, ya quedo anotado 😊 ¿Algo mas en lo que te pueda ayudar?";

      history.push({ role: "assistant", content: reply });
      if (history.length > 20) history.splice(0, history.length - 20);
      while (history.length && history[0].role !== "user") history.shift();
      db.run("INSERT OR REPLACE INTO conversations (id, messages, updated_at) VALUES (?, ?, datetime('now'))",
        [phoneNumber, JSON.stringify(history)]);

      res.json({ response: mensajeCliente, avisoPago, enviarFotos });
    } catch (error) {
      console.error(error);
      res.status(200).json({ response: "Perdón, tuve un pequeño problema técnico 🙏 ¿Me repites tu último mensaje?" });
    }
  });
});

app.use((err, req, res, next) => {
  if (err.type === "entity.parse.failed") return res.status(200).json({ response: "No entendí bien ese mensaje, ¿me lo repites?" });
  next(err);
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Agente Canto en puerto ${PORT}`));
