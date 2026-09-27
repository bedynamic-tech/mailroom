import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import type { ApiError } from "../api";
import { currentWorkerName, workerDashboardUrl } from "../cloudflare-dashboard";
import { CopyField } from "./CopyField";
import { DashLink } from "./DashLink";

/** Shown instead of the workspace until Cloudflare Access protects this Worker. */
export function AccessSetup(props: { error: ApiError; onRetry: () => void; retrying: boolean }) {
  const { code, hint } = props.error;
  // Access adds a signed assertion to every request it lets through; a hint
  // means the visitor already signed in, so only the variables are left.
  const accessActive = Boolean(hint) || code === "access_invalid";
  const mismatch = code === "access_invalid";
  const workerName = currentWorkerName();

  return (
    <div className="flex h-dvh min-h-[560px] justify-center overflow-y-auto bg-canvas px-4 py-10 text-foreground md:py-16">
      <div className="w-full max-w-[620px]">
        <h1 className="text-[20px] font-semibold tracking-tight">Finish securing Mailroom</h1>
        <p className="mt-2 max-w-xl text-[13.5px] leading-6 text-muted-foreground">
          Mail stays locked until Cloudflare Access protects this Worker.
        </p>

        <ol className="mt-8 space-y-3">
          <Step n={1} title="Enable Access" state={accessActive ? "done" : "current"}>
            <p>
              In the{" "}
              <DashLink href={workerDashboardUrl("access")}>
                {workerName ? `${workerName} Worker's Access tab` : "Worker's Access tab"}
              </DashLink>
              , select <strong>Enable access</strong> with the <strong>Cloudflare account</strong>{" "}
              policy. Then reload this page.
            </p>
          </Step>

          <Step n={2} title="Add two variables" state={accessActive ? "current" : "todo"}>
            <p>
              {mismatch ? "These values don't match your Access app. Update them" : "Add these"} in{" "}
              <DashLink href={workerDashboardUrl("settings")}>Settings</DashLink> → Variables and
              Secrets:
            </p>
            <div className="mt-3 space-y-2">
              <CopyField
                label="WEB_ACCESS_TEAM_DOMAIN"
                value={hint?.team_domain ?? "Shown after step 1"}
                placeholder={!hint}
              />
              <CopyField
                label="WEB_ACCESS_AUD"
                value={hint?.aud ?? "Shown after step 1"}
                placeholder={!hint}
              />
            </div>
          </Step>
        </ol>

        <Button className="mt-6" onClick={props.onRetry} disabled={props.retrying}>
          {props.retrying ? "Checking…" : "Check again"}
        </Button>
      </div>
    </div>
  );
}

function Step(props: {
  n: number;
  title: string;
  state: "done" | "current" | "todo";
  children: ReactNode;
}) {
  const done = props.state === "done";
  return (
    <li
      className={`rounded-xl border bg-background px-4 py-4 sm:px-5 ${props.state === "todo" ? "opacity-60" : ""}`}
      aria-current={props.state === "current" ? "step" : undefined}
    >
      <div className="flex items-center gap-3">
        <span
          className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[12px] font-semibold ${done ? "bg-foreground text-background" : "border text-foreground"}`}
        >
          {done ? "✓" : props.n}
        </span>
        <h2 className={`text-[14px] font-medium ${done ? "text-muted-foreground" : ""}`}>
          {props.title}
        </h2>
      </div>
      {!done && (
        <div className="mt-3 pl-9 text-[13px] leading-6 text-muted-foreground [&_strong]:font-medium [&_strong]:text-foreground">
          {props.children}
        </div>
      )}
    </li>
  );
}
