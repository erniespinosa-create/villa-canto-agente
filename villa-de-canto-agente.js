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
      resource: { values: [[hoy, estado, d.nombre || "", d.telefono || "", d.llegada || "", d.salida || "", d.adultos ?? "", d.ninos ?? "", (d.motivo || "") + (d.paquetes ? ` · Paquetes: ${d.paquetes}` : ""), d.total ?? "", d.eventoId || ""]] },
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

async function consultarUnaVez(llegada, salida) {
  const r = await calendar.events.list({
    calendarId: CALENDAR_ID,
    timeMin: `${aISO(llegada)}T13:00:00-06:00`,
    timeMax: `${aISO(salida)}T12:00:00-06:00`,
    singleEvents: true,
  });
  const ocupados = (r.data.items || []).filter(e => e.status !== "cancelled");
  return { disponible: ocupados.length === 0, eventos: ocupados };
}

// Doble verificacion: consulta el calendario 2 veces (con 1.5 s de pausa); si alguna dice ocupado, esta ocupado
async function consultarDisponibilidad(llegada, salida) {
  const v1 = await consultarUnaVez(llegada, salida);
  await new Promise(r => setTimeout(r, 1500));
  const v2 = await consultarUnaVez(llegada, salida);
  const disponible = v1.disponible && v2.disponible;
  console.log("Doble verificacion", llegada, "-", salida, "| 1:", v1.disponible ? "LIBRE" : "OCUPADO", "| 2:", v2.disponible ? "LIBRE" : "OCUPADO");
  return { disponible };
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
      description: `Adultos: ${datos.adultos}\nNinos: ${datos.ninos || 0}\nMotivo: ${datos.motivo || "-"}\nPaquetes: ${datos.paquetes || "Ninguno"}\nTelefono: ${datos.telefono || "-"}`,
      start: { dateTime: `${aISO(datos.llegada)}T13:00:00`, timeZone: "America/Mexico_City" },
      end: { dateTime: `${aISO(datos.salida)}T12:00:00`, timeZone: "America/Mexico_City" },
    },
  });
  // Verificacion posterior: si otro evento se agendo al mismo tiempo, se borra este y se avisa ocupado
  const despues = await consultarUnaVez(datos.llegada, datos.salida);
  if (despues.eventos.some(e => e.id !== evento.data.id)) {
    await calendar.events.delete({ calendarId: CALENDAR_ID, eventId: evento.data.id });
    console.log("Choque de reservas detectado, evento revertido:", evento.data.id);
    return { ocupado: true };
  }
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

async function manychat(ruta, body) {
  const resp = await fetch("https://api.manychat.com/fb/sending/" + ruta, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.MANYCHAT_API_KEY}` },
    body: JSON.stringify(body),
  });
  return resp.json();
}
const textoWA = (subscriber_id, text) => manychat("sendContent", { subscriber_id, data: { version: "v2", content: { type: "whatsapp", messages: [{ type: "text", text }] } } });

// 1) Liberar reservas pendientes sin pago despues de HORAS_PENDIENTE (48 h por defecto)
async function liberarPendientes() {
  const horas = Number(process.env.HORAS_PENDIENTE || 48);
  const r = await calendar.events.list({ calendarId: CALENDAR_ID, privateExtendedProperty: ["estado=pendiente"], timeMin: new Date().toISOString(), singleEvents: true });
  for (const e of r.data.items || []) {
    if (Date.now() - new Date(e.created).getTime() < horas * 3600000) continue;
    const p = e.extendedProperties?.private || {};
    const fmt = s => (s || "").slice(0, 10).split("-").reverse().join("/");
    try {
      await calendar.events.delete({ calendarId: CALENDAR_ID, eventId: e.id });
      console.log("Reserva pendiente liberada:", e.summary);
      await bitacora("Liberada sin pago", { nombre: e.summary.replace(/^.*?-\s*/, ""), telefono: p.telefono, llegada: fmt(e.start.dateTime || e.start.date), salida: fmt(e.end.dateTime || e.end.date), eventoId: e.id });
      if (process.env.MANYCHAT_API_KEY && p.contacto) {
        const d = await textoWA(p.contacto, `Hola 🌿 Como no recibimos el anticipo, liberamos las fechas del ${fmt(e.start.dateTime || e.start.date)} al ${fmt(e.end.dateTime || e.end.date)}. Si aun te interesan, escribeme y reviso con gusto si siguen disponibles 😊`);
        if (d.status !== "success") console.log("Aviso de liberacion no enviado (fuera de 24 h):", JSON.stringify(d));
      }
    } catch (err) { console.error("Error liberando:", err.message); }
  }
}

// 5) Mensaje 1 dia antes de la llegada (plantilla de ManyChat)
async function enviarPreLlegada() {
  if (!process.env.MANYCHAT_API_KEY || !process.env.MANYCHAT_FLOW_LLEGADA) return;
  const ahora = Date.now();
  const r = await calendar.events.list({ calendarId: CALENDAR_ID, privateExtendedProperty: ["estado=confirmada"], timeMin: new Date(ahora).toISOString(), timeMax: new Date(ahora + 30 * 3600000).toISOString(), singleEvents: true });
  for (const e of r.data.items || []) {
    const p = e.extendedProperties?.private || {};
    if (p.prellegada === "enviada" || !p.contacto) continue;
    try {
      const d = await manychat("sendFlow", { subscriber_id: p.contacto, flow_ns: process.env.MANYCHAT_FLOW_LLEGADA });
      if (d.status !== "success") { console.error("Pre-llegada:", JSON.stringify(d)); continue; }
      await calendar.events.patch({ calendarId: CALENDAR_ID, eventId: e.id, resource: { extendedProperties: { private: { ...p, prellegada: "enviada" } } } });
      console.log("Mensaje pre-llegada enviado:", e.summary);
    } catch (err) { console.error("Error pre-llegada:", err.message); }
  }
}

// Recordatorio a los 5 dias: clientes que dejaron de contestar y no tienen reserva
async function enviarSeguimientos() {
  if (!process.env.MANYCHAT_API_KEY || !process.env.MANYCHAT_FLOW_SEGUIMIENTO) return;
  const filas = await new Promise(ok => db.all(
    `SELECT c.id, c.updated_at FROM conversations c LEFT JOIN seguimiento s ON s.id = c.id
     WHERE c.updated_at <= datetime('now','-5 days') AND c.updated_at > datetime('now','-10 days')
     AND (s.enviado_para IS NULL OR s.enviado_para <> c.updated_at)`, [], (e, r) => ok(e ? [] : r || [])));
  for (const f of filas) {
    try {
      const r = await calendar.events.list({ calendarId: CALENDAR_ID, privateExtendedProperty: [`contacto=${f.id}`], singleEvents: true, maxResults: 1 });
      const marcar = () => db.run("INSERT OR REPLACE INTO seguimiento (id, enviado_para) VALUES (?, ?)", [f.id, f.updated_at]);
      if ((r.data.items || []).length) { marcar(); continue; }
      const resp = await fetch("https://api.manychat.com/fb/sending/sendFlow", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.MANYCHAT_API_KEY}` },
        body: JSON.stringify({ subscriber_id: f.id, flow_ns: process.env.MANYCHAT_FLOW_SEGUIMIENTO }),
      });
      const data = await resp.json();
      if (data.status !== "success") { console.error("Seguimiento:", JSON.stringify(data)); continue; }
      marcar();
      console.log("Recordatorio 5 dias enviado a", f.id);
    } catch (err) { console.error("Error seguimiento:", err.message); }
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
db.run("CREATE TABLE IF NOT EXISTS seguimiento (id TEXT PRIMARY KEY, enviado_para TEXT)");
db.run("CREATE TABLE IF NOT EXISTS pausas (id TEXT PRIMARY KEY, hasta INTEGER)");
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
- Capacidad: 15 adultos + 2 ninos maximo (17 personas en total). ES UN LIMITE ESTRICTO: si el cliente pide mas adultos o mas ninos, dile con calidez que la capacidad regular es de 15 adultos y 2 ninos y que para grupos mas grandes el administrador de la villa le dara una atencion personalizada. ANTES DE TODO, si ya te dio fechas, usa consultar_disponibilidad: si estan OCUPADAS dile con calidez que esas fechas no estan disponibles, ofrece buscar otras y NO agregues PASAR_A_HUMANO (cuando te de fechas libres continuas). Si estan LIBRES, dile que si hay disponibilidad para esas fechas. Si aun no te da fechas, pideselas primero. Solo con fechas LIBRES preguntale con calidez cual es el plan o que tiene en mente (tipo de evento o celebracion, fechas y numero total de personas) y agrega al FINAL, en su propia linea, PASAR_A_HUMANO (el sistema esperara su respuesta antes de avisar al administrador). Nunca cotices ni apartes por encima de ese limite.
- Direccion: Boulevard Rodolfo Gaona 106, Campestre Amazcala
- Check-in 13:00 | Check-out 12:00
- Ubicacion en Google Maps: https://www.google.com/maps?q=20.6901757,-100.2620513
- Administrador de la villa: refierete a el SIEMPRE solo como "el administrador de la villa", nunca menciones su nombre ni des otro numero. Estara al pendiente durante la estancia.
- Contacto: si el cliente quiere hablar por telefono, o necesita comunicarse con el administrador (dudas, cambios, emergencias durante la estancia), dile con calidez que tiene dos opciones: llamar a este mismo numero (442 874 2383), o pedir por este chat hablar con una persona y el administrador de la villa se pondra en contacto lo antes posible. NUNCA des ningun otro numero de telefono. Si elige que lo contacten, usa PASAR_A_HUMANO.
- IMPORTANTE: si el cliente quiere que entren mas personas de las reservadas (o visitas), hacer check-in antes de las 13:00 o check-out despues de las 12:00, NO lo autorices ni lo niegues: dile con calidez que eso se tiene que verificar con el administrador de la villa, y dale su numero. No des su numero para nada mas, salvo el paquete de Carne Asada (reservas, precios y pagos los resuelves tu).

DISTRIBUCION DE HABITACIONES (5 habitaciones, todas con aire acondicionado):
1. Cama King Size + Sofa Cama Individual + bano completo
2. Litera con 2 camas Queen + cama individual + bano completo
3. Cama King Size + cama Individual + bano completo
4. Cama King Size + bano completo
5. 2 Camas Matrimoniales + medio bano

SERVICIOS: alberca climatizada 33-35C, horno de pizza, asador, gym, area de juegos, estacionamiento 4 autos, limpieza incluida.

PAQUETES ADICIONALES (se cobran aparte de la renta; se suman al total de la reserva si el cliente los quiere):
- Cumpleanos $1,500: recamara decorada con letrero "Feliz Cumpleanos" y globos en el techo, globos metalicos con los numeros de la edad en el color que elijan, pastel de Pizca de Azucar (mandamos 3 opciones de sabor) y bengala para la sorpresa.
- Fiesta Infantil $3,000 (cuando pregunten por este paquete o por las pinatas, agrega al FINAL de tu respuesta, en su propia linea, FOTOS_PINATAS y di algo breve como "Te comparto algunos modelos de pinatas 🎉 Y si los peques tienen un personaje favorito (superheroe, princesa, caricatura), dinos cual y te lo conseguimos 😊"; solo una vez por conversacion salvo que las pidan de nuevo): inflable instalado y encendido en el jardin a su llegada (3 opciones para elegir), pinata llena de dulces (3 modelos o el personaje favorito que pidan) y pastel de Pizca de Azucar (3 sabores, puede llevar mensaje o tematica).
- Guerra de Globos de Agua $1,500: dos tinas grandes con globos de agua ya inflados y el jardin como campo de batalla.
- Rocola y Karaoke $1,000: rocola durante toda la estancia, dos microfonos y canciones para todas las generaciones.
- Masaje Relajante a Domicilio $1,200 por persona: masajista profesional llega a la villa con camilla, aceites e insumos; atiende uno a uno a quien quiera. Cada sesion dura 60 minutos por persona.
- Musica en Vivo y DJ (por cotizar): grupo norteno, mariachi, banda o DJ; proveedores de confianza que ya conocen la villa. El precio depende de fecha, duracion y disponibilidad.
- Carne Asada con Anfitrion: el anfitrion hace las compras, tiene el carbon listo a su llegada y se queda a cargo del asador. Este paquete se ve directamente con el administrador de la villa: NO pidas datos ni des precio; explica con calidez que ese servicio lo coordina el administrador de la villa y pidele al cliente que se ponga en contacto con el al 442 874 2383 para que le comparta el precio y los detalles.
- Experiencia Chef Privada (por cotizar): chef profesional de un restaurante de Queretaro cocina en la villa, menu de autor o personalizado, insumos incluidos, servicio a la mesa con chef y mesero. Depende de comensales y menu.
PAQUETES POR COTIZAR (Musica en Vivo y DJ, Experiencia Chef Privada, y cualquiera sin precio): NO des precio ni rangos. Dile con calidez que le avisaras al administrador de la villa y el se pondra en contacto para darle una atencion mas personalizada y armarlo a su gusto. Anotalo en "paquetes" de la reserva con "(por cotizar)".
COMO OFRECERLOS: no los listes todos de golpe. Si preguntan por paquetes, menciona los nombres en una linea y da el detalle solo del que les interese. Si el motivo del viaje encaja (cumpleanos, ninos, descanso, festejo), sugiere uno de forma natural, sin presionar, una sola vez. Para los "por cotizar" pide los datos que se necesitan (fecha, duracion, numero de personas, preferencias) y di que en breve les compartes la cotizacion; nunca inventes una cifra. Si agregan un paquete con precio, sumalo en la cotizacion como renglon aparte y recalcula el anticipo del 50% sobre el total.

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
- Nunca pidas correo electronico

TONO: calido, pausado, conversacional. Emojis ocasionales. Nunca robotico.

LONGITUD: estas en WhatsApp. Responde CORTO, maximo 4-6 lineas por mensaje, como una persona. No mandes toda la informacion de golpe; da solo lo que pregunto y ofrece mas si lo quiere. Si el cliente pide "toda la informacion", da un resumen breve (ubicacion, capacidad, servicios, tarifas) en maximo 10 lineas, sin listar cada habitacion a menos que la pida. FORMATO WHATSAPP: para negritas usa UN solo asterisco (*texto*), nunca dos; no uses #, ni tablas.

EXTRACCION DE DATOS: el cliente puede darte varios datos en un solo mensaje o uno por uno. Lee todo el mensaje y extrae nombre, fechas, adultos, ninos y motivo sin importar el orden o formato. Nunca vuelvas a pedir un dato que ya te dio. SIEMPRE responde algo a cada mensaje.

FLUJO: saluda, pregunta que necesita, recoge nombre/fechas/adultos/ninos/motivo de forma natural, consulta disponibilidad, calcula noches y total, presenta cotizacion, si acepta manda datos bancarios y pide que envie la foto de su comprobante por este chat y que despues escriba "listo" para avisarte. Si el cliente escribe "listo" (o similar) despues de los datos bancarios, tomalo como aviso de pago.

NO SEAS INSISTENTE: si el cliente solo esta preguntando (fotos, servicios, ubicacion, habitaciones, precios, paquetes, horarios), responde su pregunta y ya. NO termines cada mensaje preguntando por fechas o si quiere reservar. Maximo menciona la reserva UNA vez en toda la conversacion, de forma suave, y solo despues de haber resuelto varias dudas. Si el cliente ya dijo que solo esta viendo o que despues te avisa, no vuelvas a ofrecer reservar a menos que el lo pida. Deja que el cliente lleve el ritmo, como lo haria un buen anfitrion.

CUANDO el cliente confirme que quiere reservar (y ya consultaste disponibilidad y esta libre), agrega al FINAL de tu respuesta, en su propia linea, exactamente esto (el cliente no lo vera):
RESERVA_JSON:{"nombre":"...","llegada":"DD/MM/AAAA","salida":"DD/MM/AAAA","adultos":N,"ninos":N,"motivo":"...","paquetes":"...","total":N}
En "paquetes" pon los paquetes que le interesaron al cliente separados por coma (ej. "Fiesta Infantil, Karaoke"; marca los por cotizar asi: "Chef Privada (por cotizar)"); si ninguno, pon "Ninguno".
Solo UNA vez por cada reserva confirmada (no la repitas si solo estan platicando de la misma reserva).

EL CALENDARIO MANDA: lo que se hablo antes en esta conversacion puede estar desactualizado (el administrador puede cancelar o borrar reservas). Antes de decir que el cliente ya tiene una reserva, o si pregunta por su reserva o su pago, usa consultar_mis_reservas y confia SOLO en ese resultado. Si ahi no aparece, NO la tiene: tratala como reserva nueva (consulta disponibilidad, cotiza y genera un nuevo RESERVA_JSON cuando confirme). Nunca digas "ya la tenemos registrada" sin haberlo consultado.

VARIAS RESERVAS: un mismo cliente puede hacer mas de una reserva. Si dice que quiere una reserva NUEVA u OTRA, o da fechas distintas a las de una reserva anterior, tratala como reserva nueva: pregunta las fechas y datos que falten (puedes reutilizar su nombre), consulta disponibilidad, cotiza y, cuando confirme, agrega un NUEVO RESERVA_JSON con las nuevas fechas. Nunca digas "ya la tenemos registrada" si las fechas son distintas.

COMPROBANTE CON TEXTO: WhatsApp a veces solo te pasa el texto que acompana una foto. Si ya le diste los datos bancarios y el cliente escribe algo corto como "listo", "ya", "ahi esta", "te lo mande", "ya quedo" o "enviado", asume que YA mando su comprobante: NO le digas que lo esperas; trátalo como aviso de pago (abajo). Solo una vez por reserva: si ya diste el aviso de pago, no lo repitas.

AVISO DE PAGO: si el cliente dice que ya deposito, ya pago, ya transfirio, o manda su comprobante, agradecele con calidez, dile que en breve confirmamos el pago, y agrega al FINAL de tu respuesta, en su propia linea, exactamente: AVISO_PAGO (el cliente no lo vera).

FOTOS: ENVIAR_FOTOS es SOLO para fotos de la casa. Si piden fotos de pinatas, inflables o del paquete de fiesta, usa FOTOS_PINATAS y NUNCA ENVIAR_FOTOS. Si el cliente pide fotos de la casa, imagenes, ver la casa, las habitaciones o la alberca, responde con calidez algo breve como "¡Claro! Te comparto algunas fotos de la villa 📸" y agrega al FINAL de tu respuesta, en su propia linea, exactamente: ENVIAR_FOTOS (el cliente no lo vera). Las fotos se envian automaticamente; no digas que no puedes mandar fotos.

CONTRATO E INE: NO hables del contrato ni pidas INE durante la cotizacion ni al apartar, y NUNCA mandes link de contrato. El contrato lo llena el administrador de la villa junto con el huesped a su llegada, en formato digital (toma 2 minutos) y se requiere la INE. Mencionalo solo al confirmar el pago ([SISTEMA] PAGO_CONFIRMADO). Si antes preguntan por el contrato, explica exactamente eso.

PASAR A UNA PERSONA: si el cliente pide hablar con una persona, con el dueno o el administrador, si esta molesto o frustrado, si tiene una queja, o si pregunta algo que no puedes resolver con esta informacion, dile con calidez que lo comunicas con el administrador de la villa y que en breve le escribe, y agrega al FINAL de tu respuesta, en su propia linea: PASAR_A_HUMANO. No sigas cotizando en ese mensaje.

MENSAJES DEL SISTEMA: si recibes un mensaje que empieza con [SISTEMA] PAGO_CONFIRMADO, no lo escribio el cliente: significa que el administrador ya verifico el deposito. Escribele al cliente con calidez que su pago fue recibido y su reserva esta confirmada. Luego, en tono cercano (NO como lista de tareas ni "Para terminar"), dile que el administrador de la villa los recibira a su llegada y, para facilitarles todo, llenaran juntos el contrato digital en ese momento (toma solo 2 minutos); que por favor tengan a la mano su INE, ya que se requiere para el contrato. NO mandes ningun link de contrato y NO pidas la INE por este chat. Despues dale los datos de llegada: direccion, link de ubicacion en Google Maps (https://www.google.com/maps?q=20.6901757,-100.2620513), check-in 13:00, check-out 12:00, y el numero del administrador de la villa (442 874 2383): con el se verifica cualquier persona extra o cambio de horario de entrada o salida. Nunca menciones la palabra SISTEMA.`;
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

  // Espera ESPERA_MS por si el cliente manda varios mensajes seguidos; solo el ultimo contesta con todo junto
  if (String(message).startsWith("[SISTEMA]") || esReanudar(message)) return procesarMensaje(phoneNumber, telefono, message, res);
  res.t0 = Date.now();
  const p = pendientes.get(phoneNumber) || { textos: [] };
  if (p.timer) { clearTimeout(p.timer); p.res.json({ response: "", omitir: "si", avisoPago: "no", enviarFotos: "no", fotosPinatas: "no", avisoHumano: "no" }); }
  p.textos.push(String(message));
  p.res = res;
  const lanzar = () => {
    // Si todavia esta contestando un mensaje anterior, espera a que termine y junta todo
    if (procesando.has(phoneNumber)) { p.timer = setTimeout(lanzar, 700); return; }
    pendientes.delete(phoneNumber);
    procesando.add(phoneNumber);
    console.log("Procesando", p.textos.length, "mensaje(s) de", phoneNumber);
    Promise.resolve(procesarMensaje(phoneNumber, telefono, p.textos.join("\n"), p.res))
      .catch(e => console.error("Error procesando:", e.message))
      .finally(() => procesando.delete(phoneNumber));
  };
  p.timer = setTimeout(lanzar, ESPERA_MS);
  pendientes.set(phoneNumber, p);
});

const ESPERA_MS = Number(process.env.ESPERA_MS || 3000);
// ManyChat corta la espera a los ~10 s. Si Claude tarda mas (revisando calendario), se contesta un "un momento"
// y la respuesta final se manda despues por la API de ManyChat (requiere MANYCHAT_API_KEY).
const LIMITE_MS = Number(process.env.LIMITE_MS || 8500); // tiempo total desde que llega el mensaje
const procesando = new Set();
const planGrupo = new Map();
async function enviarPorManyChat(id, texto) {
  if (!process.env.MANYCHAT_API_KEY) { console.error("Falta MANYCHAT_API_KEY: no se pudo mandar la respuesta tardia a", id); return; }
  try {
    const r = await fetch("https://api.manychat.com/fb/sending/sendContent", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.MANYCHAT_API_KEY}` },
      body: JSON.stringify({ subscriber_id: id, data: { version: "v2", content: { type: "whatsapp", messages: [{ type: "text", text: texto }] } } }),
    });
    const d = await r.json();
    console.log("Respuesta tardia enviada a", id, d.status, d.status === "success" ? "" : JSON.stringify(d));
  } catch (e) { console.error("Error respuesta tardia:", e.message); }
}
const pendientes = new Map();
const esReanudar = m => /^\W*(sistema\W*)?reanudar\W*$/i.test(String(m).trim());

// Reanudar desde el navegador: https://TU-APP.up.railway.app/reanudar/ID_DEL_CONTACTO
app.get("/reanudar/:id", (req, res) => {
  db.run("DELETE FROM pausas WHERE id = ?", [req.params.id]);
  anotarHistorial(req.params.id, NOTA_REANUDAR);
  console.log("Agente reanudado (navegador) para", req.params.id);
  res.send("Listo, el agente vuelve a contestar a " + req.params.id);
});

// Agrega texto al historial sin llamar a Claude (se une al ultimo mensaje del cliente si lo hay)
function anotarHistorial(id, texto, cb) {
  db.get("SELECT messages FROM conversations WHERE id = ?", [id], (err, row) => {
    const h = row ? JSON.parse(row.messages) : [];
    const last = h[h.length - 1];
    if (last && last.role === "user") last.content = String(last.content) + "\n" + texto;
    else h.push({ role: "user", content: texto });
    db.run("INSERT OR REPLACE INTO conversations (id, messages, updated_at) VALUES (?, ?, datetime('now'))", [id, JSON.stringify(h)], () => cb && cb());
  });
}
const NOTA_REANUDAR = "[SISTEMA] El administrador de la villa ya atendio personalmente al cliente en este chat (tu no viste esa parte de la conversacion). Ya NO digas que lo vas a comunicar ni que el administrador le escribira. Si el cliente vuelve a escribir, retoma con naturalidad, como si fueras parte del mismo equipo: responde lo que pregunte y, si aplica, preguntale amablemente si quedo resuelto o si le ayudas con algo mas (fechas, cotizacion, paquetes).";

function procesarMensaje(phoneNumber, telefono, message, res) {
  if (esReanudar(message)) {
    db.run("DELETE FROM pausas WHERE id = ?", [phoneNumber]);
    anotarHistorial(phoneNumber, NOTA_REANUDAR);
    console.log("Agente reanudado para", phoneNumber);
    return res.json({ response: "", omitir: "si", avisoPago: "no", enviarFotos: "no", fotosPinatas: "no", avisoHumano: "no" });
  }
  db.get("SELECT hasta FROM pausas WHERE id = ?", [phoneNumber], (e0, pausa) => {
    if (pausa && pausa.hasta <= Date.now()) {
      db.run("DELETE FROM pausas WHERE id = ?", [phoneNumber]);
      return anotarHistorial(phoneNumber, NOTA_REANUDAR, () => procesarConClaude(phoneNumber, telefono, message, res));
    }
    if (pausa && pausa.hasta > Date.now() && !String(message).startsWith("[SISTEMA]")) {
      console.log("Agente en pausa (lo atiende una persona):", phoneNumber);
      anotarHistorial(phoneNumber, "[Mensaje del cliente mientras lo atendia el administrador]: " + message);
      return res.json({ response: "", omitir: "si", avisoPago: "no", enviarFotos: "no", fotosPinatas: "no", avisoHumano: "no" });
    }
    procesarConClaude(phoneNumber, telefono, message, res);
  });
}

function procesarConClaude(phoneNumber, telefono, message, res) {
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
      let enviado = false;
      const timer = setTimeout(() => {
        enviado = true;
        console.log("Respuesta lenta, mando 'un momento' a", phoneNumber);
        res.json({ response: "Déjame revisarlo un momento 🗓️ enseguida te confirmo.", avisoPago: "no", enviarFotos: "no", fotosPinatas: "no", avisoHumano: "no" });
      }, Math.max(300, LIMITE_MS - (Date.now() - (res.t0 || Date.now()))));
      let reply;
      try { reply = await responderConClaude(history, phoneNumber); }
      catch (e) { clearTimeout(timer); if (enviado) { console.error(e); return enviarPorManyChat(phoneNumber, "Perdón, tuve un pequeño problema técnico 🙏 ¿Me repites tu último mensaje?"); } throw e; }
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
            mensajeCliente += "\n\nUna aclaración 🙏 la villa tiene capacidad regular de 15 adultos y 2 niños. Para grupos más grandes, el administrador de la villa te dará una atención personalizada 🌿 ¿Me cuentas cuál es el plan o qué tienen en mente?";
            planGrupo.set(phoneNumber, Date.now());
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
      const pidePersona = /(hablar|comunicar|contactar|atender|pasar)[^.?!]{0,30}(persona|humano|alguien|due[nñ]o|administrador|encargad|asesor|gerente)|quiero (una )?persona|no eres (una )?persona|eres (un )?(bot|robot)/i.test(String(message));
      if (pidePersona && !mensajeCliente.includes("PASAR_A_HUMANO")) {
        mensajeCliente = "Con gusto 🌿 Le aviso al administrador de la villa para que te escriba en breve y te atienda personalmente.";
        mensajeCliente += "\nPASAR_A_HUMANO";
      }
      // Grupo mayor a la capacidad: se detecta en el codigo para no depender de la IA
      const txt = String(message).toLowerCase();
      const nAdultos = Math.max(0, ...[...txt.matchAll(/(\d{1,3})\s*(adultos?|personas?|pax|invitados?|huespedes?|huéspedes?|gente)/g)].map(m => +m[1]));
      const nNinos = Math.max(0, ...[...txt.matchAll(/(\d{1,3})\s*(niñ[oa]s?|nin[oa]s?|menores?)/g)].map(m => +m[1]));
      const FINAL_GRUPO = "¡Muchas gracias por compartirnos su plan! 🌿 En breve el administrador de la villa se pondrá en contacto contigo para darte una atención personalizada. ¡Gracias!";
      const espera = planGrupo.get(phoneNumber);
      if (espera && Date.now() - espera < 48 * 3600000) {
        planGrupo.delete(phoneNumber);
        console.log("PLAN DE GRUPO recibido de", phoneNumber);
        mensajeCliente = FINAL_GRUPO + "\nPASAR_A_HUMANO";
      } else if (mensajeCliente.includes("PASAR_A_HUMANO") && !pidePersona && /ocupad|no (hay|tenemos|est[aá]n?) disponib/i.test(mensajeCliente)) {
        mensajeCliente = mensajeCliente.replace(/PASAR_A_HUMANO/g, "").trim();
        console.log("GRUPO GRANDE: fechas ocupadas, no se pasa al administrador", phoneNumber);
      } else if (mensajeCliente.includes("PASAR_A_HUMANO") && !pidePersona && (nAdultos > 15 || nNinos > 2 || /capacidad|grupo|15 adultos|personas en total|m[aá]s grande/i.test(mensajeCliente + " " + txt))) {
        mensajeCliente = mensajeCliente.replace(/PASAR_A_HUMANO/g, "").trim();
        if (!/plan|tienen en mente|evento|celebraci/i.test(mensajeCliente)) mensajeCliente += "\n\nPara pasarle toda la información al administrador, ¿me cuentas cuál es el plan o qué tienen en mente? (tipo de evento o celebración, fechas y cuántas personas serían en total) 😊";
        planGrupo.set(phoneNumber, Date.now());
        console.log("GRUPO GRANDE (IA): pregunto el plan a", phoneNumber);
      } else if ((nAdultos > 17 || nNinos > 2 || (/adult/.test(txt) && nAdultos > 15)) && !mensajeCliente.includes("PASAR_A_HUMANO") && /ocupad|no (hay|tenemos|est[aá]n?) disponib|otras fechas|qu[eé] fechas|cu[aá]les fechas/i.test(mensajeCliente)) {
        // La IA ya contesto sobre disponibilidad/fechas (ocupadas o faltan fechas): se respeta su respuesta
        console.log("GRUPO GRANDE: esperando fechas libres de", phoneNumber);
      } else if ((nAdultos > 17 || nNinos > 2 || (/adult/.test(txt) && nAdultos > 15)) && !mensajeCliente.includes("PASAR_A_HUMANO")) {
        console.log("GRUPO GRANDE:", nAdultos, "adultos /", nNinos, "ninos de", phoneNumber);
        mensajeCliente = "¡Qué gusto que quieran venir en grupo! 🌿 La villa tiene capacidad regular de 15 adultos y 2 niños. Para grupos más grandes, el administrador de la villa te dará una atención personalizada. Para pasarle toda la información, ¿me cuentas cuál es el plan o qué tienen en mente? (tipo de evento o celebración, fechas y cuántas personas serían en total) 😊";
        planGrupo.set(phoneNumber, Date.now());
      }
      let avisoHumano = "no";
      if (mensajeCliente.includes("PASAR_A_HUMANO")) {
        avisoHumano = "si";
        mensajeCliente = mensajeCliente.replace(/PASAR_A_HUMANO/g, "").trim();
        const horas = Number(process.env.HORAS_PAUSA || 12);
        db.run("INSERT OR REPLACE INTO pausas (id, hasta) VALUES (?, ?)", [phoneNumber, Date.now() + horas * 3600000]);
        console.log("PASAR A HUMANO:", phoneNumber, "- agente en pausa", horas, "h");
        await bitacora("Pide hablar con persona", { telefono: (telefono && !String(telefono).includes("{{")) ? telefono : phoneNumber });
      }
      let fotosPinatas = "no";
      if (mensajeCliente.includes("FOTOS_PINATAS")) {
        fotosPinatas = "si";
        mensajeCliente = mensajeCliente.replace(/FOTOS_PINATAS/g, "").trim();
        console.log("FOTOS PINATAS solicitadas por", phoneNumber);
        enviarFotos = "no";
      }
      mensajeCliente = mensajeCliente.replace(/\*\*(.+?)\*\*/g, "*$1*").replace(/^#+\s*/gm, "");
      if (!mensajeCliente.trim()) mensajeCliente = "Perfecto, ya quedo anotado 😊 ¿Algo mas en lo que te pueda ayudar?";

      history.push({ role: "assistant", content: reply });
      if (history.length > 20) history.splice(0, history.length - 20);
      while (history.length && history[0].role !== "user") history.shift();
      db.run("INSERT OR REPLACE INTO conversations (id, messages, updated_at) VALUES (?, ?, datetime('now'))",
        [phoneNumber, JSON.stringify(history)]);

      clearTimeout(timer);
      if (enviado) enviarPorManyChat(phoneNumber, mensajeCliente);
      else res.json({ response: mensajeCliente, avisoPago, enviarFotos, fotosPinatas, avisoHumano });
    } catch (error) {
      console.error(error);
      if (!res.headersSent) res.status(200).json({ response: "Perdón, tuve un pequeño problema técnico 🙏 ¿Me repites tu último mensaje?" });
    }
  });
}

app.use((err, req, res, next) => {
  if (err.type === "entity.parse.failed") return res.status(200).json({ response: "No entendí bien ese mensaje, ¿me lo repites?" });
  next(err);
});

const PORT = process.env.PORT || 8080;
const server = app.listen(PORT, () => console.log(`Agente Canto en puerto ${PORT}`));
setInterval(() => enviarPostEstancia().catch(e => console.error("Post-estancia:", e.message)), 60 * 60 * 1000);
setTimeout(() => enviarPostEstancia().catch(e => console.error("Post-estancia:", e.message)), 30000);
setInterval(() => liberarPendientes().catch(e => console.error("Liberar:", e.message)), 60 * 60 * 1000);
setInterval(() => enviarPreLlegada().catch(e => console.error("Pre-llegada:", e.message)), 60 * 60 * 1000);
setTimeout(() => { liberarPendientes().catch(() => {}); enviarPreLlegada().catch(() => {}); }, 90000);
setInterval(() => enviarSeguimientos().catch(e => console.error("Seguimiento:", e.message)), 60 * 60 * 1000);
setTimeout(() => enviarSeguimientos().catch(e => console.error("Seguimiento:", e.message)), 60000);
process.on("SIGTERM", () => {
  console.log("Apagando para nueva version...");
  server.close(() => db.close(() => process.exit(0)));
  setTimeout(() => process.exit(0), 5000);
});
