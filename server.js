const http = require("http");
const fs = require("fs");
const path = require("path");
const { WebSocketServer } = require("ws");

// Какой Content-Type отдавать для каждого расширения
const MIME = {
  ".html": "text/html",
  ".js":   "application/javascript",
  ".json": "application/json",
  ".png":  "image/png",
};

const httpServer = http.createServer((req, res) => {
  // Отдаём статические файлы: index.html, sw.js, manifest.json
  const url = req.url === "/" ? "/index.html" : req.url;
  const filePath = path.join(__dirname, url);
  const ext = path.extname(filePath);

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      return res.end("Not found");
    }
    res.writeHead(200, { "Content-Type": MIME[ext] || "text/plain" });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server: httpServer });
const clients = new Map();
const MAX_HISTORY = 100;
const history = [];

function broadcast(payload, exclude = null) {
  const data = JSON.stringify(payload);
  for (const [client] of clients) {
    if (client !== exclude && client.readyState === 1) {
      client.send(data);
    }
  }
}

function broadcastOnline() {
  broadcast({ type: "online", count: clients.size });
}

wss.on("connection", (ws) => {
  clients.set(ws, { name: "Аноним" });

  ws.on("message", (data) => {
    let parsed;
    try { parsed = JSON.parse(data.toString()); }
    catch { return; }

    if (parsed.type === "join") {
      const name = (parsed.name || "Аноним").slice(0, 20).trim();
      clients.set(ws, { name });

      if (history.length > 0) {
        ws.send(JSON.stringify({ type: "history", messages: history }));
      }

      broadcast({ type: "system", text: `${name} вошёл в чат` });
      broadcastOnline();
      return;
    }

    if (parsed.type === "typing") {
      const { name } = clients.get(ws);
      broadcast({ type: "typing", name, isTyping: parsed.isTyping }, ws);
      return;
    }

    if (parsed.type === "message") {
      const { name } = clients.get(ws);
      const message = {
        name,
        text: parsed.text,
        time: new Date().toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" }),
      };

      history.push(message);
      if (history.length > MAX_HISTORY) history.shift();

      broadcast({ type: "message", message }, ws);
    }
  });

  ws.on("close", () => {
    const { name } = clients.get(ws) || {};
    clients.delete(ws);
    if (name) broadcast({ type: "system", text: `${name} покинул чат` });
    broadcastOnline();
  });
});

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
  console.log(`Сервер запущен на порту ${PORT}`);
});
