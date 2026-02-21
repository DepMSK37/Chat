const http = require("http");
const fs = require("fs");
const path = require("path");
const { WebSocketServer } = require("ws");

// =====================================================
// НАСТРОЙКИ
// =====================================================
// Пароль берётся из переменной окружения Railway.
// Локально можно запустить так: PASSWORD=секрет node server.js
// Если переменная не задана — вход без пароля (только для локальной разработки)
const PASSWORD     = process.env.PASSWORD || null;
const MAX_CLIENTS  = 15;    // максимум участников одновременно
const MAX_HISTORY  = 500;   // сколько сообщений хранить

// =====================================================

const MIME = {
  ".html": "text/html",
  ".js":   "application/javascript",
  ".json": "application/json",
  ".png":  "image/png",
};

const httpServer = http.createServer((req, res) => {
  const url = req.url === "/" ? "/index.html" : req.url;
  const filePath = path.join(__dirname, url);
  const ext = path.extname(filePath);

  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); return res.end("Not found"); }
    res.writeHead(200, { "Content-Type": MIME[ext] || "text/plain" });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server: httpServer });

// Map: ws → { name, auth }
// auth: true = прошёл проверку пароля, false = ещё нет
const clients = new Map();
const history = [];

// =====================================================
// Утилиты
// =====================================================

function broadcast(payload, exclude = null) {
  const data = JSON.stringify(payload);
  for (const [client, info] of clients) {
    // Рассылаем только авторизованным клиентам
    if (client !== exclude && client.readyState === 1 && info.auth) {
      client.send(data);
    }
  }
}

function broadcastOnline() {
  // Считаем только авторизованных
  const count = [...clients.values()].filter(c => c.auth).length;
  broadcast({ type: "online", count });
}

function send(ws, payload) {
  if (ws.readyState === 1) ws.send(JSON.stringify(payload));
}

// =====================================================
// WebSocket
// =====================================================

wss.on("connection", (ws) => {

  // Проверяем лимит ДО авторизации
  // Считаем всех (включая ещё не авторизованных) чтобы не допустить обход через спам подключений
  if (clients.size >= MAX_CLIENTS) {
    send(ws, { type: "error", code: "full", text: "Чат заполнен. Максимум участников — " + MAX_CLIENTS + "." });
    ws.close();
    return;
  }

  // Добавляем клиента как неавторизованного
  clients.set(ws, { name: "Аноним", auth: false });

  // Если пароль не задан — сразу помечаем как авторизованного
  if (!PASSWORD) {
    clients.get(ws).auth = true;
  } else {
    // Просим клиента ввести пароль
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
        console.log("Клиент авторизован");
      } else {
        // Неверный пароль — даём 1 попытку и закрываем соединение
        send(ws, { type: "error", code: "wrong-password", text: "Неверный пароль." });
        ws.close();
      }
      return;
    }

    // Все остальные пакеты — только для авторизованных
    if (!clientInfo.auth) {
      send(ws, { type: "error", code: "not-auth", text: "Не авторизован." });
      return;
    }

    // ── Вход в чат (имя) ────────────────────────────
    if (parsed.type === "join") {
      const name = (parsed.name || "Аноним").slice(0, 20).trim();
      clientInfo.name = name;

      // Отдаём историю только авторизованному пользователю
      if (history.length > 0) {
        send(ws, { type: "history", messages: history });
      }

      broadcast({ type: "system", text: `${name} вошёл в чат` });
      broadcastOnline();
      console.log(`${name} вошёл. Онлайн: ${[...clients.values()].filter(c => c.auth).length}`);
      return;
    }

    // ── Индикатор печатает ───────────────────────────
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

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
  console.log(`Сервер запущен на порту ${PORT}`);
  if (PASSWORD) {
    console.log(`Пароль установлен. Лимит участников: ${MAX_CLIENTS}`);
  } else {
    console.log("⚠️  Пароль не задан (переменная PASSWORD пуста). Вход свободный.");
  }
});
