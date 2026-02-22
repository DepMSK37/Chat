const http = require("http");
const fs = require("fs");
const path = require("path");
const { WebSocketServer } = require("ws");
const webpush = require("web-push"); // Новый модуль

// =====================================================
// НАСТРОЙКИ И КЛЮЧИ
// =====================================================
const PASSWORD        = process.env.PASSWORD || null;
const VAPID_PUBLIC    = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE   = process.env.VAPID_PRIVATE_KEY;

const MAX_HISTORY     = 500;
const TTL_6_HOURS     = 6 * 60 * 60 * 1000;
const HISTORY_FILE    = path.join(__dirname, "history.json");
const SUBS_FILE       = path.join(__dirname, "subs.json");
const UPLOADS_DIR     = path.join(__dirname, "uploads");

if (VAPID_PUBLIC && VAPID_PRIVATE) {
  webpush.setVapidDetails("mailto:admin@rusteryerka.ru", VAPID_PUBLIC, VAPID_PRIVATE);
}

if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// =====================================================
// ПОДПИСКИ НА УВЕДОМЛЕНИЯ
// =====================================================
let subscriptions = {};
try {
  if (fs.existsSync(SUBS_FILE)) subscriptions = JSON.parse(fs.readFileSync(SUBS_FILE, "utf-8"));
} catch (e) { subscriptions = {}; }

function saveSubs() { fs.writeFileSync(SUBS_FILE, JSON.stringify(subscriptions), "utf-8"); }

// =====================================================
// ИСТОРИЯ
// =====================================================
let history = [];
loadHistory();
function loadHistory() {
  try {
    if (fs.existsSync(HISTORY_FILE)) history = JSON.parse(fs.readFileSync(HISTORY_FILE, "utf-8")) || [];
  } catch (e) { history = []; }
}
function saveHistory() { fs.writeFileSync(HISTORY_FILE, JSON.stringify(history), "utf-8"); }
setInterval(saveHistory, 10000);

// =====================================================
// WebSocket и Рассылка
// =====================================================
const httpServer = http.createServer((req, res) => {
  if (req.url === "/ping") return res.end("pong");
  const url = req.url === "/" ? "/index.html" : req.url;
  const filePath = path.join(__dirname, url);
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); return res.end("Not found"); }
    const ext = path.extname(filePath).toLowerCase();
    const MIME = { ".html": "text/html", ".js": "application/javascript", ".json": "application/json", ".jpg": "image/jpeg", ".png": "image/png" };
    res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server: httpServer });
const clients = new Map();

function broadcast(payload, exclude = null) {
  const data = JSON.stringify(payload);
  for (const [client, info] of clients) {
    if (client !== exclude && client.readyState === 1 && info.auth) client.send(data);
  }
}

// ФУНКЦИЯ ОТПРАВКИ PUSH
async function sendPushNotification(senderName, text) {
  const payload = JSON.stringify({ title: senderName, body: text || "🖼️ Фотография" });
  
  // Собираем имена тех, кто СЕЙЧАС онлайн через сокеты
  const onlineNames = new Set([...clients.values()].filter(c => c.auth).map(c => c.name));

  for (const name in subscriptions) {
    // Не шлем пуш тому, кто отправил (senderName) 
    // и тем, кто сейчас и так сидит в чате (onlineNames)
    if (name === senderName || onlineNames.has(name)) continue;

    const sub = subscriptions[name];
    webpush.sendNotification(sub, payload).catch(err => {
      if (err.statusCode === 410) { // Подписка протухла
        delete subscriptions[name];
        saveSubs();
      }
    });
  }
}

wss.on("connection", (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  clients.set(ws, { name: "Аноним", auth: false });

  if (!PASSWORD) { clients.get(ws).auth = true; send(ws, { type: "auth-ok" }); } 
  else send(ws, { type: "need-password" });

  ws.on("message", (data) => {
    let parsed;
    try { parsed = JSON.parse(data.toString()); } catch { return; }
    const clientInfo = clients.get(ws);

    if (parsed.type === "auth") {
      if (!PASSWORD || parsed.password === PASSWORD) {
        clientInfo.auth = true; send(ws, { type: "auth-ok" });
      } else { ws.close(); }
      return;
    }

    if (!clientInfo.auth) return;

    if (parsed.type === "push-subscribe") {
      subscriptions[clientInfo.name] = parsed.subscription;
      saveSubs();
      return;
    }

    if (parsed.type === "join") {
      clientInfo.name = (parsed.name || "Аноним").slice(0, 20).trim();
      send(ws, { type: "history", messages: history, vapidPublicKey: VAPID_PUBLIC });
      broadcast({ type: "system", text: `${clientInfo.name} вошёл в чат` });
      return;
    }

    if (parsed.type === "message") {
      const message = {
        id: parsed.id || Date.now().toString(36),
        name: clientInfo.name,
        text: (parsed.text || "").slice(0, 10000),
        time: new Date().toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" }),
        read: false,
        replyTo: parsed.replyTo || null
      };
      
      // Обработка фото (пропускаем для краткости, логика та же)
      
      history.push(message);
      if (history.length > MAX_HISTORY) history.shift();
      broadcast({ type: "message", message }, ws);
      
      // ЗАПУСКАЕМ PUSH ДЛЯ ОФЛАЙНЕРОВ
      sendPushNotification(clientInfo.name, message.text);
    }
  });

  ws.on("close", () => { clients.delete(ws); });
});

httpServer.listen(process.env.PORT || 3000);
