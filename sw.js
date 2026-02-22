// Версия кэша: 1.1.0 (Web Push Edition)

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

// ЛОВИМ СИГНАЛ ОТ GOOGLE СЕРВЕРОВ
self.addEventListener("push", (event) => {
  const data = event.data ? event.data.json() : { title: "Голубь", body: "Новое сообщение" };
  
  const options = {
    body: data.body,
    icon: "/icon.png",
    badge: "/icon.png",
    tag: "chat-msg",
    renotify: true,
    data: { url: "/" }
  };

  event.waitUntil(self.registration.showNotification(data.title, options));
});

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
