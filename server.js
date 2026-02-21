const http = require("http");
const fs = require("fs");
const path = require("path");
const { WebSocketServer } = require("ws");

const httpServer = http.createServer((req, res) => {
  const filePath = path.join(__dirname, "index.html");
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      return res.end("Not found");
    }
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server: httpServer });

// Теперь храним не просто сокеты, а Map: ws → { name }
const clients = new Map();

const MAX_HISTORY = 100;
const history = [];

// Рассылка пакета всем или всем кроме одного
function broadcast(payload, exclude = null) {
  const data = JSON.stringify(payload);
  for (const [client] of clients) {
    if (client !== exclude && client.readyState === 1) {
      client.send(data);
    }
  }
}

// Считаем онлайн и рассылаем всем
function broadcastOnline() {
  broadcast({ type: "online", count: clients.size });
}

wss.on("connection", (ws) => {
  // Временное имя до получения join
  clients.set(ws, { name: "Аноним" });

  ws.on("message", (data) => {
    let parsed;
    try {
      parsed = JSON.parse(data.toString());
    } catch {
      return;
    }

    // --- Пользователь представился ---
    if (parsed.type === "join") {
      const name = (parsed.name || "Аноним").slice(0, 20).trim();
      clients.set(ws, { name });

      // Отправляем историю новому участнику
      if (history.length > 0) {
        ws.send(JSON.stringify({ type: "history", messages: history }));
      }

      // Уведомляем всех о новом участнике
      broadcast({ type: "system", text: `${name} вошёл в чат` });
      broadcastOnline();

      console.log(`${name} подключился. Всего: ${clients.size}`);
      return;
    }

    // --- Индикатор "печатает..." ---
    if (parsed.type === "typing") {
      const { name } = clients.get(ws);
      // Рассылаем всем кроме отправителя
      broadcast({ type: "typing", name, isTyping: parsed.isTyping }, ws);
      return;
    }

    // --- Обычное сообщение ---
    if (parsed.type === "message") {
      const { name } = clients.get(ws);
      const message = {
        name,
        text: parsed.text,
        time: new Date().toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" }),
      };

      history.push(message);
      if (history.length > MAX_HISTORY) history.shift();

      // Отправляем всем кроме отправителя
      broadcast({ type: "message", message }, ws);
    }
  });

  ws.on("close", () => {
    const { name } = clients.get(ws) || {};
    clients.delete(ws);

    if (name) {
      broadcast({ type: "system", text: `${name} покинул чат` });
    }
    broadcastOnline();
    console.log(`${name || "?"} отключился. Осталось: ${clients.size}`);
  });
});

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
  console.log(`Сервер запущен на порту ${PORT}`);
});
