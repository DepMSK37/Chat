// Версия кэша: 1.1.8 (Web Push Edition)
// sw.js — Service Worker
// Этот файл запускается браузером в фоне и умеет показывать уведомления на Android

self.addEventListener("install", () => {
  // Активируем воркер сразу, не ждём перезагрузки страницы
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(self.clients.claim());
});

// Слушаем сообщения от основной страницы (локальные уведомления)
self.addEventListener("message", (event) => {
  if (event.data?.type === "show-notification") {
    const { title, body } = event.data;
    self.registration.showNotification(title, {
      body,
      icon: "/icon.png",
      badge: "/icon.png",
      tag: "chat-msg",
      renotify: true,
    });
  }
});

// НОВОЕ: Ловим фоновые Push-уведомления от серверов Google
self.addEventListener("push", (event) => {
  let data = { title: "🕊️ Голубь", body: "Новое сообщение" };
  
  try {
    if (event.data) {
      data = event.data.json();
    }
  } catch (e) {
    if (event.data) {
      data.body = event.data.text();
    }
  }

  const options = {
    body: data.body,
    icon: "/icon.png",
    badge: "/icon.png",
    tag: "chat-msg",
    renotify: true,
    vibrate: [200, 100, 200], // Добавлена вибрация
    data: { url: "/" }
  };

  event.waitUntil(self.registration.showNotification(data.title, options));
});

// При клике на уведомление — открываем или фокусируем вкладку чата
self.addEventListener("notificationclick", (event) => {
  event.notification.close();

  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      // Если вкладка уже открыта — фокусируем её
      for (const client of list) {
        if (client.url.includes(self.location.origin) && "focus" in client) {
          return client.focus();
        }
      }
      // Иначе открываем новую вкладку
      return self.clients.openWindow("/");
    })
  );
});
