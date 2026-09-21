const Anthropic = require("@anthropic-ai/sdk");
const { google } = require("googleapis");
const express = require("express");
const bodyParser = require("body-parser");

const app = express();
app.use(bodyParser.json());

const CLAUDE_API_KEY = "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";
const CALENDAR_ID = "a04736570060a96ea740132b7ab1c8f98aa12b5d6e12d9dbea74fe263dfa7345@group.calendar.google.com";
const GOOGLE_AUTH_JSON = require("./google-auth.json");

const client = new Anthropic.Anthropic({ apiKey: CLAUDE_API_KEY });
const auth = new google.auth.OAuth2(GOOGLE_AUTH_JSON.client_id, GOOGLE_AUTH_JSON.client_secret, GOOGLE_AUTH_JSON.redirect_uris[0]);
const calendar = google.calendar({ version: "v3", auth });

const conversations = new Map();

const SYSTEM_PROMPT = `Eres Canto, el asistente de Villa de Canto...`;

app.post("/webhook", async (req, res) => {
  const { phoneNumber, message } = req.body;
  if (!phoneNumber || !message) return res.status(400).json({ error: "Datos requeridos" });
  
  if (!conversations.has(phoneNumber)) conversations.set(phoneNumber, { messages: [], reservation: {} });
  const convo = conversations.get(phoneNumber);
  convo.messages.push({ role: "user", content: message });

  try {
    const response = await client.messages.create({
      model: "claude-3-5-sonnet-20241022",
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      messages: convo.messages,
    });
    const assistantMessage = response.content[0].text;
    convo.messages.push({ role: "assistant", content: assistantMessage });
    res.json({ response: assistantMessage });
  } catch (error) {
    res.status(500).json({ error: "Error procesando" });
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Agente en puerto ${PORT}`));