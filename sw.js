// Версия кэша: 1.0.4
// sw.js — Service Worker
// Этот файл запускается браузером в фоне и умеет показывать уведомления на Android

self.addEventListener("install", () => {
  // Активируем воркер сразу, не ждём перезагрузки страницы
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(self.clients.claim());
});

// Слушаем сообщения от основной страницы
self.addEventListener("message", (event) => {
  if (event.data?.type === "show-notification") {
    const { title, body } = event.data;

    // Показываем уведомление через Service Worker — именно так работает на Android
    self.registration.showNotification(title, {
      body,
      icon: "/icon.png",   // если нет файла — просто игнорируется
      badge: "/icon.png",
      tag: "chat-msg",     // одно уведомление заменяет предыдущее
      renotify: true,      // звук/вибрация даже если tag совпадает
    });
  }
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
