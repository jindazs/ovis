/**
 * The work board (server/kanban.ts, src/components/KanbanBoard.tsx): ideas parked as cards, each
 * started as a git worktree of a project's repository with an agent in it, and closed by
 * committing that worktree, merging its branch into the branch it started from, removing the
 * checkout and deleting the branch. The project's own workspace stays open throughout.
 *
 *  GET  /api/kanban                                                         -> KanbanBoard
 *  POST /api/kanban/cards  { title, note?, source_workspace_id? }           -> { card }
 *  POST /api/kanban/update { id, title?, note?, source_workspace_id?, column? } -> { card }
 *  POST /api/kanban/delete { id }                                           -> { ok }
 *  POST /api/kanban/start  { id, source_workspace_id, branch, agent?, first_message?, first_message_connection? } -> KanbanStarted
 *  POST /api/kanban/close  { id }                                           -> { card }
 */

/** parking: an idea; active: a worktree with an agent at work; done: waiting to be closed; closed: merged and cleaned up */
export type KanbanColumn = "parking" | "active" | "done" | "closed";

export const KANBAN_COLUMNS: readonly KanbanColumn[] = ["parking", "active", "done", "closed"];

export const MAX_CARD_TITLE_CHARS = 200;
export const MAX_CARD_NOTE_CHARS = 10_000;

export interface KanbanCard {
  id: string;
  title: string;
  note: string;
  column: KanbanColumn;
  created_at: number;
  updated_at: number;
  /** the project's workspace on its repository's main checkout: where the worktree starts from */
  source_workspace_id: string | null;
  /** set once started: the main checkout, the branch it started from, and the card's own branch and checkout */
  repo_root: string | null;
  base_branch: string | null;
  branch: string | null;
  worktree_path: string | null;
  /** the worktree's workspace and its root pane, where the agent runs */
  workspace_id: string | null;
  pane_id: string | null;
  agent: string | null;
  closed_at: number | null;
  /** the base branch's commit after the merge */
  merge_commit: string | null;
  /** the card's branch tip as last seen: tells, once the branch was deleted outside the board, whether the base holds it */
  branch_head: string | null;
  /** closed by the board on finding its branch merged and deleted outside it, not by the close action */
  closed_outside: boolean;
}

export interface KanbanBoard {
  cards: KanbanCard[];
}

export interface KanbanStarted {
  card: KanbanCard;
  agent_started: boolean;
  error?: { code: string; message: string };
  first_message?: { id: string } | { error: { code: string; message: string } };
}
