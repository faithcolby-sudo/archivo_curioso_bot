import express from "express";
import fetch from "node-fetch";
import fs from "fs";

const app = express();
app.use(express.json());

const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_ID = Number(process.env.ADMIN_ID);
const VIP_CHAT_ID = Number(process.env.VIP_CHAT_ID);
const TEMP_CHAT_ID = Number(process.env.TEMP_CHAT_ID);
const HUB_CHAT_ID = process.env.HUB_CHAT_ID ? Number(process.env.HUB_CHAT_ID) : null;
const WEBHOOK_URL = process.env.WEBHOOK_URL; // ejemplo: https://tuapp.onrender.com
const PORT = process.env.PORT || 3000;

if (!BOT_TOKEN || !ADMIN_ID || !VIP_CHAT_ID || !TEMP_CHAT_ID) {
  console.error("FALTAN VARIABLES DE ENTORNO: BOT_TOKEN, ADMIN_ID, VIP_CHAT_ID, TEMP_CHAT_ID");
  process.exit(1);
}

const API = `https://api.telegram.org/bot${BOT_TOKEN}`;
const DB_FILE = "./db.json";

function loadDB() {
  try {
    return JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
  } catch {
    return {
      vipMembers: {},      // userId: { expiresAt: ms }
      temp: { openUntil: 0, inviteLink: "", postedMessageIds: [] }
    };
  }
}
function saveDB(db) {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

async function tg(method, body) {
  const res = await fetch(`${API}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const data = await res.json();
  if (!data.ok) throw new Error(`${method} ERROR: ${JSON.stringify(data)}`);
  return data.result;
}

function isAdmin(userId) {
  return Number(userId) === ADMIN_ID;
}

async function send(chatId, text, extra = {}) {
  return tg("sendMessage", { chat_id: chatId, text, ...extra });
}

async function createInviteLink(chatId, seconds, memberLimit = null) {
  const expireDate = Math.floor(Date.now() / 1000) + seconds;

  const payload = {
    chat_id: chatId,
    expire_date: expireDate
  };

  // solo ponemos member_limit si nos lo pasan
  if (memberLimit !== null) payload.member_limit = memberLimit;

  return tg("createChatInviteLink", payload);
}

async function revokeInvite(chatId, inviteLink) {
  return tg("revokeChatInviteLink", { chat_id: chatId, invite_link: inviteLink });
}

// “Expulsar” del VIP (kick): ban + unban
async function kickUser(chatId, userId) {
  await tg("banChatMember", { chat_id: chatId, user_id: userId });
  await tg("unbanChatMember", { chat_id: chatId, user_id: userId });
}

/**
 * TEMPORAL: el bot publica y luego borra
 */
async function openTemporal(hours) {
  const db = loadDB();
  const seconds = Math.max(1, Math.floor(hours * 3600));

  // crea link para entrar durante N horas (sirve para nuevos)
  const linkObj = await createInviteLink(TEMP_CHAT_ID, seconds, ); // mucha gente puede entrar
  const openUntil = Date.now() + seconds * 1000;

  db.temp.openUntil = openUntil;
  db.temp.inviteLink = linkObj.invite_link;
  db.temp.postedMessageIds = [];
  saveDB(db);

  // aquí el bot PUBLICA el pack temporal (por ahora 3 mensajes ejemplo)
  const m1 = await tg("sendMessage", { chat_id: TEMP_CHAT_ID, text: "⏳ Canal TEMPORAL abierto por tiempo limitado" });
  const m2 = await tg("sendMessage", { chat_id: TEMP_CHAT_ID, text: "🔥 Muestra 1 (aquí luego pondremos su contenido)" });
  const m3 = await tg("sendMessage", { chat_id: TEMP_CHAT_ID, text: "⭐ Para VIP escriba al bot: /vip" });

  db.temp.postedMessageIds = [m1.message_id, m2.message_id, m3.message_id];
  saveDB(db);

  return { inviteLink: linkObj.invite_link, openUntil };
}

async function closeTemporal() {
  const db = loadDB();

  // revoca link si existe
  if (db.temp.inviteLink) {
    try { await revokeInvite(TEMP_CHAT_ID, db.temp.inviteLink); } catch {}
  }

  // borra mensajes que el bot publicó
  for (const mid of db.temp.postedMessageIds || []) {
    try { await tg("deleteMessage", { chat_id: TEMP_CHAT_ID, message_id: mid }); } catch {}
  }

  db.temp = { openUntil: 0, inviteLink: "", postedMessageIds: [] };
  saveDB(db);

  return true;
}

/**
 * VIP: aprobar con días acumulables
 */
async function approveVip(userId, days) {
  const db = loadDB();
  const now = Date.now();
  const addMs = days * 24 * 60 * 60 * 1000;

  const current = db.vipMembers[String(userId)]?.expiresAt || 0;
  const base = current > now ? current : now;
  const expiresAt = base + addMs;

  db.vipMembers[String(userId)] = { expiresAt };
  saveDB(db);

  // link personal 10 min, 1 uso
  const linkObj = await createInviteLink(VIP_CHAT_ID, 10 * 60, 1);

  return { inviteLink: linkObj.invite_link, expiresAt };
}

async function checkVipExpirations() {
  const db = loadDB();
  const now = Date.now();
  const entries = Object.entries(db.vipMembers);

  for (const [userIdStr, info] of entries) {
    if (info.expiresAt && info.expiresAt <= now) {
      const userId = Number(userIdStr);
      try { await kickUser(VIP_CHAT_ID, userId); } catch {}
      delete db.vipMembers[userIdStr];
    }
  }
  saveDB(db);
}

function fmtMs(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  return `${h}h ${m}m`;
}

/**
 * COMANDOS
 */
async function handleMessage(msg) {
  const chatId = msg.chat.id;
  const userId = msg.from?.id;
  const text = (msg.text || "").trim();

  if (!text.startsWith("/")) return;

  // /start
  if (text === "/start") {
    return send(chatId,
      "Bienvenido\n\nOpciones:\n/temporal (ver estado)\n/vip (info VIP)\n\nSi ya pagó: /ya_pague"
    );
  }

  // /vip
  if (text === "/vip") {
    return send(chatId,
      "VIP mensual\n\nPague y luego escriba /ya_pague\nEl admin revisa y si está correcto aprueba y le llega su link personal (10 min)"
    );
  }

  // /ya_pague
  if (text === "/ya_pague") {
    await send(ADMIN_ID, `Pago reportado\nUser: ${userId}\nChat: ${chatId}\nUse: /aprobar ${userId} 30  (o 60 etc)`);
    return send(chatId, "Listo ya avisé al administrador\napenas apruebe le llegará su link VIP");
  }

  // /temporal
  if (text === "/temporal") {
    const db = loadDB();
    if (db.temp.openUntil && db.temp.openUntil > Date.now()) {
      return send(chatId, `Temporal ABIERTO\nLink: ${db.temp.inviteLink}\nCierra en: ${fmtMs(db.temp.openUntil - Date.now())}`);
    }
    return send(chatId, "Temporal CERRADO\nEspere que el admin lo abra");
  }

  // ADMIN: /abrir_temporal 2h
  if (text.startsWith("/abrir_temporal")) {
    if (!isAdmin(userId)) return send(chatId, "No autorizado");
    const parts = text.split(/\s+/);
    const raw = parts[1] || "2h";
    let hours = 2;

    if (raw.endsWith("h")) hours = Number(raw.replace("h", ""));
    else if (raw.endsWith("m")) hours = Number(raw.replace("m", "")) / 60;
    else hours = Number(raw);

    if (!Number.isFinite(hours) || hours <= 0) hours = 2;

    const { inviteLink } = await openTemporal(hours);
    return send(chatId, `Temporal ABIERTO\nLink para entrar: ${inviteLink}\nDuración: ${hours}h`);
  }

  // ADMIN: /cerrar_temporal
  if (text === "/cerrar_temporal") {
    if (!isAdmin(userId)) return send(chatId, "No autorizado");
    await closeTemporal();
    return send(chatId, "Temporal cerrado y contenido borrado");
  }

  // ADMIN: /aprobar USER_ID DIAS
  if (text.startsWith("/aprobar")) {
    if (!isAdmin(userId)) return send(chatId, "No autorizado");
    const parts = text.split(/\s+/);
    const targetId = Number(parts[1]);
    const days = Number(parts[2] || 30);
    if (!targetId || !Number.isFinite(days) || days <= 0) {
      return send(chatId, "Uso: /aprobar USER_ID 30");
    }

    const { inviteLink, expiresAt } = await approveVip(targetId, days);

    // manda link al usuario
    await send(targetId, `VIP aprobado por ${days} días\nLink personal (10 min): ${inviteLink}`);
    return send(chatId, `Aprobado ${targetId}\nVence: ${new Date(expiresAt).toLocaleString()}`);
  }

  // ADMIN: /estado_vip USER_ID
  if (text.startsWith("/estado_vip")) {
    if (!isAdmin(userId)) return send(chatId, "No autorizado");
    const parts = text.split(/\s+/);
    const targetId = String(parts[1] || "");
    const db = loadDB();
    const info = db.vipMembers[targetId];
    if (!info) return send(chatId, "No está en VIP");
    const left = info.expiresAt - Date.now();
    return send(chatId, `VIP activo\nFaltan: ${fmtMs(left)}\nVence: ${new Date(info.expiresAt).toLocaleString()}`);
  }
}

// WEBHOOK endpoint
app.post(`/webhook/${BOT_TOKEN}`, async (req, res) => {
  try {
    const update = req.body;
    if (update.message) await handleMessage(update.message);
    res.sendStatus(200);
  } catch (e) {
    console.error(e);
    res.sendStatus(200);
  }
});

app.get("/", (req, res) => res.send("OK"));

app.listen(PORT, async () => {
  console.log("Server running on", PORT);

  // revisar expiraciones VIP cada 5 minutos
  setInterval(() => {
    checkVipExpirations().catch(console.error);
  }, 5 * 60 * 1000);

  // cerrar temporal automáticamente si ya pasó (cada 1 minuto)
  setInterval(async () => {
    const db = loadDB();
    if (db.temp.openUntil && db.temp.openUntil <= Date.now()) {
      await closeTemporal().catch(console.error);
    }
  }, 60 * 1000);

  // set webhook si hay URL
  if (WEBHOOK_URL) {
    const url = `${WEBHOOK_URL}/webhook/${BOT_TOKEN}`;
    try {
      await tg("setWebhook", { url });
      console.log("Webhook set:", url);
    } catch (e) {
      console.error("Failed to setWebhook:", e.message);
    }
  } else {
    console.log("WEBHOOK_URL no configurado (luego lo pone en Render)");
  }
});
