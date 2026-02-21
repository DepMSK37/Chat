const http = require("http");
const fs = require("fs");
const path = require("path");
const { WebSocketServer } = require("ws");

// --- HTTP-сервер: отдаёт index.html браузеру ---
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

// --- WebSocket-сервер поверх того же HTTP-порта ---
const wss = new WebSocketServer({ server: httpServer });

// Храним всех подключённых клиентов
const clients = new Set();

wss.on("connection", (ws) => {
  clients.add(ws);
  console.log(`Новый клиент. Всего: ${clients.size}`);

  // Получили сообщение от одного клиента → рассылаем всем остальным
  ws.on("message", (data) => {
    const text = data.toString();
    console.log("Сообщение:", text);

    for (const client of clients) {
      // readyState === 1 означает, что соединение открыто
      if (client !== ws && client.readyState === 1) {
        client.send(text);
      }
    }
  });

  // Клиент отключился — убираем из списка
  ws.on("close", () => {
    clients.delete(ws);
    console.log(`Клиент ушёл. Осталось: ${clients.size}`);
  });
});

// Railway сам назначает PORT через переменную окружения
// Локально будет использоваться порт 3000
const PORT = process.env.PORT || 3000;

httpServer.listen(PORT, () => {
  console.log(`Сервер запущен на порту ${PORT}`);
});
