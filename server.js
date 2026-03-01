const http = require("http");
const fs = require("fs");
const path = require("path");
const { WebSocketServer } = require("ws");
const webpush = require("web-push"); // Подключаем библиотеку Web Push

// =====================================================
// НАСТРОЙКИ
// =====================================================
const PASSWORD        = process.env.PASSWORD || null;
const VAPID_PUBLIC    = process.env.VAPID_PUBLIC_KEY; // Ваш публичный ключ
const VAPID_PRIVATE   = process.env.VAPID_PRIVATE_KEY; // Ваш приватный ключ
const MAX_CLIENTS     = 15;
const MAX_HISTORY     = 500;
const TTL_6_HOURS     = 6 * 60 * 60 * 1000; // 6 часов
const HISTORY_FILE    = path.join(__dirname, "history.json");
const SUBS_FILE       = path.join(__dirname, "subs.json"); // Файл для хранения подписок
const UPLOADS_DIR     = path.join(__dirname, "uploads");
const SAVE_INTERVAL   = 10 * 1000; 

// Инициализация Web Push
if (VAPID_PUBLIC && VAPID_PRIVATE) {
  webpush.setVapidDetails("mailto:admin@rusteryerka.ru", VAPID_PUBLIC, VAPID_PRIVATE);
}

// Создаем папку для картинок, если её нет
if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

// =====================================================
// ПОДПИСКИ НА УВЕДОМЛЕНИЯ
// =====================================================
let subscriptions = {};
try {
  if (fs.existsSync(SUBS_FILE)) {
    const raw = fs.readFileSync(SUBS_FILE, "utf-8");
    subscriptions = JSON.parse(raw) || {};
  }
} catch (e) {
  subscriptions = {};
}

function saveSubs() {
  try { fs.writeFileSync(SUBS_FILE, JSON.stringify(subscriptions), "utf-8"); } 
  catch (e) { console.warn("Не удалось сохранить подписки:", e.message); }
}

// =====================================================
// ИСТОРИЯ И ОЧИСТКА
// =====================================================
let history = [];

function loadHistory() {
  try {
    if (fs.existsSync(HISTORY_FILE)) {
      const raw = fs.readFileSync(HISTORY_FILE, "utf-8");
      history = JSON.parse(raw) || [];
      console.log(`История загружена: ${history.length} сообщений`);
    }
  } catch (e) {
    console.warn("Не удалось загрузить историю:", e.message);
    history = [];
  }
}

function saveHistory() {
  try { fs.writeFileSync(HISTORY_FILE, JSON.stringify(history), "utf-8"); } 
  catch (e) { console.warn("Не удалось сохранить историю:", e.message); }
}

loadHistory();
setInterval(saveHistory, SAVE_INTERVAL);

// ЧИСТИЛЬЩИК КАРТИНОК (Запускается каждые 15 минут)
setInterval(() => {
  const now = Date.now();
  let needSave = false;

  history.forEach(msg => {
    if (msg.imageUrl && !msg.imageExpired && (now - msg.imageTimestamp > TTL_6_HOURS)) {
      try {
        const filepath = path.join(UPLOADS_DIR, path.basename(msg.imageUrl));
        if (fs.existsSync(filepath)) fs.unlinkSync(filepath);
      } catch (e) { console.error("Ошибка удаления файла:", e.message); }
      
      msg.imageExpired = true;
      delete msg.imageUrl;
      needSave = true;
      
      broadcast({ type: "image-expired", id: msg.id });
    }
  });

  if (needSave) saveHistory();
}, 15 * 60 * 1000);

// =====================================================
// HTTP-сервер
// =====================================================
const MIME = { 
  ".html": "text/html", ".css": "text/css", ".js": "application/javascript", ".json": "application/json", 
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp" 
};

const httpServer = http.createServer((req, res) => {
  if (req.url === "/ping") { res.writeHead(200, { "Content-Type": "text/plain" }); return res.end("pong"); }
  const url = req.url === "/" ? "/index.html" : req.url;
  const filePath = path.join(__dirname, url);
  const ext = path.extname(filePath).toLowerCase();
  
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); return res.end("Not found"); }
    res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream", "Cache-Control": ext.match(/jpg|jpeg|png|webp/) ? "public, max-age=86400" : "no-cache" });
    res.end(data);
  });
});

// =====================================================
// WebSocket и Рассылка Push
// =====================================================
const wss = new WebSocketServer({ server: httpServer });
const clients = new Map();

function broadcast(payload, exclude = null) {
  const data = JSON.stringify(payload);
  for (const [client, info] of clients) {
    if (client !== exclude && client.readyState === 1 && info.auth) client.send(data);
  }
}

function broadcastOnline() {
  const activeUsers = [...clients.values()].filter(c => c.auth && c.name).map(c => c.name);
  broadcast({ type: "online", count: activeUsers.length, users: activeUsers });
}

function send(ws, payload) { if (ws.readyState === 1) ws.send(JSON.stringify(payload)); }

// Функция отправки фоновых уведомлений
async function sendPushNotification(senderName, text) {
  if (!VAPID_PUBLIC || !VAPID_PRIVATE) return;

  const payload = JSON.stringify({ title: senderName, body: text || "🖼️ Фотография" });
  
  // Собираем тех, кто сейчас сидит в чате (им пуши слать не нужно)
  const onlineNames = new Set([...clients.values()].filter(c => c.auth).map(c => c.name));

  for (const name in subscriptions) {
    // Не отправляем уведомление самому себе и тем, кто онлайн
    if (name === senderName || onlineNames.has(name)) continue;

    webpush.sendNotification(subscriptions[name], payload).catch(err => {
      // Если подписка протухла (пользователь удалил приложение), удаляем её
      if (err.statusCode === 410) {
        delete subscriptions[name];
        saveSubs();
      }
    });
  }
}

wss.on("connection", (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  if (clients.size >= MAX_CLIENTS) {
    send(ws, { type: "error", code: "full", text: `Чат заполнен. Максимум участников — ${MAX_CLIENTS}.` });
    ws.close(); return;
  }

  clients.set(ws, { name: "Аноним", auth: false });
  
  if (!PASSWORD) {
    clients.get(ws).auth = true; 
    send(ws, { type: "auth-ok" });
  } else {
    send(ws, { type: "need-password" });
  }

  ws.on("message", (data) => {
    let parsed;
    try { parsed = JSON.parse(data.toString()); } catch { return; }
    const clientInfo = clients.get(ws);
    if (!clientInfo) return;

    if (parsed.type === "auth") {
      if (!PASSWORD || parsed.password === PASSWORD) {
        clientInfo.auth = true;
        send(ws, { type: "auth-ok" });
      } else {
        send(ws, { type: "error", code: "wrong-password", text: "Неверный пароль." });
        ws.close();
      }
      return;
    }

    if (!clientInfo.auth) return;

    // Регистрация токена устройства для Push-уведомлений
    if (parsed.type === "push-subscribe") {
      subscriptions[clientInfo.name] = parsed.subscription;
      saveSubs();
      return;
    }

    if (parsed.type === "join") {
      const name = (parsed.name || "Аноним").slice(0, 20).trim();
      clientInfo.name = name;
      // Передаем публичный ключ клиенту вместе с историей
      send(ws, { type: "history", messages: history, vapidPublicKey: VAPID_PUBLIC });
      broadcast({ type: "system", text: `${name} вошёл в чат` });
      broadcastOnline(); return;
    }

    if (parsed.type === "typing") { broadcast({ type: "typing", name: clientInfo.name, isTyping: parsed.isTyping }, ws); return; }

    if (parsed.type === "mark-read") {
      const msg = history.find(m => m.id === parsed.id);
      if (msg && !msg.read && msg.name !== clientInfo.name) {
        msg.read = true; broadcast({ type: "msg-read", id: parsed.id });
      }
      return;
    }

    if (parsed.type === "delete") {
      const idx = history.findIndex(m => m.id === parsed.id);
      if (idx !== -1 && history[idx].name === clientInfo.name) {
        if (history[idx].imageUrl) {
          try { fs.unlinkSync(path.join(UPLOADS_DIR, path.basename(history[idx].imageUrl))); } catch(e){}
        }
        history.splice(idx, 1); saveHistory(); broadcast({ type: "delete", id: parsed.id });
      }
      return;
    }

    if (parsed.type === "edit") {
      const msg = history.find(m => m.id === parsed.id);
      if (msg && msg.name === clientInfo.name) {
        msg.text = (parsed.text || "").slice(0, 10000).trim();
        msg.edited = true; saveHistory(); broadcast({ type: "edit", id: parsed.id, text: msg.text });
      }
      return;
    }

    if (parsed.type === "message") {
      const text = (parsed.text || "").slice(0, 10000).trim();
      let imageUrl = null;
      let imageTimestamp = null;

      if (parsed.imageBase64 && typeof parsed.imageBase64 === "string") {
        const matches = parsed.imageBase64.match(/^data:image\/([a-zA-Z0-9]+);base64,(.+)$/);
        if (matches && matches.length === 3) {
          const ext = matches[1] === "jpeg" ? "jpg" : matches[1];
          const imgData = Buffer.from(matches[2], "base64");
          const filename = `${Date.now()}-${Math.random().toString(36).substring(2,8)}.${ext}`;
          fs.writeFileSync(path.join(UPLOADS_DIR, filename), imgData);
          imageUrl = `/uploads/${filename}`;
          imageTimestamp = Date.now();
        }
      }

      if (!text && !imageUrl) return;

      const message = {
        id: parsed.id || Date.now().toString(36) + Math.random().toString(36).substring(2, 6),
        name: clientInfo.name,
        text,
        time: new Date().toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" }),
        read: false,
        replyTo: parsed.replyTo || null
      };

      if (imageUrl) {
        message.imageUrl = imageUrl;
        message.imageTimestamp = imageTimestamp;
      }

      history.push(message);
      if (history.length > MAX_HISTORY) history.shift();
      saveHistory(); // Сохраняем сразу — не ждём интервала
      broadcast({ type: "message", message }, ws);
      
      // Запускаем рассылку уведомлений
      sendPushNotification(clientInfo.name, text);
    }
  });

  ws.on("close", () => {
    const info = clients.get(ws); clients.delete(ws);
    if (info?.auth && info.name) broadcast({ type: "system", text: `${info.name} покинул чат` });
    broadcastOnline();
  });
});

const pingInterval = setInterval(() => {
  wss.clients.forEach((ws) => { if (ws.isAlive === false) return ws.terminate(); ws.isAlive = false; ws.ping(); });
}, 30000);

wss.on('close', () => clearInterval(pingInterval));
process.on("SIGTERM", () => { saveHistory(); process.exit(0); });
process.on("SIGINT",  () => { saveHistory(); process.exit(0); });

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => console.log(`Сервер запущен на порту ${PORT}`));
