// Connecting a GitHub Project (CONTRACT.md "Board configuration"): the owner,
// project number and hub repo form shared by the Board panel's setup card and
// Settings, This app, Board. Connect resolves the project through gh, saves
// prefs.board and fetches the board; a project without some of the required
// fields still connects, with one toast listing what it lacks.
import { useEffect, useState, type KeyboardEvent, type ReactNode } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Link } from "lucide-react";
import type { BoardConfig } from "../../lib/ipc";
import { Button, Field, TextInput, cx } from "../ui";
import { setPrefs } from "../../app/prefs";
import { errText, useToast } from "../shared/hooks";
import { configureBoard } from "./actions";
import { BOARD_HELP_URL, setupWarning } from "./model";

const LOGIN_RE = /^[A-Za-z0-9._-]+$/;
const REPO_RE = /^[\w.-]+\/[\w.-]+$/;

/** The form's inputs as configureBoard arguments, or null while one is invalid. */
export function connectArgs(owner: string, number: string, hubRepo: string): { owner: string; projectNumber: number; hubRepo: string } | null {
  const o = owner.trim();
  const h = hubRepo.trim();
  const n = Number(number.trim());
  if (!LOGIN_RE.test(o) || !REPO_RE.test(h) || !Number.isInteger(n) || n <= 0) return null;
  return { owner: o, projectNumber: n, hubRepo: h };
}

/** "the required fields" sentence, with a link to README "Board". */
export function RequiredFieldsNote() {
  const toast = useToast();
  return (
    <p className="text-[11px] leading-relaxed text-fg-muted">
      The project needs the fields Status (Backlog, Ready, In progress, In review, Done), Kind (Epic, Task), Area, Scheduled (a date) and Order (a number);{" "}
      <button
        type="button"
        className="cursor-pointer text-accent underline-offset-2 hover:underline"
        onClick={() => openUrl(BOARD_HELP_URL).catch((e) => toast.error(e, "Could not open the browser"))}
      >
        see Board in the README
      </button>
      .
    </p>
  );
}

export function BoardConnectForm({ config, extra }: { config: BoardConfig | null; extra?: ReactNode }) {
  const toast = useToast();
  const [owner, setOwner] = useState(config?.owner ?? "");
  const [number, setNumber] = useState(config ? String(config.projectNumber) : "");
  const [hubRepo, setHubRepo] = useState(config?.hubRepo ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A config saved elsewhere (the other form, a disconnect) refills the inputs.
  useEffect(() => {
    setOwner(config?.owner ?? "");
    setNumber(config ? String(config.projectNumber) : "");
    setHubRepo(config?.hubRepo ?? "");
  }, [config]);

  const args = connectArgs(owner, number, hubRepo);
  const connect = async () => {
    if (!args) return;
    setBusy(true);
    setError(null);
    try {
      const setup = await configureBoard(args);
      const warning = setupWarning(setup);
      toast.info(`Connected to ${setup.config.title}`);
      if (warning) toast.error(warning);
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };
  const onEnter = (e: KeyboardEvent) => {
    if (e.key === "Enter" && args && !busy) void connect();
  };

  return (
    <div className="flex flex-col gap-2.5" data-board-connect="">
      <Field label="Owner" hint="The GitHub user or organisation that owns the project">
        <TextInput className="font-mono" value={owner} onChange={(e) => setOwner(e.target.value)} onKeyDown={onEnter} placeholder="octocat" aria-label="Project owner" />
      </Field>
      <Field label="Project number" hint="The N in github.com/users/<owner>/projects/N">
        <TextInput type="number" min={1} value={number} onChange={(e) => setNumber(e.target.value)} onKeyDown={onEnter} placeholder="1" aria-label="Project number" />
      </Field>
      <Field label="Hub repo" hint="owner/name, where New epic creates its issues">
        <TextInput className="font-mono" value={hubRepo} onChange={(e) => setHubRepo(e.target.value)} onKeyDown={onEnter} placeholder="octocat/plans" aria-label="Hub repo" />
      </Field>
      {error && (
        <p className="text-[11px] leading-snug break-words text-danger" role="alert">
          {error}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-1.5">
        <Button variant="primary" icon={Link} disabled={!args || busy} onClick={() => void connect()}>
          {busy ? "Connecting..." : config ? "Reconnect" : "Connect"}
        </Button>
        {extra}
      </div>
    </div>
  );
}

/** "No board connected" in place of the board's tasks (Calendar), opening the Board panel. */
export function NoBoardLine({ className, onOpen }: { className?: string; onOpen?: () => void }) {
  return (
    <p className={cx("text-[11px] text-fg-muted", className)} data-no-board="">
      No board connected.{" "}
      <button
        type="button"
        className="cursor-pointer text-accent underline-offset-2 hover:underline"
        onClick={() => {
          onOpen?.();
          setPrefs({ sidebarSection: "board", sidebarCollapsed: false });
        }}
      >
        Connect one in Board
      </button>
    </p>
  );
}
