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

const clients = new Set();

// Хранилище истории — максимум 100 последних сообщений
const MAX_HISTORY = 100;
const history = [];

wss.on("connection", (ws) => {
  clients.add(ws);
  console.log(`Новый клиент. Всего: ${clients.size}`);

  // Отправляем новому клиенту всю историю сразу при подключении
  if (history.length > 0) {
    ws.send(JSON.stringify({ type: "history", messages: history }));
  }

  ws.on("message", (data) => {
    let parsed;

    // Парсим входящее сообщение
    try {
      parsed = JSON.parse(data.toString());
    } catch {
      return; // Игнорируем невалидный JSON
    }

    // Добавляем время на сервере — клиент не может подделать
    const message = {
      text: parsed.text,
      time: new Date().toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" }),
    };

    // Сохраняем в историю, обрезаем если превысили лимит
    history.push(message);
    if (history.length > MAX_HISTORY) history.shift();

    console.log("Сообщение:", message.text);

    // Рассылаем всем клиентам кроме отправителя
    const payload = JSON.stringify({ type: "message", message });

    for (const client of clients) {
      if (client !== ws && client.readyState === 1) {
        client.send(payload);
      }
    }
  });

  ws.on("close", () => {
    clients.delete(ws);
    console.log(`Клиент ушёл. Осталось: ${clients.size}`);
  });
});

const PORT = process.env.PORT || 3000;

httpServer.listen(PORT, () => {
  console.log(`Сервер запущен на порту ${PORT}`);
});
