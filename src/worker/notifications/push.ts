import { buildPushHTTPRequest } from "@pushforge/builder";
import type { BrowserPushSubscription } from "../../shared/types";

interface StoredPushSubscription {
  endpoint: string;
  expiration_time: number | null;
  p256dh: string;
  auth: string;
}

export interface NewEmailNotificationInput {
  threadId: number;
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
    title: `New email from ${sender}`,
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
    "SELECT browser_notifications_enabled, browser_new_email FROM global_settings WHERE id = 1",
  ).first<{ browser_notifications_enabled: number; browser_new_email?: number }>();
  if (!settings?.browser_notifications_enabled || settings.browser_new_email === 0) return;

  const payload = buildNewEmailNotification(input);
  const unread = await env.DB.prepare(
    "SELECT COUNT(*) AS count FROM threads WHERE is_read = 0 AND status != 'archived'",
  )
    .first<{ count: number }>()
    .then((row) => row?.count ?? null)
    .catch(() => null);
  await pushToSubscribedBrowsers(env, {
    title: payload.title,
    body: payload.body,
    tag: payload.tag,
    // The installed app shows this total as its OS badge.
    data: unread === null ? { url: payload.data.url } : { url: payload.data.url, unread },
    topic: `conversation-${input.threadId}`,
  });
}

export interface PushMessage {
  title: string;
  body: string;
  tag: string;
  data: { url: string; unread?: number; kind?: string };
  /** Replaces an undelivered push with the same topic. */
  topic: string;
}

/**
 * Sends one notification to every stored Push Subscription and forgets the
 * ones the push service reports gone. Callers check their own setting first.
 */
export async function pushToSubscribedBrowsers(env: Env, message: PushMessage): Promise<number> {
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_JWK || !env.VAPID_SUBJECT) return 0;
  const privateJWK = env.VAPID_PRIVATE_JWK;
  const adminContact = env.VAPID_SUBJECT;

  const { results } = await env.DB.prepare(
    `SELECT endpoint, expiration_time, p256dh, auth
     FROM push_subscriptions ORDER BY id`,
  ).all<StoredPushSubscription>();
  if (results.length === 0) return 0;

  const deadEndpoints: string[] = [];
  let delivered = 0;

  await Promise.all(
    results.map(async (subscription) => {
      try {
        const pushSubscription = {
          endpoint: subscription.endpoint,
          keys: { p256dh: subscription.p256dh, auth: subscription.auth },
        };
        const request = await buildPushHTTPRequest({
          privateJWK,
          subscription: pushSubscription,
          message: {
            payload: { title: message.title, body: message.body, tag: message.tag, data: message.data },
            adminContact,
            options: {
              ttl: 60 * 60,
              urgency: "normal",
              topic: message.topic,
            },
          },
        });
        const response = await fetch(request.endpoint, {
          method: "POST",
          headers: request.headers,
          body: request.body,
        });
        if (response.ok) {
          delivered += 1;
          return;
        }
        if (response.status === 404 || response.status === 410) {
          deadEndpoints.push(subscription.endpoint);
          return;
        }
        console.error("Browser notification delivery failed", {
          statusCode: response.status,
          endpointOrigin: endpointOrigin(subscription.endpoint),
        });
      } catch (error) {
        console.error("Browser notification delivery failed", {
          statusCode: 0,
          endpointOrigin: endpointOrigin(subscription.endpoint),
          error: error instanceof Error ? error.message : "unknown",
        });
      }
    }),
  );

  if (deadEndpoints.length > 0) {
    await Promise.all(
      deadEndpoints.map((endpoint) =>
        env.DB.prepare("DELETE FROM push_subscriptions WHERE endpoint = ?").bind(endpoint).run(),
      ),
    );
  }
  return delivered;
}

function endpointOrigin(endpoint: string): string {
  try {
    return new URL(endpoint).origin;
  } catch {
    return "invalid";
  }
}
