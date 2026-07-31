export const LOCAL_NOTIFICATION_MESSAGE = "hma-local-limit-v1";
export const LOCAL_NOTIFICATION_ACK = "hma-local-limit-result-v1";

export interface LocalWorkerNotification {
  title: "How Much AI";
  body: string;
  tag: string;
}

export type LocalDeliveryResult =
  | { ok: true }
  | { ok: false; reason: "unsupported" | "denied" | "worker" | "timeout"; message: string };

const REQUEST_ID_PATTERN = /^[a-f0-9]{32}$/;
const TAG_PATTERN = /^hma:[a-f0-9]{32}$/;
const BODY_CONTROL_PATTERN = /[\u0000-\u001f\u007f]/;
const DELIVERY_TIMEOUT_MS = 10_000;

const UNSUPPORTED_RESULT = {
  ok: false,
  reason: "unsupported",
  message: "Local notifications are unavailable in this browser.",
} as const;
const DENIED_RESULT = {
  ok: false,
  reason: "denied",
  message: "Local notifications are not permitted.",
} as const;
const WORKER_RESULT = {
  ok: false,
  reason: "worker",
  message: "Local notification delivery failed.",
} as const;
const TIMEOUT_RESULT = {
  ok: false,
  reason: "timeout",
  message: "Local notification delivery timed out.",
} as const;

function hasLocalNotificationSupport(): boolean {
  return (
    typeof Notification !== "undefined" &&
    typeof navigator !== "undefined" &&
    "serviceWorker" in navigator &&
    navigator.serviceWorker !== undefined &&
    "locks" in navigator &&
    navigator.locks !== undefined &&
    typeof navigator.locks.request === "function" &&
    typeof MessageChannel !== "undefined" &&
    typeof globalThis.crypto !== "undefined" &&
    typeof globalThis.crypto.getRandomValues === "function"
  );
}

function validPayload(payload: LocalWorkerNotification): boolean {
  return (
    payload !== null &&
    typeof payload === "object" &&
    payload.title === "How Much AI" &&
    typeof payload.body === "string" &&
    payload.body.length >= 1 &&
    payload.body.length <= 240 &&
    !BODY_CONTROL_PATTERN.test(payload.body) &&
    typeof payload.tag === "string" &&
    TAG_PATTERN.test(payload.tag)
  );
}

function requestId(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function exactAcknowledgement(data: unknown, expectedRequestId: string): data is {
  type: typeof LOCAL_NOTIFICATION_ACK;
  requestId: string;
  ok: boolean;
} {
  if (data === null || typeof data !== "object") return false;
  const keys = Reflect.ownKeys(data);
  if (!keys.every((key): key is string => typeof key === "string")) return false;
  keys.sort();
  if (keys.length !== 3 || keys[0] !== "ok" || keys[1] !== "requestId" || keys[2] !== "type") return false;
  const acknowledgement = data as Record<string, unknown>;
  return (
    acknowledgement.type === LOCAL_NOTIFICATION_ACK &&
    acknowledgement.requestId === expectedRequestId &&
    REQUEST_ID_PATTERN.test(expectedRequestId) &&
    typeof acknowledgement.ok === "boolean"
  );
}

export function localNotificationPermission(): NotificationPermission | "unsupported" {
  if (!hasLocalNotificationSupport()) return "unsupported";
  return Notification.permission;
}

export async function requestLocalNotificationPermission(): Promise<LocalDeliveryResult> {
  const permission = localNotificationPermission();
  if (permission === "unsupported") return UNSUPPORTED_RESULT;
  if (permission === "granted") return { ok: true };
  if (permission === "denied") return DENIED_RESULT;

  try {
    return (await Notification.requestPermission()) === "granted" ? { ok: true } : DENIED_RESULT;
  } catch {
    return WORKER_RESULT;
  }
}

export async function deliverLocalNotification(
  payload: LocalWorkerNotification,
): Promise<LocalDeliveryResult> {
  const permission = localNotificationPermission();
  if (permission === "unsupported") return UNSUPPORTED_RESULT;
  if (permission !== "granted") return DENIED_RESULT;
  if (!validPayload(payload)) return WORKER_RESULT;

  try {
    const registration = await navigator.serviceWorker.register("/sw.js");
    const readyRegistration = await navigator.serviceWorker.ready;
    const target = readyRegistration.active ?? navigator.serviceWorker.controller ?? registration.active;
    if (!target) return WORKER_RESULT;

    const id = requestId();
    if (!REQUEST_ID_PATTERN.test(id)) return WORKER_RESULT;
    const channel = new MessageChannel();

    return await new Promise<LocalDeliveryResult>((resolve) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout>;
      const finish = (result: LocalDeliveryResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        channel.port1.removeEventListener("message", onMessage);
        channel.port1.close();
        resolve(result);
      };
      const onMessage = (event: MessageEvent) => {
        if (!exactAcknowledgement(event.data, id)) {
          finish(WORKER_RESULT);
          return;
        }
        finish(event.data.ok ? { ok: true } : WORKER_RESULT);
      };

      channel.port1.addEventListener("message", onMessage);
      channel.port1.start();
      timer = setTimeout(() => finish(TIMEOUT_RESULT), DELIVERY_TIMEOUT_MS);

      try {
        target.postMessage(
          {
            type: LOCAL_NOTIFICATION_MESSAGE,
            requestId: id,
            title: payload.title,
            body: payload.body,
            tag: payload.tag,
          },
          [channel.port2],
        );
      } catch {
        finish(WORKER_RESULT);
      }
    });
  } catch {
    return WORKER_RESULT;
  }
}
