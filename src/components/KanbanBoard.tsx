/**
 * The work board: ideas parked as cards, started as a git worktree of a project with an agent that
 * gets the card as its first message, a place for finished work, and a close that commits the
 * worktree, merges its branch into the branch it started from, removes the checkout and deletes the
 * branch (server/kanban.ts). The project's own workspace stays. Whether a started card needs the
 * user comes from its pane's agent status (lib/kanban.ts). On a phone one column shows at a time,
 * picked by the tabs; on a wide screen the three open columns sit side by side and closed cards
 * stay behind their tab. Follows Linear's and GitHub Projects' boards, cut down to these four steps.
 */
import { useEffect, useId, useMemo, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";
import { Check, CircleAlert, ExternalLink, Pencil, Play, Plus, RotateCcw, Trash2, X } from "lucide-react";

import "./KanbanBoard.css";

import type { KanbanCard, KanbanColumn, KanbanStarted } from "../../shared/kanban.ts";
import { MAX_CARD_NOTE_CHARS, MAX_CARD_TITLE_CHARS } from "../../shared/kanban.ts";
import type { AgentKind, SessionSnapshot } from "../../shared/protocol.ts";
import { ApiError, kanbanAction } from "../lib/api.ts";
import { cardAttention, cardPrompt, needsUser, projectWorkspaces, suggestCardBranch, type CardAttention } from "../lib/kanban.ts";
import { firstMessageOf, newSessionLaunch } from "../lib/newSession.ts";
import { useMachineApi } from "../lib/machineContext.tsx";
import { useMachineSessions } from "../lib/machineSessionContext.tsx";
import { useT } from "../lib/i18n.ts";
import { useSettings } from "../lib/settings.ts";
import { usePhoneSheetBack } from "../lib/sheetHistory.ts";
import { AgentPicker, rememberAgent, rememberedAgent } from "./AgentPicker.tsx";
import { ConfirmDialog } from "./ConfirmDialog.tsx";

interface Props {
  cards: KanbanCard[] | null;
  error: string | null;
  snapshot: SessionSnapshot | null;
  onReload: () => Promise<void>;
  onOpenPane: (paneId: string) => void;
  onClose: () => void;
}

const said = (reason: unknown): string => reason instanceof ApiError ? reason.detail : reason instanceof Error ? reason.message : String(reason);

const COLUMN_LABEL: Record<KanbanColumn, string> = {
  parking: "Parking lot",
  active: "In progress",
  done: "Done",
  closed: "Closed",
};

const ATTENTION_LABEL: Record<CardAttention, string> = {
  working: "Working",
  input: "Needs input",
  review: "Finished · check it",
  idle: "Checked · waiting",
  gone: "Workspace closed",
};

export function KanbanBoard({ cards, error, snapshot, onReload, onOpenPane, onClose }: Props) {
  const t = useT();
  const id = useId();
  const [column, setColumn] = useState<KanbanColumn>("parking");
  const [confirm, setConfirm] = useState<{ title: string; body: string; action: string; run: () => Promise<void> } | null>(null);
  // the confirm dialog over the board holds the history entry while it is up
  usePhoneSheetBack(onClose, confirm === null);
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" || confirm) return;
      event.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [confirm, onClose]);

  const projects = useMemo(() => projectWorkspaces(snapshot), [snapshot]);
  const byColumn = useMemo(() => {
    const groups: Record<KanbanColumn, KanbanCard[]> = { parking: [], active: [], done: [], closed: [] };
    for (const card of cards ?? []) groups[card.column].push(card);
    groups.closed.sort((a, b) => (b.closed_at ?? 0) - (a.closed_at ?? 0));
    return groups;
  }, [cards]);
  const waiting = byColumn.active.filter((card) => needsUser(cardAttention(card, snapshot))).length;

  const tabCount = (key: KanbanColumn): string => {
    const count = byColumn[key].length;
    return key === "active" && waiting > 0 ? `${count} · !${waiting}` : String(count);
  };

  return createPortal(
    <div className="modal-scrim kanban-scrim">
      <div className="modal kanban-board" role="dialog" aria-modal="true" aria-labelledby={`${id}-title`}>
        <header className="modal-header">
          <h2 className="modal-title" id={`${id}-title`}>{t("Work board")}</h2>
          <button type="button" className="icon-button" aria-label={t("Close the board")} onClick={onClose}><X aria-hidden="true" /></button>
        </header>
        <div className="kanban-tabs" role="tablist" aria-label={t("Columns")}>
          {(["parking", "active", "done", "closed"] as const).map((key) => (
            <button key={key} type="button" role="tab" aria-selected={column === key} className={`kanban-tab${column === key ? " is-selected" : ""}${key === "closed" ? " is-closed-tab" : ""}`} onClick={() => setColumn(key)}>
              {t(COLUMN_LABEL[key])}
              <span className={`kanban-count${(key === "active" && waiting > 0) || (key === "done" && byColumn.done.length > 0) ? " is-alert" : ""}`}>{tabCount(key)}</span>
            </button>
          ))}
        </div>
        <div className="modal-body kanban-body" data-column={column}>
          {error && <p className="field-hint kanban-error" role="alert">{error}</p>}
          {cards === null && !error && <p className="field-hint" role="status">{t("Reading the board…")}</p>}
          {cards !== null && (["parking", "active", "done", "closed"] as const).map((key) => (
            <section key={key} className={`kanban-column kanban-column-${key}${column === key ? " is-shown" : ""}`} aria-label={t(COLUMN_LABEL[key])}>
              <h3 className="kanban-column-title">{t(COLUMN_LABEL[key])} <span className="kanban-count">{tabCount(key)}</span></h3>
              {key === "parking" && <NewCard projects={projects} onAdded={onReload} />}
              {key === "done" && byColumn.done.length > 0 && <p className="field-hint">{t("Close each card here once it is checked: the worktree is committed and merged, then removed with its branch.")}</p>}
              {byColumn[key].length === 0 && key !== "parking" && <p className="field-hint kanban-empty">{t("Nothing here.")}</p>}
              <ul className="kanban-list">
                {byColumn[key].map((card) => (
                  <li key={card.id}>
                    <Card card={card} snapshot={snapshot} projects={projects} onReload={onReload} onOpenPane={onOpenPane} onConfirm={setConfirm} />
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      </div>
      {confirm && <ConfirmDialog title={confirm.title} body={confirm.body} confirmLabel={confirm.action} onConfirm={async () => { await confirm.run(); setConfirm(null); }} onClose={() => setConfirm(null)} />}
    </div>,
    document.body,
  );
}

const projectName = (projects: SessionSnapshot["workspaces"], workspaceId: string | null): string | null =>
  projects.find((workspace) => workspace.workspace_id === workspaceId)?.label ?? null;

function ProjectSelect({ projects, value, disabled, onChange, labelledBy }: { projects: SessionSnapshot["workspaces"]; value: string; disabled?: boolean; onChange: (value: string) => void; labelledBy?: string }) {
  const t = useT();
  return (
    <select className="input kanban-select" value={value} disabled={disabled} aria-labelledby={labelledBy} onChange={(event) => onChange(event.target.value)}>
      <option value="">{t("No project yet")}</option>
      {projects.map((workspace) => <option key={workspace.workspace_id} value={workspace.workspace_id}>{workspace.label}</option>)}
    </select>
  );
}

function NewCard({ projects, onAdded }: { projects: SessionSnapshot["workspaces"]; onAdded: () => Promise<void> }) {
  const t = useT();
  const id = useId();
  const [title, setTitle] = useState("");
  const [note, setNote] = useState("");
  const [project, setProject] = useState("");
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (!title.trim() || pending) return;
    setPending(true);
    setError(null);
    try {
      await kanbanAction("cards", { title, note, source_workspace_id: project || null });
      setTitle(""); setNote(""); setOpen(false);
      await onAdded();
    } catch (reason) { setError(said(reason)); }
    setPending(false);
  };
  return (
    <form className="kanban-new" onSubmit={(event) => void submit(event)}>
      <input className="input" value={title} maxLength={MAX_CARD_TITLE_CHARS} placeholder={t("A new idea…")} aria-label={t("Idea title")} disabled={pending} onFocus={() => setOpen(true)} onChange={(event) => setTitle(event.target.value)} />
      {open && (
        <>
          <textarea className="input kanban-note" value={note} maxLength={MAX_CARD_NOTE_CHARS} rows={3} placeholder={t("Details for the agent (optional)")} aria-label={t("Details")} disabled={pending} onChange={(event) => setNote(event.target.value)} />
          <span className="field-label" id={`${id}-project`}>{t("Repository")}</span>
          <ProjectSelect projects={projects} value={project} disabled={pending} labelledBy={`${id}-project`} onChange={setProject} />
          <div className="kanban-actions">
            <button type="button" className="btn btn-ghost" disabled={pending} onClick={() => { setOpen(false); setError(null); }}>{t("Cancel")}</button>
            <button type="submit" className="btn btn-primary" disabled={pending || !title.trim()}><Plus aria-hidden="true" />{t("Park it")}</button>
          </div>
        </>
      )}
      {error && <p className="field-hint kanban-error" role="alert">{error}</p>}
    </form>
  );
}

interface CardProps {
  card: KanbanCard;
  snapshot: SessionSnapshot | null;
  projects: SessionSnapshot["workspaces"];
  onReload: () => Promise<void>;
  onOpenPane: (paneId: string) => void;
  onConfirm: (confirm: { title: string; body: string; action: string; run: () => Promise<void> }) => void;
}

function Card({ card, snapshot, projects, onReload, onOpenPane, onConfirm }: CardProps) {
  const t = useT();
  const [mode, setMode] = useState<"view" | "edit" | "start">("view");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const attention = cardAttention(card, snapshot);
  const run = async (task: () => Promise<unknown>): Promise<void> => {
    setPending(true);
    setError(null);
    try { await task(); await onReload(); } catch (reason) { setError(said(reason)); }
    setPending(false);
  };
  const paneOpen = card.pane_id !== null && attention !== "gone";
  const project = projectName(projects, card.source_workspace_id);

  if (mode === "edit") return <EditCard card={card} projects={projects} onDone={async () => { setMode("view"); await onReload(); }} onCancel={() => setMode("view")} />;
  if (mode === "start") return <StartCard card={card} projects={projects} onCancel={() => setMode("view")} onStarted={async (paneId) => { await onReload(); if (paneId) onOpenPane(paneId); }} />;

  return (
    <article className={`kanban-card${needsUser(attention) ? " needs-user" : ""}`}>
      <div className="kanban-card-head">
        <span className="kanban-card-title">{card.title}</span>
        {attention && (
          <span className={`pill kanban-attention is-${attention}`}>
            {needsUser(attention) && <CircleAlert aria-hidden="true" />}{t(ATTENTION_LABEL[attention])}
          </span>
        )}
      </div>
      {card.note && <p className="kanban-card-note">{card.note}</p>}
      <p className="kanban-card-meta">
        {card.branch ? `${card.branch} → ${card.base_branch ?? ""}` : project ?? t("No project yet")}
        {card.column === "closed" && card.merge_commit && ` · ${card.merge_commit.slice(0, 7)}`}
        {card.column === "closed" && card.closed_outside && ` · ${t("Merged outside the board")}`}
      </p>
      <div className="kanban-actions">
        {card.column === "parking" && (
          <>
            <button type="button" className="icon-button" aria-label={t("Edit idea")} title={t("Edit idea")} disabled={pending} onClick={() => setMode("edit")}><Pencil aria-hidden="true" /></button>
            <button type="button" className="icon-button" aria-label={t("Delete")} title={t("Delete")} disabled={pending} onClick={() => onConfirm({ title: t("Delete this idea?"), body: card.title, action: t("Delete"), run: () => kanbanAction("delete", { id: card.id }).then(onReload) })}><Trash2 aria-hidden="true" /></button>
            <button type="button" className="btn btn-primary" disabled={pending} onClick={() => setMode("start")}><Play aria-hidden="true" />{t("Start work")}</button>
          </>
        )}
        {(card.column === "active" || card.column === "done") && (
          <>
            {paneOpen && <button type="button" className="btn" onClick={() => onOpenPane(card.pane_id as string)}><ExternalLink aria-hidden="true" />{t("Open pane")}</button>}
            {card.column === "active"
              ? <button type="button" className="btn" disabled={pending} onClick={() => void run(() => kanbanAction("update", { id: card.id, column: "done" }))}><Check aria-hidden="true" />{t("Move to done")}</button>
              : <button type="button" className="icon-button" aria-label={t("Back to work")} title={t("Back to work")} disabled={pending} onClick={() => void run(() => kanbanAction("update", { id: card.id, column: "active" }))}><RotateCcw aria-hidden="true" /></button>}
            {card.column === "done" && (
              <button type="button" className="btn btn-primary" disabled={pending || attention === "working"} onClick={() => onConfirm({
                title: t("Close {title}?", { title: card.title }),
                body: t("Commits what is left in the worktree, merges {branch} into {base}, removes the worktree and deletes {branch}. The project's workspace stays open.", { branch: card.branch ?? "", base: card.base_branch ?? "" }),
                action: t("Merge and close"),
                run: () => kanbanAction("close", { id: card.id }).then(onReload),
              })}>{t("Close card")}</button>
            )}
          </>
        )}
        {card.column === "closed" && (
          <button type="button" className="icon-button" aria-label={t("Delete")} title={t("Delete")} disabled={pending} onClick={() => void run(() => kanbanAction("delete", { id: card.id }))}><Trash2 aria-hidden="true" /></button>
        )}
      </div>
      {error && <p className="field-hint kanban-error" role="alert">{error}</p>}
    </article>
  );
}

function EditCard({ card, projects, onDone, onCancel }: { card: KanbanCard; projects: SessionSnapshot["workspaces"]; onDone: () => Promise<void>; onCancel: () => void }) {
  const t = useT();
  const id = useId();
  const [title, setTitle] = useState(card.title);
  const [note, setNote] = useState(card.note);
  const [project, setProject] = useState(card.source_workspace_id ?? "");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    setPending(true);
    try { await kanbanAction("update", { id: card.id, title, note, source_workspace_id: project || null }); await onDone(); }
    catch (reason) { setError(said(reason)); setPending(false); }
  };
  return (
    <form className="kanban-card is-editing" onSubmit={(event) => void submit(event)}>
      <input className="input" value={title} maxLength={MAX_CARD_TITLE_CHARS} aria-label={t("Idea title")} required disabled={pending} onChange={(event) => setTitle(event.target.value)} />
      <textarea className="input kanban-note" value={note} maxLength={MAX_CARD_NOTE_CHARS} rows={4} aria-label={t("Details")} disabled={pending} onChange={(event) => setNote(event.target.value)} />
      <span className="field-label" id={`${id}-project`}>{t("Repository")}</span>
      <ProjectSelect projects={projects} value={project} disabled={pending} labelledBy={`${id}-project`} onChange={setProject} />
      <div className="kanban-actions">
        <button type="button" className="btn btn-ghost" disabled={pending} onClick={onCancel}>{t("Cancel")}</button>
        <button type="submit" className="btn btn-primary" disabled={pending || !title.trim()}>{t("Save idea")}</button>
      </div>
      {error && <p className="field-hint kanban-error" role="alert">{error}</p>}
    </form>
  );
}

function StartCard({ card, projects, onCancel, onStarted }: { card: KanbanCard; projects: SessionSnapshot["workspaces"]; onCancel: () => void; onStarted: (paneId: string | null) => Promise<void> }) {
  const t = useT();
  const id = useId();
  const { settings } = useSettings();
  const { fetchAgentKinds } = useMachineApi();
  const machineSessions = useMachineSessions();
  const [project, setProject] = useState(card.source_workspace_id && projects.some((workspace) => workspace.workspace_id === card.source_workspace_id) ? card.source_workspace_id : projects[0]?.workspace_id ?? "");
  const [branch, setBranch] = useState(() => suggestCardBranch(card));
  const [agents, setAgents] = useState<AgentKind[]>([]);
  const [agentKind, setAgentKind] = useState(rememberedAgent);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetchAgentKinds().then((next) => {
      if (cancelled) return;
      setAgents(next);
      setAgentKind((kind) => (kind && !next.some((agent) => agent.kind === kind) ? "" : kind));
    }, (reason: unknown) => { if (!cancelled) setError(said(reason)); });
    return () => { cancelled = true; };
  }, [fetchAgentKinds]);

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (!project || !branch.trim() || pending) return;
    const launch = newSessionLaunch({ agent: agentKind, model: "", effort: "", prompt: agentKind ? cardPrompt(card) : "" }, settings);
    if ("fault" in launch) { setError(t("This card can't be sent to that agent.")); return; }
    const message = firstMessageOf(launch);
    const connection = machineSessions?.peek("local")?.connection ?? null;
    setPending(true);
    setError(null);
    try {
      const started = await kanbanAction<KanbanStarted>("start", {
        id: card.id, source_workspace_id: project, branch: branch.trim(), agent: launch.agent,
        ...(message === null ? {} : { first_message: message, ...(connection === null ? {} : { first_message_connection: connection }) }),
      });
      if (!agentKind || started.agent_started) rememberAgent(agentKind);
      if (started.error) setError(started.error.message);
      await onStarted(started.card.pane_id);
    } catch (reason) {
      setError(said(reason));
      setPending(false);
    }
  };
  return (
    <form className="kanban-card is-editing" onSubmit={(event) => void submit(event)}>
      <span className="kanban-card-title">{card.title}</span>
      <span className="field-label" id={`${id}-project`}>{t("Repository")}</span>
      {projects.length === 0
        ? <p className="field-hint">{t("Open a workspace on a git repository first: the worktree starts from it.")}</p>
        : <ProjectSelect projects={projects} value={project} disabled={pending} labelledBy={`${id}-project`} onChange={setProject} />}
      <label className="field">
        <span className="field-label">{t("Branch")}</span>
        <input className="input" value={branch} disabled={pending} required autoComplete="off" autoCapitalize="off" spellCheck={false} onChange={(event) => setBranch(event.target.value)} />
        <span className="field-hint">{t("A new branch from the project's current branch, in a worktree of its own")}</span>
      </label>
      <div className="field">
        <span className="field-label" id={`${id}-agent`}>{t("Agent to start")}</span>
        <AgentPicker agents={agents} value={agentKind} disabled={pending} labelledBy={`${id}-agent`} onChange={setAgentKind} />
      </div>
      <div className="kanban-actions">
        <button type="button" className="btn btn-ghost" disabled={pending} onClick={onCancel}>{t("Cancel")}</button>
        <button type="submit" className="btn btn-primary" disabled={pending || !project || !branch.trim()}><Play aria-hidden="true" />{pending ? t("Starting…") : t("Start work")}</button>
      </div>
      {error && <p className="field-hint kanban-error" role="alert">{error}</p>}
    </form>
  );
}
