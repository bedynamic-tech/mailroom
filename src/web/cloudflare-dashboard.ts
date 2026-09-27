// `?to=/:account/...` deep links work for any account; Cloudflare asks which
// account to use when the signed-in user has more than one.
const dashboard = (path: string) => `https://dash.cloudflare.com/?to=/:account/${path}`;

/** The Worker name, known only on its workers.dev hostname (`<worker>.<account>.workers.dev`). */
export function currentWorkerName(): string | null {
  const { hostname } = window.location;
  return hostname.endsWith(".workers.dev") ? hostname.split(".")[0] : null;
}

export function workerDashboardUrl(tab: "access" | "settings"): string {
  const name = currentWorkerName();
  return name
    ? dashboard(`workers/services/view/${encodeURIComponent(name)}/production/${tab}`)
    : dashboard("workers-and-pages");
}

export const ACCESS_APPLICATIONS_URL = dashboard("one/access-controls/apps");
