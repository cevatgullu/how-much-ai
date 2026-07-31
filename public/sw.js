// Service worker for Web Push. Registered by the client when a device opts in
// (see lib/notify-client.ts). Renders incoming pushes and focuses the app on click.

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { body: event.data ? event.data.text() : "" };
  }
  const title = data.title || "How Much AI";
  const options = {
    body: data.body || "",
    tag: data.tag || undefined, // same tag collapses repeat notifications for the same limit
    icon: "/icon.svg",
    badge: "/icon.svg",
    data: { url: data.url || "/" },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

const LOCAL_NOTIFICATION_MESSAGE = "hma-local-limit-v1";
const LOCAL_NOTIFICATION_ACK = "hma-local-limit-result-v1";
const LOCAL_REQUEST_ID_PATTERN = /^[a-f0-9]{32}$/;
const LOCAL_TAG_PATTERN = /^hma:[a-f0-9]{32}$/;
const LOCAL_BODY_CONTROL_PATTERN = /[\u0000-\u001f\u007f]/;

function localMessageSourceIsSameOrigin(source) {
  try {
    return typeof source?.url === "string" && new URL(source.url).origin === self.location.origin;
  } catch {
    return false;
  }
}

function localNotificationPayloadIsValid(data) {
  try {
    const keys = Reflect.ownKeys(data);
    if (!keys.every((key) => typeof key === "string")) return false;
    keys.sort();
    return (
      keys.length === 5 &&
      keys[0] === "body" &&
      keys[1] === "requestId" &&
      keys[2] === "tag" &&
      keys[3] === "title" &&
      keys[4] === "type" &&
      data.type === LOCAL_NOTIFICATION_MESSAGE &&
      data.title === "How Much AI" &&
      typeof data.body === "string" &&
      data.body.length >= 1 &&
      data.body.length <= 240 &&
      !LOCAL_BODY_CONTROL_PATTERN.test(data.body) &&
      typeof data.tag === "string" &&
      LOCAL_TAG_PATTERN.test(data.tag)
    );
  } catch {
    return false;
  }
}

function postLocalNotificationResult(port, requestId, ok) {
  try {
    port.postMessage({ type: LOCAL_NOTIFICATION_ACK, requestId, ok });
  } catch {
    // The requesting page may have closed before the notification completed.
  }
  try {
    port.close();
  } catch {
    // Some MessagePort implementations do not expose close().
  }
}

self.addEventListener("message", (event) => {
  if (!localMessageSourceIsSameOrigin(event.source)) return;

  const ports = event.ports;
  if (!ports || ports.length !== 1 || typeof ports[0]?.postMessage !== "function") return;
  const port = ports[0];

  let data;
  let requestId;
  try {
    data = event.data;
    requestId = data?.requestId;
  } catch {
    return;
  }
  if (typeof requestId !== "string" || !LOCAL_REQUEST_ID_PATTERN.test(requestId)) return;

  if (!localNotificationPayloadIsValid(data)) {
    postLocalNotificationResult(port, requestId, false);
    return;
  }

  event.waitUntil(
    Promise.resolve().then(() => self.registration.showNotification("How Much AI", {
      body: data.body,
      tag: data.tag,
      renotify: true,
      icon: "/icon.svg",
      badge: "/icon.svg",
      data: { url: "/" },
    })).then(
      () => postLocalNotificationResult(port, requestId, true),
      () => postLocalNotificationResult(port, requestId, false),
    ),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(async (clients) => {
      for (const client of clients) {
        let sameOrigin = false;
        try {
          sameOrigin = typeof client.url === "string" && new URL(client.url).origin === self.location.origin;
        } catch {}
        if (!sameOrigin || typeof client.focus !== "function") continue;
        try {
          return await client.focus();
        } catch {}
      }
      return self.clients.openWindow ? self.clients.openWindow("/") : undefined;
    }),
  );
});
