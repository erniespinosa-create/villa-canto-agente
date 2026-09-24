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
const sheets = google.sheets({ version: "v4", auth });
const SHEET_ID = process.env.SHEET_ID;

// Bitacora: agrega un renglon a la hoja "Reservas" de Google Sheets
async function bitacora(estado, d) {
  if (!SHEET_ID) return;
  try {
    const hoy = new Date().toLocaleString("es-MX", { timeZone: "America/Mexico_City" });
    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: "Reservas!A:K",
      valueInputOption: "USER_ENTERED",
      resource: { values: [[hoy, estado, d.nombre || "", d.telefono || "", d.llegada || "", d.salida || "", d.adultos ?? "", d.ninos ?? "", d.motivo || "", d.total ?? "", d.eventoId || ""]] },
    });
  } catch (e) {
    console.error("Bitacora:", e.message);
  }
}

// "22/09/2026" o "22-09-2026" -> "2026-09-22"
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
  if (Number(datos.adultos) > 15 || Number(datos.ninos || 0) > 2) return { excedido: true };
  const { disponible } = await consultarDisponibilidad(datos.llegada, datos.salida);
  if (!disponible) return { ocupado: true };
  const evento = await calendar.events.insert({
    calendarId: CALENDAR_ID,
    resource: {
      summary: `⏳ PENDIENTE - ${datos.nombre}`,
      colorId: "8",
      extendedProperties: { private: { contacto: String(datos.contacto || ""), telefono: String(datos.telefono || ""), estado: "pendiente" } },
      description: `Adultos: ${datos.adultos}\nNinos: ${datos.ninos || 0}\nMotivo: ${datos.motivo || "-"}\nTelefono: ${datos.telefono || "-"}`,
      start: { dateTime: `${aISO(datos.llegada)}T13:00:00`, timeZone: "America/Mexico_City" },
      end: { dateTime: `${aISO(datos.salida)}T12:00:00`, timeZone: "America/Mexico_City" },
    },
  });
  return { ocupado: false, id: evento.data.id };
}

async function confirmarReservas(contacto) {
  const r = await calendar.events.list({
    calendarId: CALENDAR_ID,
    privateExtendedProperty: [`contacto=${contacto}`, "estado=pendiente"],
    singleEvents: true,
  });
  const pendientes = (r.data.items || []).filter(e => e.status !== "cancelled");
  for (const e of pendientes) {
    await calendar.events.patch({
      calendarId: CALENDAR_ID,
      eventId: e.id,
      resource: {
        summary: e.summary.replace("⏳ PENDIENTE", "✅ CONFIRMADA"),
        colorId: "5",
        extendedProperties: { private: { ...(e.extendedProperties?.private || {}), estado: "confirmada" } },
      },
    });
    const p = e.extendedProperties?.private || {};
    const fmt = s => (s || "").slice(0, 10).split("-").reverse().join("/");
    await bitacora("Confirmada", { nombre: e.summary.replace(/^.*?-\s*/, ""), telefono: p.telefono, llegada: fmt(e.start.dateTime || e.start.date), salida: fmt(e.end.dateTime || e.end.date), eventoId: e.id });
    console.log("Reserva confirmada en Calendar:", e.id);
  }
  return pendientes.length;
}

// Mensaje post-estancia: 24 h despues del check-out dispara un flujo de ManyChat (plantilla de WhatsApp)
async function enviarPostEstancia() {
  if (!process.env.MANYCHAT_API_KEY || !process.env.MANYCHAT_FLOW_RESENA) return;
  const ahora = Date.now();
  const r = await calendar.events.list({
    calendarId: CALENDAR_ID,
    timeMin: new Date(ahora - 5 * 86400000).toISOString(),
    timeMax: new Date(ahora - 86400000).toISOString(),
    privateExtendedProperty: ["estado=confirmada"],
    singleEvents: true,
  });
  for (const e of r.data.items || []) {
    const p = e.extendedProperties?.private || {};
    const fin = new Date(e.end.dateTime || e.end.date).getTime();
    if (p.resena === "enviada" || !p.contacto || ahora - fin < 86400000) continue;
    try {
      const resp = await fetch("https://api.manychat.com/fb/sending/sendFlow", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.MANYCHAT_API_KEY}` },
        body: JSON.stringify({ subscriber_id: p.contacto, flow_ns: process.env.MANYCHAT_FLOW_RESENA }),
      });
      const data = await resp.json();
      if (data.status !== "success") { console.error("ManyChat post-estancia:", JSON.stringify(data)); continue; }
      await calendar.events.patch({
        calendarId: CALENDAR_ID,
        eventId: e.id,
        resource: { extendedProperties: { private: { ...p, resena: "enviada" } } },
      });
      console.log("Mensaje post-estancia enviado:", e.summary);
    } catch (err) {
      console.error("Error post-estancia:", err.message);
    }
  }
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
  {
    name: "consultar_mis_reservas",
    description: "Devuelve las reservas vigentes de ESTE cliente segun el calendario real. Usala siempre que el cliente mencione su reserva, su pago, o antes de decir que ya tiene algo apartado.",
    input_schema: { type: "object", properties: {} },
  },
];

async function reservasDelCliente(contacto) {
  const r = await calendar.events.list({
    calendarId: CALENDAR_ID,
    privateExtendedProperty: [`contacto=${contacto}`],
    timeMin: new Date(Date.now() - 86400000).toISOString(),
    singleEvents: true,
  });
  const fmt = s => (s || "").slice(0, 10).split("-").reverse().join("/");
  return (r.data.items || []).filter(e => e.status !== "cancelled").map(e => ({
    llegada: fmt(e.start.dateTime || e.start.date),
    salida: fmt(e.end.dateTime || e.end.date),
    estado: e.extendedProperties?.private?.estado || "pendiente",
  }));
}

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
- Capacidad: 15 adultos + 2 ninos maximo (17 personas en total). ES UN LIMITE ESTRICTO: si el cliente pide mas adultos o mas ninos, dile con calidez que la capacidad maxima es de 15 adultos y 2 ninos, y pregunta si pueden ajustar el grupo. Nunca cotices ni apartes por encima de ese limite.
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
- Link del contrato para firma digital: https://docuseal.com/d/Y33pXN36zBKUXo (solo mandalo cuando el pago ya este confirmado, o si el cliente lo pide despues de apartar)
- Nunca pidas correo electronico

TONO: calido, pausado, conversacional. Emojis ocasionales. Nunca robotico.

LONGITUD: estas en WhatsApp. Responde CORTO, maximo 4-6 lineas por mensaje, como una persona. No mandes toda la informacion de golpe; da solo lo que pregunto y ofrece mas si lo quiere. Si el cliente pide "toda la informacion", da un resumen breve (ubicacion, capacidad, servicios, tarifas) en maximo 10 lineas, sin listar cada habitacion a menos que la pida. FORMATO WHATSAPP: para negritas usa UN solo asterisco (*texto*), nunca dos; no uses #, ni tablas.

EXTRACCION DE DATOS: el cliente puede darte varios datos en un solo mensaje o uno por uno. Lee todo el mensaje y extrae nombre, fechas, adultos, ninos y motivo sin importar el orden o formato. Nunca vuelvas a pedir un dato que ya te dio. SIEMPRE responde algo a cada mensaje.

FLUJO: saluda, pregunta que necesita, recoge nombre/fechas/adultos/ninos/motivo de forma natural, consulta disponibilidad, calcula noches y total, presenta cotizacion, si acepta manda datos bancarios y pide que envie la foto de su comprobante por este chat y que despues escriba "listo" para avisarte. Si el cliente escribe "listo" (o similar) despues de los datos bancarios, tomalo como aviso de pago.

NO SEAS INSISTENTE: si el cliente solo esta preguntando (fotos, servicios, ubicacion, habitaciones, precios, paquetes, horarios), responde su pregunta y ya. NO termines cada mensaje preguntando por fechas o si quiere reservar. Maximo menciona la reserva UNA vez en toda la conversacion, de forma suave, y solo despues de haber resuelto varias dudas. Si el cliente ya dijo que solo esta viendo o que despues te avisa, no vuelvas a ofrecer reservar a menos que el lo pida. Deja que el cliente lleve el ritmo, como lo haria un buen anfitrion.

CUANDO el cliente confirme que quiere reservar (y ya consultaste disponibilidad y esta libre), agrega al FINAL de tu respuesta, en su propia linea, exactamente esto (el cliente no lo vera):
RESERVA_JSON:{"nombre":"...","llegada":"DD/MM/AAAA","salida":"DD/MM/AAAA","adultos":N,"ninos":N,"motivo":"...","total":N}
Solo UNA vez por cada reserva confirmada (no la repitas si solo estan platicando de la misma reserva).

EL CALENDARIO MANDA: lo que se hablo antes en esta conversacion puede estar desactualizado (el administrador puede cancelar o borrar reservas). Antes de decir que el cliente ya tiene una reserva, o si pregunta por su reserva o su pago, usa consultar_mis_reservas y confia SOLO en ese resultado. Si ahi no aparece, NO la tiene: tratala como reserva nueva (consulta disponibilidad, cotiza y genera un nuevo RESERVA_JSON cuando confirme). Nunca digas "ya la tenemos registrada" sin haberlo consultado.

VARIAS RESERVAS: un mismo cliente puede hacer mas de una reserva. Si dice que quiere una reserva NUEVA u OTRA, o da fechas distintas a las de una reserva anterior, tratala como reserva nueva: pregunta las fechas y datos que falten (puedes reutilizar su nombre), consulta disponibilidad, cotiza y, cuando confirme, agrega un NUEVO RESERVA_JSON con las nuevas fechas. Nunca digas "ya la tenemos registrada" si las fechas son distintas.

AVISO DE PAGO: si el cliente dice que ya deposito, ya pago, ya transfirio, o manda su comprobante, agradecele con calidez, dile que en breve confirmamos el pago, y agrega al FINAL de tu respuesta, en su propia linea, exactamente: AVISO_PAGO (el cliente no lo vera).

FOTOS: si el cliente pide fotos, imagenes, ver la casa, las habitaciones o la alberca, responde con calidez algo breve como "¡Claro! Te comparto algunas fotos de la villa 📸" y agrega al FINAL de tu respuesta, en su propia linea, exactamente: ENVIAR_FOTOS (el cliente no lo vera). Las fotos se envian automaticamente; no digas que no puedes mandar fotos.

MENSAJES DEL SISTEMA: si recibes un mensaje que empieza con [SISTEMA] PAGO_CONFIRMADO, no lo escribio el cliente: significa que el administrador ya verifico el deposito. Escribele al cliente con calidez que su pago fue recibido y su reserva esta confirmada, mandale el link del contrato para que lo llene y firme desde su celular (https://docuseal.com/d/Y33pXN36zBKUXo), recuerdale que use los mismos datos de la cotizacion (fechas, noches, huespedes y montos), pidele una foto de su INE por este chat, y dale los datos de llegada (direccion, check-in 13:00, check-out 12:00, contacto David 33 1769 2871). Nunca menciones la palabra SISTEMA.`;
}

async function responderConClaude(history, contacto) {
  const msgs = history.map(m => ({ role: m.role, content: m.content }));
  for (let i = 0; i < 4; i++) {
    const response = await client.messages.create({
      model: "claude-sonnet-5",
      max_tokens: 900,
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
        if (b.name === "consultar_mis_reservas") {
          const lista = await reservasDelCliente(contacto);
          out = { reservas: lista, nota: lista.length ? "Estas son sus unicas reservas vigentes" : "No tiene reservas vigentes (si hablaron de una antes, fue cancelada)" };
          console.log("Reservas de", contacto, ":", lista.length);
        } else {
          out = await consultarDisponibilidad(b.input.llegada, b.input.salida);
          console.log("Disponibilidad", b.input.llegada, "-", b.input.salida, out.disponible ? "LIBRE" : "OCUPADO");
        }
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

app.get("/privacidad", (req, res) => res.send(`<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Aviso de privacidad - Villa de Canto</title></head>
<body style="font-family:Arial,sans-serif;max-width:720px;margin:40px auto;padding:0 20px;line-height:1.6;color:#201e1d">
<h1>Aviso de privacidad</h1>
<p><b>Villa de Canto</b>, Boulevard Rodolfo Gaona 106, Campestre Amazcala, El Marqués, Querétaro, es responsable del tratamiento de los datos personales que nos compartes por WhatsApp.</p>
<h2>Datos que recabamos</h2>
<p>Nombre, teléfono, fechas de estancia, número de huéspedes, motivo de la visita, comprobante de pago e identificación oficial.</p>
<h2>Para qué los usamos</h2>
<p>Únicamente para cotizar, apartar y administrar tu reservación, emitir el contrato de arrendamiento y comunicarnos contigo sobre tu estancia. Tu reservación se registra en nuestro calendario y bitácora internos de Google.</p>
<h2>Con quién los compartimos</h2>
<p>No vendemos ni compartimos tus datos con terceros, salvo los proveedores tecnológicos necesarios para operar el servicio (WhatsApp, Google y el servicio de firma digital) o cuando la ley lo requiera.</p>
<h2>Tus derechos</h2>
<p>Puedes solicitar el acceso, rectificación, cancelación u oposición al uso de tus datos (derechos ARCO) escribiéndonos por WhatsApp.</p>
<p style="color:#666">Última actualización: septiembre 2026</p>
</body></html>`));

app.post("/webhook", (req, res) => {
  const { phoneNumber, telefono } = req.body || {};
  let { message } = req.body || {};
  if (message && /^https?:\/\/\S+$/i.test(String(message).trim())) {
    message = "[El cliente envio una imagen. Si ya le diste los datos bancarios, es su comprobante de pago]";
  }
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
      const reply = await responderConClaude(history, phoneNumber);
      let mensajeCliente = reply;
      const match = reply.match(/RESERVA_JSON:(\{.*\})/);
      if (match) {
        mensajeCliente = reply.replace(match[0], "").trim();
        try {
          const datos = JSON.parse(match[1]);
          datos.contacto = phoneNumber;
          datos.telefono = (telefono && !String(telefono).includes("{{")) ? telefono : phoneNumber;
          const r = await crearEventoCalendar(datos);
          if (r.excedido) {
            mensajeCliente += "\n\nAntes de apartar, una aclaracion 🙏 la villa tiene capacidad maxima de 15 adultos y 2 ninos. ¿Podemos ajustar el numero de personas?";
          } else if (r.ocupado) {
            mensajeCliente += "\n\nAy, justo acabo de revisar y esas fechas se acaban de ocupar 😔 ¿Buscamos otras fechas cercanas?";
          } else {
            console.log("Evento creado en Calendar:", r.id);
            await bitacora("Pendiente de pago", { ...datos, eventoId: r.id });
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
        await bitacora("Aviso de pago", { telefono: (telefono && !String(telefono).includes("{{")) ? telefono : phoneNumber });
      }
      let enviarFotos = "no";
      if (mensajeCliente.includes("ENVIAR_FOTOS")) {
        enviarFotos = "si";
        mensajeCliente = mensajeCliente.replace(/ENVIAR_FOTOS/g, "").trim();
        console.log("FOTOS solicitadas por", phoneNumber);
      }
      mensajeCliente = mensajeCliente.replace(/\*\*(.+?)\*\*/g, "*$1*").replace(/^#+\s*/gm, "");
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
const server = app.listen(PORT, () => console.log(`Agente Canto en puerto ${PORT}`));
setInterval(() => enviarPostEstancia().catch(e => console.error("Post-estancia:", e.message)), 60 * 60 * 1000);
setTimeout(() => enviarPostEstancia().catch(e => console.error("Post-estancia:", e.message)), 30000);
process.on("SIGTERM", () => {
  console.log("Apagando para nueva version...");
  server.close(() => db.close(() => process.exit(0)));
  setTimeout(() => process.exit(0), 5000);
});
