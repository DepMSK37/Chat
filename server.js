const http = require("http");
const fs = require("fs");
const path = require("path");
const { WebSocketServer } = require("ws");

// =====================================================
// НАСТРОЙКИ
// =====================================================
const PASSWORD        = process.env.PASSWORD || null;
const MAX_CLIENTS     = 15;
const MAX_HISTORY     = 500;
const HISTORY_FILE    = path.join(__dirname, "history.json");
const SAVE_INTERVAL   = 10 * 1000; // сохранять на диск каждые 10 секунд

// =====================================================
// ИСТОРИЯ — загружаем с диска при старте
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
  try {
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(history), "utf-8");
  } catch (e) {
    console.warn("Не удалось сохранить историю:", e.message);
  }
}

// Загружаем историю при запуске сервера
loadHistory();

// Периодически сохраняем на диск
setInterval(saveHistory, SAVE_INTERVAL);

// =====================================================
// HTTP-сервер
// =====================================================
const MIME = {
  ".html": "text/html",
  ".js":   "application/javascript",
  ".json": "application/json",
  ".png":  "image/png",
};

const httpServer = http.createServer((req, res) => {

  // ── Keep-alive эндпоинт ──────────────────────────
  // UptimeRobot будет стучаться сюда каждые 5 минут
  // чтобы сервер не засыпал
  if (req.url === "/ping") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    return res.end("pong");
  }

  // ── Статические файлы ────────────────────────────
  const url = req.url === "/" ? "/index.html" : req.url;
  const filePath = path.join(__dirname, url);
  const ext = path.extname(filePath);

  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); return res.end("Not found"); }
    res.writeHead(200, { "Content-Type": MIME[ext] || "text/plain" });
    res.end(data);
  });
});

// =====================================================
// WebSocket
// =====================================================
const wss = new WebSocketServer({ server: httpServer });
const clients = new Map();

function broadcast(payload, exclude = null) {
  const data = JSON.stringify(payload);
  for (const [client, info] of clients) {
    if (client !== exclude && client.readyState === 1 && info.auth) {
      client.send(data);
    }
  }
}

function broadcastOnline() {
  const count = [...clients.values()].filter(c => c.auth).length;
  broadcast({ type: "online", count });
}

function send(ws, payload) {
  if (ws.readyState === 1) ws.send(JSON.stringify(payload));
}

wss.on("connection", (ws) => {

  if (clients.size >= MAX_CLIENTS) {
    send(ws, { type: "error", code: "full", text: `Чат заполнен. Максимум участников — ${MAX_CLIENTS}.` });
    ws.close();
    return;
  }

  clients.set(ws, { name: "Аноним", auth: false });

  if (!PASSWORD) {
    clients.get(ws).auth = true;
  } else {
    send(ws, { type: "need-password" });
  }

  ws.on("message", (data) => {
    let parsed;
    try { parsed = JSON.parse(data.toString()); }
    catch { return; }

    const clientInfo = clients.get(ws);
    if (!clientInfo) return;

    // ── Проверка пароля ──────────────────────────────
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

    // ── Вход ─────────────────────────────────────────
    if (parsed.type === "join") {
      const name = (parsed.name || "Аноним").slice(0, 20).trim();
      clientInfo.name = name;

      if (history.length > 0) {
        send(ws, { type: "history", messages: history });
      }

      broadcast({ type: "system", text: `${name} вошёл в чат` });
      broadcastOnline();
      console.log(`${name} вошёл. Онлайн: ${[...clients.values()].filter(c => c.auth).length}`);
      return;
    }

    // ── Печатает ─────────────────────────────────────
    if (parsed.type === "typing") {
      broadcast({ type: "typing", name: clientInfo.name, isTyping: parsed.isTyping }, ws);
      return;
    }

    // ── Сообщение ────────────────────────────────────
    if (parsed.type === "message") {
      const text = (parsed.text || "").slice(0, 2000).trim();
      if (!text) return;

      const message = {
        name: clientInfo.name,
        text,
        time: new Date().toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" }),
      };

      history.push(message);
      if (history.length > MAX_HISTORY) history.shift();

      // Сохраняем сразу при каждом новом сообщении
      saveHistory();

      broadcast({ type: "message", message }, ws);
    }
  });

  ws.on("close", () => {
    const info = clients.get(ws);
    clients.delete(ws);
    if (info?.auth && info.name) {
      broadcast({ type: "system", text: `${info.name} покинул чат` });
    }
    broadcastOnline();
  });
});

// Сохраняем историю при штатном завершении процесса
process.on("SIGTERM", () => { saveHistory(); process.exit(0); });
process.on("SIGINT",  () => { saveHistory(); process.exit(0); });

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
  console.log(`Сервер запущен на порту ${PORT}`);
  if (PASSWORD) console.log(`Пароль установлен. Лимит: ${MAX_CLIENTS} участников`);
  else          console.log("⚠️  Пароль не задан — вход свободный");
});
