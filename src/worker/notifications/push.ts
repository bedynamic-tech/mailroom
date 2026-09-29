import type { BrowserPushSubscription } from "../../shared/types";
import { buildWebPushRequest } from "./web-push.ts";

interface StoredPushSubscription {
  endpoint: string;
  expiration_time: number | null;
  p256dh: string;
  auth: string;
}

export interface NewEmailNotificationInput {
  threadId: number;
  /** The Message was added to an existing Conversation. */
  isReply?: boolean;
  senderName: string | null;
  senderAddress: string;
  subject: string;
}

export interface NewEmailNotificationPayload {
  title: string;
  body: string;
  tag: string;
  data: { url: string };
}

export function buildNewEmailNotification(
  input: NewEmailNotificationInput,
): NewEmailNotificationPayload {
  const sender = (input.senderName?.trim() || input.senderAddress.trim() || "Unknown sender")
    .replace(/\s+/g, " ")
    .slice(0, 80);
  const subject = input.subject.trim().replace(/\s+/g, " ").slice(0, 160);

  return {
    title: `${input.isReply ? "Reply" : "New email"} from ${sender}`,
    body: subject || "(no subject)",
    tag: `conversation-${input.threadId}`,
    data: { url: `/inbox/${input.threadId}` },
  };
}

export function validatePushSubscription(
  value: unknown,
): value is BrowserPushSubscription {
  if (!value || typeof value !== "object") return false;
  const subscription = value as Partial<BrowserPushSubscription>;
  if (
    typeof subscription.endpoint !== "string" ||
    subscription.endpoint.length > 2048 ||
    !subscription.keys ||
    typeof subscription.keys.p256dh !== "string" ||
    typeof subscription.keys.auth !== "string" ||
    subscription.keys.p256dh.length < 40 ||
    subscription.keys.p256dh.length > 256 ||
    subscription.keys.auth.length < 8 ||
    subscription.keys.auth.length > 128 ||
    (subscription.expirationTime !== null &&
      subscription.expirationTime !== undefined &&
      (!Number.isSafeInteger(subscription.expirationTime) || subscription.expirationTime < 0))
  ) {
    return false;
  }

  try {
    const endpoint = new URL(subscription.endpoint);
    return endpoint.protocol === "https:" && !endpoint.username && !endpoint.password;
  } catch {
    return false;
  }
}

export async function notifyNewEmail(
  env: Env,
  input: NewEmailNotificationInput,
): Promise<void> {
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_JWK || !env.VAPID_SUBJECT) return;

  const settings = await env.DB.prepare(
    `SELECT browser_notifications_enabled, browser_new_email, browser_replies
     FROM global_settings WHERE id = 1`,
  ).first<{ browser_notifications_enabled: number; browser_new_email?: number; browser_replies?: number }>();
  if (!settings?.browser_notifications_enabled) return;
  // The New email and Replies boxes under Browser Notifications.
  if ((input.isReply ? settings.browser_replies : settings.browser_new_email) === 0) return;

  const payload = buildNewEmailNotification(input);
  const unread = await env.DB.prepare(
    "SELECT COUNT(*) AS count FROM threads WHERE is_read = 0 AND status != 'archived'",
  )
    .first<{ count: number }>()
    .then((row) => row?.count ?? null)
    .catch(() => null);
  const result = await pushToSubscribedBrowsers(env, {
    title: payload.title,
    body: payload.body,
    tag: payload.tag,
    // The installed app shows this total as its OS badge.
    data: unread === null ? { url: payload.data.url } : { url: payload.data.url, unread },
  });
  console.log("Browser notification sent", {
    threadId: input.threadId,
    subscriptions: result.subscriptions,
    delivered: result.delivered,
    removed: result.removed,
    failed: result.failures.length,
  });
}

export interface PushMessage {
  title: string;
  body: string;
  tag: string;
  data: { url: string; unread?: number; kind?: string };
}

export interface PushFailure {
  /** Push service origin, e.g. https://web.push.apple.com. */
  service: string;
  /** HTTP status from the push service; 0 when the request never completed. */
  status: number;
  reason: string;
}

export interface PushResult {
  /** Stored subscriptions a send was attempted for. */
  subscriptions: number;
  delivered: number;
  /** Subscriptions the push service reported gone, now forgotten. */
  removed: number;
  failures: PushFailure[];
}

/**
 * Sends one notification to every stored Push Subscription and forgets the
 * ones the push service reports gone. Callers check their own setting first.
 */
export async function pushToSubscribedBrowsers(env: Env, message: PushMessage): Promise<PushResult> {
  const result: PushResult = { subscriptions: 0, delivered: 0, removed: 0, failures: [] };
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_JWK || !env.VAPID_SUBJECT) return result;
  const privateJWK = env.VAPID_PRIVATE_JWK;
  const adminContact = env.VAPID_SUBJECT;

  const { results } = await env.DB.prepare(
    `SELECT endpoint, expiration_time, p256dh, auth
     FROM push_subscriptions ORDER BY id`,
  ).all<StoredPushSubscription>();
  result.subscriptions = results.length;
  if (results.length === 0) return result;

  const deadEndpoints: string[] = [];

  await Promise.all(
    results.map(async (subscription) => {
      try {
        const pushSubscription = {
          endpoint: subscription.endpoint,
          keys: { p256dh: subscription.p256dh, auth: subscription.auth },
        };
        const request = await buildWebPushRequest({
          subscription: pushSubscription,
          privateJWK,
          subject: adminContact,
          payload: JSON.stringify({
            title: message.title,
            body: message.body,
            tag: message.tag,
            data: message.data,
          }),
          ttl: 60 * 60,
          // No Topic or Urgency header: Apple's service rejects topics
          // (BadWebPushTopic) and has rejected an explicit "normal" urgency.
          // The notification tag already replaces an older one on the device.
        });
        const response = await fetch(request.endpoint, {
          method: "POST",
          headers: request.headers,
          body: request.body,
        });
        if (response.ok) {
          result.delivered += 1;
          return;
        }
        if (response.status === 404 || response.status === 410) {
          deadEndpoints.push(subscription.endpoint);
          return;
        }
        const failure = {
          service: endpointOrigin(subscription.endpoint),
          status: response.status,
          reason: (await response.text().catch(() => "")).trim().slice(0, 200),
        };
        result.failures.push(failure);
        console.error("Browser notification delivery failed", failure);
      } catch (error) {
        const failure = {
          service: endpointOrigin(subscription.endpoint),
          status: 0,
          reason: error instanceof Error ? error.message : "unknown",
        };
        result.failures.push(failure);
        console.error("Browser notification delivery failed", failure);
      }
    }),
  );

  if (deadEndpoints.length > 0) {
    await Promise.all(
      deadEndpoints.map((endpoint) =>
        env.DB.prepare("DELETE FROM push_subscriptions WHERE endpoint = ?").bind(endpoint).run(),
      ),
    );
    result.removed = deadEndpoints.length;
  }
  return result;
}

function endpointOrigin(endpoint: string): string {
  try {
    return new URL(endpoint).origin;
  } catch {
    return "invalid";
  }
}
