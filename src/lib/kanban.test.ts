import { describe, expect, it } from "bun:test";
import type { KanbanCard } from "../../shared/kanban.ts";
import { cardAttention, cardPrompt, needsUser, projectWorkspaces, suggestCardBranch } from "./kanban.ts";

const card = (patch: Partial<KanbanCard> = {}): KanbanCard => ({
  id: "0123456789abcdef", title: "Add dark mode", note: "", column: "active", created_at: 0, updated_at: 0, source_workspace_id: "w1",
  repo_root: "/r", base_branch: "main", branch: "kanban/x", worktree_path: "/r-x", workspace_id: "w2", pane_id: "p2", agent: "claude", closed_at: null, merge_commit: null,
  ...patch,
});

const snapshot = (status: string | null) => ({
  panes: status === null ? [] : [{ pane_id: "p2", agent_status: status }],
  workspaces: status === null ? [] : [{ workspace_id: "w2", agent_status: status }],
}) as never;

describe("cardAttention", () => {
  it("reads the pane's agent status", () => {
    expect(cardAttention(card(), snapshot("working"))).toBe("working");
    expect(cardAttention(card(), snapshot("blocked"))).toBe("input");
    expect(cardAttention(card(), snapshot("done"))).toBe("review");
    expect(cardAttention(card(), snapshot("idle"))).toBe("idle");
    expect(cardAttention(card(), snapshot(null))).toBe("gone");
  });

  it("says nothing for a parked or closed card, or before the session is read", () => {
    expect(cardAttention(card({ column: "parking" }), snapshot("done"))).toBeNull();
    expect(cardAttention(card({ column: "closed" }), snapshot("done"))).toBeNull();
    expect(cardAttention(card(), null)).toBeNull();
  });

  it("asks the user only for input and an unseen finish", () => {
    expect((["working", "input", "review", "idle", "gone", null] as const).filter(needsUser)).toEqual(["input", "review"]);
  });
});

describe("suggestCardBranch", () => {
  it("names the branch after the title, or the card when the title has no ASCII words", () => {
    expect(suggestCardBranch({ id: "abc", title: "Add Dark mode!" })).toBe("kanban/add-dark-mode");
    expect(suggestCardBranch({ id: "0123456789", title: "ダークモード" })).toBe("kanban/card-01234567");
  });
});

describe("cardPrompt", () => {
  it("is the title, then the note", () => {
    expect(cardPrompt({ title: " T ", note: "" })).toBe("T");
    expect(cardPrompt({ title: "T", note: "n\n" })).toBe("T\n\nn");
  });
});

describe("projectWorkspaces", () => {
  it("leaves out linked worktrees only", () => {
    const workspaces = [
      { workspace_id: "a", worktree: { repo_root: "/r", is_linked_worktree: false } },
      { workspace_id: "b", worktree: { repo_root: "/r", is_linked_worktree: true } },
      { workspace_id: "c", worktree: null },
    ];
    expect(projectWorkspaces({ workspaces } as never).map((workspace) => workspace.workspace_id)).toEqual(["a", "c"]);
  });
});
