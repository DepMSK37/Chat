const http = require("http");
const fs   = require("fs");
const path = require("path");
const { WebSocketServer } = require("ws");
const webpush = require("web-push");

// =====================================================
// НАСТРОЙКИ
// =====================================================
const PASSWORD        = process.env.PASSWORD || null;
const VAPID_PUBLIC    = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE   = process.env.VAPID_PRIVATE_KEY;
const MAX_CLIENTS     = 15;
const MAX_HISTORY     = 500;
const TTL_6_HOURS     = 6 * 60 * 60 * 1000;
const HISTORY_FILE    = path.join(__dirname, "history.json");
const PRIVATE_FILE    = path.join(__dirname, "private_chats.json");
const SUBS_FILE       = path.join(__dirname, "subs.json");
const UPLOADS_DIR     = path.join(__dirname, "uploads");
const SAVE_INTERVAL   = 10 * 1000;

// Максимальный размер тела POST-запроса на загрузку файла (25 МБ JSON с base64 ≈ 19 МБ файл)
const MAX_UPLOAD_BODY = 25 * 1024 * 1024;

if (VAPID_PUBLIC && VAPID_PRIVATE) {
  webpush.setVapidDetails("mailto:admin@rusteryerka.ru", VAPID_PUBLIC, VAPID_PRIVATE);
}
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// =====================================================
// PUSH-ПОДПИСКИ
// =====================================================
let subscriptions = {};
try { if (fs.existsSync(SUBS_FILE)) subscriptions = JSON.parse(fs.readFileSync(SUBS_FILE,"utf-8")) || {}; } catch(e){}
function saveSubs() { try { fs.writeFileSync(SUBS_FILE, JSON.stringify(subscriptions),"utf-8"); } catch(e){} }

// =====================================================
// ИСТОРИЯ
// =====================================================
let history = [];
function loadHistory() {
  try { if (fs.existsSync(HISTORY_FILE)) { history = JSON.parse(fs.readFileSync(HISTORY_FILE,"utf-8")) || []; console.log(`История: ${history.length} сообщ.`); } }
  catch(e) { history = []; }
}
function saveHistory() { try { fs.writeFileSync(HISTORY_FILE, JSON.stringify(history),"utf-8"); } catch(e){} }

// =====================================================
// ЛИЧНЫЕ ЧАТЫ
// =====================================================
let privateChats = {};
function loadPrivateChats() {
  try { if (fs.existsSync(PRIVATE_FILE)) { privateChats = JSON.parse(fs.readFileSync(PRIVATE_FILE,"utf-8")) || {}; console.log(`Личных чатов: ${Object.keys(privateChats).length}`); } }
  catch(e) { privateChats = {}; }
}
function savePrivateChats() { try { fs.writeFileSync(PRIVATE_FILE, JSON.stringify(privateChats),"utf-8"); } catch(e){} }
function getPrivateChatId(n1, n2) { return [n1, n2].sort().join("|"); }
function getOrCreatePrivateChat(id) { if (!privateChats[id]) privateChats[id] = { messages:[] }; return privateChats[id]; }

loadHistory();
loadPrivateChats();
setInterval(saveHistory, SAVE_INTERVAL);
setInterval(savePrivateChats, SAVE_INTERVAL);

// =====================================================
// ФАЙЛЫ — СОХРАНЕНИЕ И УДАЛЕНИЕ
// =====================================================
const MIME_EXT = {
  "image/jpeg":"jpg","image/png":"png","image/webp":"webp","image/gif":"gif",
  "audio/ogg":"ogg","audio/webm":"webm","audio/mpeg":"mp3","audio/mp4":"m4a","audio/wav":"wav",
  "video/mp4":"mp4","video/webm":"webm","video/quicktime":"mov",
  "application/pdf":"pdf","application/msword":"doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document":"docx",
  "application/zip":"zip","text/plain":"txt"
};

function tryDeleteFile(url) {
  try { const fp = path.join(UPLOADS_DIR, path.basename(url)); if (fs.existsSync(fp)) fs.unlinkSync(fp); } catch(e){}
}

// Сохраняет base64-строку на диск, возвращает URL или null
function saveBase64File(base64Data, prefix) {
  if (!base64Data || typeof base64Data !== "string") return null;
  const m = base64Data.match(/^data:([^;]+);base64,(.+)$/s);
  if (!m) return null;
  const mime = m[1], raw = m[2];
  const buf = Buffer.from(raw, "base64");
  const ext = MIME_EXT[mime] || mime.split("/")[1]?.replace(/[^a-z0-9]/g,"") || "bin";
  const filename = `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2,7)}.${ext}`;
  fs.writeFileSync(path.join(UPLOADS_DIR, filename), buf);
  return `/uploads/${filename}`;
}

// =====================================================
// ЧИСТИЛЬЩИК МЕДИА (каждые 15 минут)
// =====================================================
function cleanupMessages(messages, broadcastFn, saveF) {
  const now = Date.now(); let dirty = false;
  messages.forEach(msg => {
    if (msg.imageUrl && !msg.imageExpired && now - msg.imageTimestamp > TTL_6_HOURS) {
      tryDeleteFile(msg.imageUrl); msg.imageExpired = true; delete msg.imageUrl; dirty = true;
      if (broadcastFn) broadcastFn({ type:"image-expired", id:msg.id });
    }
    if (msg.voiceUrl && !msg.voiceExpired && now - msg.voiceTimestamp > TTL_6_HOURS) {
      tryDeleteFile(msg.voiceUrl); msg.voiceExpired = true; delete msg.voiceUrl; dirty = true;
      if (broadcastFn) broadcastFn({ type:"media-expired", id:msg.id, kind:"voice" });
    }
    if (msg.fileUrl && !msg.fileExpired && now - msg.fileTimestamp > TTL_6_HOURS) {
      tryDeleteFile(msg.fileUrl); msg.fileExpired = true; delete msg.fileUrl; dirty = true;
      if (broadcastFn) broadcastFn({ type:"media-expired", id:msg.id, kind:"file" });
    }
  });
  if (dirty && saveF) saveF();
}

setInterval(() => {
  cleanupMessages(history, broadcast, saveHistory);
  Object.values(privateChats).forEach(c => cleanupMessages(c.messages, null, savePrivateChats));
}, 15 * 60 * 1000);

// =====================================================
// HTTP-СЕРВЕР
// =====================================================
const HTTP_MIME = {
  ".html":"text/html", ".css":"text/css", ".js":"application/javascript",
  ".json":"application/json", ".png":"image/png", ".jpg":"image/jpeg",
  ".jpeg":"image/jpeg", ".webp":"image/webp", ".gif":"image/gif",
  ".ogg":"audio/ogg", ".webm":"audio/webm", ".mp3":"audio/mpeg",
  ".mp4":"video/mp4", ".pdf":"application/pdf", ".txt":"text/plain", ".wav":"audio/wav"
};

const httpServer = http.createServer((req, res) => {
  res.setHeader("Access-Control-Allow-Origin","*");

  // Эндпоинт загрузки файла — принимает JSON {data, prefix, fileName?, fileMime?}
  // Клиент отправляет base64 через HTTP POST, получает обратно {url, fileName, fileMime}
  // Это позволяет показывать прогресс и не перегружать WebSocket
  if (req.method === "POST" && req.url === "/upload") {
    let body = "";
    let size = 0;
    req.on("data", chunk => {
      size += chunk.length;
      if (size > MAX_UPLOAD_BODY) {
        res.writeHead(413, {"Content-Type":"application/json"});
        res.end(JSON.stringify({error:"Файл слишком большой"}));
        req.destroy();
        return;
      }
      body += chunk;
    });
    req.on("end", () => {
      try {
        const parsed = JSON.parse(body);
        const url = saveBase64File(parsed.data, parsed.prefix || "file");
        if (!url) { res.writeHead(400,{"Content-Type":"application/json"}); res.end(JSON.stringify({error:"Неверные данные"})); return; }
        res.writeHead(200, {"Content-Type":"application/json"});
        res.end(JSON.stringify({ url, fileName: parsed.fileName || null, fileMime: parsed.fileMime || null }));
      } catch(e) {
        res.writeHead(500, {"Content-Type":"application/json"});
        res.end(JSON.stringify({error:"Ошибка сервера"}));
      }
    });
    return;
  }

  if (req.url === "/ping") { res.writeHead(200); return res.end("pong"); }

  const urlPath = req.url === "/" ? "/index.html" : req.url.split("?")[0];
  const filePath = path.join(__dirname, urlPath);
  if (!filePath.startsWith(__dirname)) { res.writeHead(403); return res.end("Forbidden"); }
  const ext = path.extname(filePath).toLowerCase();
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); return res.end("Not found"); }
    const isMedia = /jpg|jpeg|png|webp|gif|ogg|webm|mp3|mp4|pdf|wav/.test(ext);
    res.writeHead(200, {
      "Content-Type": HTTP_MIME[ext] || "application/octet-stream",
      "Cache-Control": isMedia ? "public,max-age=3600" : "no-cache"
    });
    res.end(data);
  });
});

// =====================================================
// WEBSOCKET
// =====================================================
// maxPayload ограничен 1 МБ — только текстовые данные + URL (не base64 файлов!)
const wss = new WebSocketServer({ server: httpServer, maxPayload: 1 * 1024 * 1024 });
const clients = new Map();

function broadcast(payload, exclude=null) {
  const d = JSON.stringify(payload);
  for (const [c, info] of clients) { if (c!==exclude && c.readyState===1 && info.auth) c.send(d); }
}
function sendToPrivate(chatId, payload) {
  const [n1,n2] = chatId.split("|"); const d = JSON.stringify(payload);
  for (const [c,info] of clients) { if (c.readyState===1 && info.auth && (info.name===n1||info.name===n2)) c.send(d); }
}
function broadcastOnline() {
  const u = [...clients.values()].filter(c=>c.auth&&c.name).map(c=>c.name);
  broadcast({ type:"online", count:u.length, users:u });
}
function send(ws, p) { if (ws.readyState===1) ws.send(JSON.stringify(p)); }

async function sendPush(senderName, text) {
  if (!VAPID_PUBLIC||!VAPID_PRIVATE) return;
  const pl = JSON.stringify({ title:senderName, body:text||"📎 Вложение" });
  const online = new Set([...clients.values()].filter(c=>c.auth).map(c=>c.name));
  for (const name in subscriptions) {
    if (name===senderName||online.has(name)) continue;
    webpush.sendNotification(subscriptions[name], pl).catch(e=>{ if(e.statusCode===410){delete subscriptions[name];saveSubs();} });
  }
}

// Построить объект сообщения — все URL уже готовы (загружены через /upload)
function buildMessage(p, authorName) {
  const text = (p.text||"").slice(0,10000).trim();
  // Принимаем только URL (не base64!) — файлы уже загружены через HTTP
  const imageUrl      = (p.imageUrl && p.imageUrl.startsWith("/uploads/")) ? p.imageUrl : null;
  const voiceUrl      = (p.voiceUrl && p.voiceUrl.startsWith("/uploads/")) ? p.voiceUrl : null;
  const fileUrl       = (p.fileUrl  && p.fileUrl.startsWith("/uploads/"))  ? p.fileUrl  : null;
  const fileName      = fileUrl ? (p.fileName||"файл").slice(0,200) : null;
  const fileMime      = fileUrl ? (p.fileMime||"application/octet-stream") : null;

  if (!text && !imageUrl && !voiceUrl && !fileUrl) return null;

  const msg = {
    id: p.id || Date.now().toString(36)+Math.random().toString(36).slice(2,6),
    name: authorName, text,
    time: new Date().toLocaleTimeString("ru-RU",{hour:"2-digit",minute:"2-digit"}),
    read: false, replyTo: p.replyTo || null
  };
  const ts = Date.now();
  if (imageUrl) { msg.imageUrl=imageUrl; msg.imageTimestamp=ts; }
  if (voiceUrl) { msg.voiceUrl=voiceUrl; msg.voiceTimestamp=ts; }
  if (fileUrl)  { msg.fileUrl=fileUrl; msg.fileTimestamp=ts; msg.fileName=fileName; msg.fileMime=fileMime; }
  return msg;
}

wss.on("connection", (ws) => {
  ws.isAlive = true;
  ws.on("pong", ()=>{ ws.isAlive=true; });
  if (clients.size>=MAX_CLIENTS) { send(ws,{type:"error",code:"full",text:`Чат заполнен (макс. ${MAX_CLIENTS}).`}); ws.close(); return; }
  clients.set(ws, { name:"Аноним", auth:false });
  if (!PASSWORD) { clients.get(ws).auth=true; send(ws,{type:"auth-ok"}); }
  else { send(ws,{type:"need-password"}); }

  ws.on("message", (data) => {
    let p; try { p=JSON.parse(data.toString()); } catch { return; }
    const ci = clients.get(ws); if (!ci) return;

    if (p.type==="auth") {
      if (!PASSWORD||p.password===PASSWORD) { ci.auth=true; send(ws,{type:"auth-ok"}); }
      else { send(ws,{type:"error",code:"wrong-password",text:"Неверный пароль."}); ws.close(); }
      return;
    }
    if (!ci.auth) return;

    if (p.type==="push-subscribe") { subscriptions[ci.name]=p.subscription; saveSubs(); return; }

    if (p.type==="join") {
      ci.name=(p.name||"Аноним").slice(0,20).trim();
      send(ws,{type:"history",messages:history,vapidPublicKey:VAPID_PUBLIC});
      broadcast({type:"system",text:`${ci.name} вошёл в чат`});
      broadcastOnline(); return;
    }

    if (p.type==="typing") { broadcast({type:"typing",name:ci.name,isTyping:p.isTyping},ws); return; }

    if (p.type==="mark-read") {
      const msg=history.find(m=>m.id===p.id);
      if (msg&&!msg.read&&msg.name!==ci.name) { msg.read=true; broadcast({type:"msg-read",id:p.id}); }
      return;
    }

    if (p.type==="delete") {
      const idx=history.findIndex(m=>m.id===p.id);
      if (idx!==-1&&history[idx].name===ci.name) {
        const m=history[idx];
        if(m.imageUrl) tryDeleteFile(m.imageUrl);
        if(m.voiceUrl) tryDeleteFile(m.voiceUrl);
        if(m.fileUrl)  tryDeleteFile(m.fileUrl);
        history.splice(idx,1); saveHistory(); broadcast({type:"delete",id:p.id});
      }
      return;
    }

    if (p.type==="edit") {
      const msg=history.find(m=>m.id===p.id);
      if (msg&&msg.name===ci.name) { msg.text=(p.text||"").slice(0,10000).trim(); msg.edited=true; saveHistory(); broadcast({type:"edit",id:p.id,text:msg.text}); }
      return;
    }

    if (p.type==="message") {
      const msg=buildMessage(p,ci.name); if (!msg) return;
      history.push(msg); if (history.length>MAX_HISTORY) history.shift();
      saveHistory();
      // Рассылаем всем, ВКЛЮЧАЯ отправителя — он получит сообщение с финальным URL
      broadcast({type:"message",message:msg});
      sendPush(ci.name, msg.text);
      return;
    }

    // =====================================================
    // ЛИЧНЫЕ ЧАТЫ
    // =====================================================
    if (p.type==="open-private") {
      const wn=(p.with||"").trim(); if (!wn||wn===ci.name) return;
      const chatId=getPrivateChatId(ci.name,wn);
      const chat=getOrCreatePrivateChat(chatId);
      send(ws,{type:"private-opened",chatId,with:wn,messages:chat.messages});
      return;
    }

    if (p.type==="get-private-chats") {
      const list=[];
      for (const [chatId,chat] of Object.entries(privateChats)) {
        const parts=chatId.split("|"); if (!parts.includes(ci.name)) continue;
        const wn=parts.find(x=>x!==ci.name);
        const last=chat.messages[chat.messages.length-1]||null;
        list.push({chatId,with:wn,
          lastMessage: last ? {text:last.text,time:last.time,name:last.name,hasVoice:!!last.voiceUrl,hasFile:!!last.fileUrl,hasImage:!!last.imageUrl} : null,
          messageCount:chat.messages.length
        });
      }
      list.sort((a,b)=>b.messageCount-a.messageCount);
      send(ws,{type:"private-chats-list",chats:list});
      return;
    }

    if (p.type==="private-message") {
      const chatId=p.chatId; if (!chatId) return;
      const parts=chatId.split("|"); if (!parts.includes(ci.name)) return;
      const msg=buildMessage(p,ci.name); if (!msg) return;
      const chat=getOrCreatePrivateChat(chatId);
      chat.messages.push(msg); if (chat.messages.length>MAX_HISTORY) chat.messages.shift();
      savePrivateChats();
      // Рассылаем обоим участникам (включая отправителя)
      sendToPrivate(chatId,{type:"private-message",chatId,message:msg});
      const other=parts.find(x=>x!==ci.name);
      const otherOnline=[...clients.values()].some(c=>c.auth&&c.name===other);
      if (!otherOnline) sendPush(ci.name,`💬 ${msg.text||"Вложение"}`);
      return;
    }

    if (p.type==="private-mark-read") {
      const c=privateChats[p.chatId]; if (!c) return;
      const msg=c.messages.find(m=>m.id===p.id);
      if (msg&&!msg.read&&msg.name!==ci.name) { msg.read=true; sendToPrivate(p.chatId,{type:"private-msg-read",chatId:p.chatId,id:p.id}); }
      return;
    }

    if (p.type==="private-delete") {
      const c=privateChats[p.chatId]; if (!c) return;
      const idx=c.messages.findIndex(m=>m.id===p.id);
      if (idx!==-1&&c.messages[idx].name===ci.name) {
        const m=c.messages[idx];
        if(m.imageUrl) tryDeleteFile(m.imageUrl);
        if(m.voiceUrl) tryDeleteFile(m.voiceUrl);
        if(m.fileUrl)  tryDeleteFile(m.fileUrl);
        c.messages.splice(idx,1); savePrivateChats();
        sendToPrivate(p.chatId,{type:"private-delete",chatId:p.chatId,id:p.id});
      }
      return;
    }
  });

  ws.on("close", () => {
    const info=clients.get(ws); clients.delete(ws);
    if (info?.auth&&info.name) broadcast({type:"system",text:`${info.name} покинул чат`});
    broadcastOnline();
  });
});

const pingInterval = setInterval(()=>{
  wss.clients.forEach(ws=>{ if(!ws.isAlive) return ws.terminate(); ws.isAlive=false; ws.ping(); });
},30000);
wss.on("close",()=>clearInterval(pingInterval));

process.on("SIGTERM",()=>{ saveHistory(); savePrivateChats(); process.exit(0); });
process.on("SIGINT", ()=>{ saveHistory(); savePrivateChats(); process.exit(0); });

const PORT = process.env.PORT||3000;
httpServer.listen(PORT,()=>console.log(`Сервер запущен на порту ${PORT}`));
