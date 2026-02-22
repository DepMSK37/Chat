// Версия кэша: 1.1.0 (Web Push Edition)

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

// ЛОВИМ СИГНАЛ ОТ GOOGLE СЕРВЕРОВ (Даже если браузер закрыт)
self.addEventListener("push", (event) => {
  let data = { title: "Голубь", body: "Новое сообщение" };
  try {
    data = event.data ? event.data.json() : data;
  } catch (e) {
    data = { title: "Голубь", body: event.data.text() || "Новое сообщение" };
  }
  
  const options = {
    body: data.body,
    icon: "/icon.png",
    badge: "/icon.png",
    tag: "chat-msg",
    renotify: true,
    vibrate: [200, 100, 200],
    data: { url: "/" }
  };

  event.waitUntil(self.registration.showNotification(data.title, options));
});

// Клик по уведомлению
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      for (const client of list) {
        if (client.url.includes(self.location.origin) && "focus" in client) return client.focus();
      }
      return self.clients.openWindow("/");
    })
  );
});
