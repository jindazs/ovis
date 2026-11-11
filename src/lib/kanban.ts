/**
 * The work board's view of its cards (shared/kanban.ts): whether a started card needs the user, read
 * from the agent status herdr reports for the card's pane, the branch a card starts on, and the
 * first message its agent gets.
 */
import type { KanbanCard } from "../../shared/kanban.ts";
import type { SessionSnapshot } from "../../shared/protocol.ts";

/**
 * A started card's state, from its pane's agent: `working` needs nothing yet; `input` (blocked) and
 * `review` (done, not yet seen) need the user; `idle` has been seen and waits; `gone` has no
 * workspace any more (closed outside the board).
 */
export type CardAttention = "working" | "input" | "review" | "idle" | "gone";

export function cardAttention(card: KanbanCard, snapshot: Pick<SessionSnapshot, "panes" | "workspaces"> | null): CardAttention | null {
  if (card.column !== "active" && card.column !== "done") return null;
  if (snapshot === null) return null;
  const pane = card.pane_id ? snapshot.panes.find((item) => item.pane_id === card.pane_id) : undefined;
  const workspace = card.workspace_id ? snapshot.workspaces.find((item) => item.workspace_id === card.workspace_id) : undefined;
  if (!pane && !workspace) return "gone";
  const status = pane?.agent_status ?? workspace?.agent_status;
  if (status === "working") return "working";
  if (status === "blocked") return "input";
  if (status === "done") return "review";
  return "idle";
}

/** whether the card is waiting on the user: an agent asking, or one that finished and was not looked at */
export const needsUser = (attention: CardAttention | null): boolean => attention === "input" || attention === "review";

/** `kanban/<words of the title>`, or `kanban/card-<id>` when the title has no ASCII words (Japanese, say). */
export function suggestCardBranch(card: Pick<KanbanCard, "id" | "title">): string {
  const words = card.title.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/, "");
  return `kanban/${words || `card-${card.id.slice(0, 8)}`}`;
}

/** What the agent is asked: the card's title, then its note. */
export function cardPrompt(card: Pick<KanbanCard, "title" | "note">): string {
  const note = card.note.trim();
  return note === "" ? card.title.trim() : `${card.title.trim()}\n\n${note}`;
}

/**
 * The project a card belongs to: its workspace's name while that is open, else the folder of the
 * repository it started in (the workspace closed since), else none.
 */
export function cardProject(card: Pick<KanbanCard, "source_workspace_id" | "repo_root">, projects: Pick<SessionSnapshot["workspaces"][number], "workspace_id" | "label">[]): string | null {
  const label = projects.find((workspace) => workspace.workspace_id === card.source_workspace_id)?.label;
  if (label) return label;
  return card.repo_root?.replace(/\/+$/, "").split("/").pop() || null;
}

/**
 * The workspaces a card can start from: every one but a linked worktree (a worktree starts from the
 * main checkout). herdr names the repository of only some workspaces, so one it names none of is
 * offered too, and herdr's own refusal says when its folder is no repository.
 */
export function projectWorkspaces(snapshot: Pick<SessionSnapshot, "workspaces"> | null): SessionSnapshot["workspaces"] {
  return (snapshot?.workspaces ?? []).filter((workspace) => workspace.worktree?.is_linked_worktree !== true);
}
