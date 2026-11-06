import { afterAll, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { KanbanCard, KanbanStarted } from "../shared/kanban.ts";
import { sessionSnapshot, workspaceClose, workspaceCreate, worktreeCreate } from "./herdr/client.ts";
import { handleKanbanRequest, kanbanDeps, KanbanStore, runGit } from "./kanban.ts";

// The board against the test session's own herdr (scripts/test-herdr.ts): a card started as a real
// herdr worktree and closed through herdr's worktree.remove. The checkout lives under the test's own
// folder, never under the user's worktree directory.
const owned: string[] = [];
const folders: string[] = [];
afterAll(async () => {
  for (const id of owned) await workspaceClose(id, undefined, true).catch(() => undefined);
  for (const folder of folders) rmSync(folder, { recursive: true, force: true });
});

describe("kanban on herdr", () => {
  it("starts a card as a worktree workspace and closes it by merging, removing the workspace and deleting the branch", async () => {
    const root = mkdtempSync(join(tmpdir(), "ovis-kanban-contract-"));
    folders.push(root);
    const repo = join(root, "repo");
    const git = async (cwd: string, ...args: string[]) => {
      const result = await runGit(cwd, ["-c", "user.name=ovis test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", ...args]);
      expect(result.code).toBe(0);
      return result.stdout.trim();
    };
    await git(root, "init", "-q", "-b", "main", repo);
    writeFileSync(join(repo, "README.md"), "fixture\n");
    await git(repo, "add", "-A");
    await git(repo, "commit", "-q", "-m", "fixture");
    for (const [key, value] of [["user.name", "ovis test"], ["user.email", "test@example.invalid"], ["commit.gpgsign", "false"]] as const) await git(repo, "config", key, value);
    const parent = await workspaceCreate({ cwd: repo, label: "ovis-test-kanban" });
    owned.push(parent.workspace.workspace_id);

    const store = new KanbanStore(join(root, "state"));
    const deps = {
      ...kanbanDeps({ queueFirstMessage: async () => { throw new Error("no agent in this test"); }, sessionChanged: () => undefined }),
      worktreeCreate: (options: Parameters<typeof worktreeCreate>[0]) => worktreeCreate({ ...options, path: join(root, "checkout") }),
    };
    const timeout = { timeout: () => undefined };
    const post = (path: string, body: unknown) => handleKanbanRequest(new Request(`http://localhost${path}`, { method: "POST", body: JSON.stringify(body) }), path, store, deps, timeout);

    const made = (await (await post("/api/kanban/cards", { title: "Add a file", source_workspace_id: parent.workspace.workspace_id }))!.json()) as { card: KanbanCard };
    // a 1x1 PNG: copied into the worktree's ignored .ovis folder, which herdr's remove takes with it
    const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
    expect((await post("/api/kanban/image", { id: made.card.id, data_base64: png }))!.status).toBe(201);
    const startedResponse = (await post("/api/kanban/start", { id: made.card.id, branch: "kanban/add-a-file", agent: null }))!;
    expect(startedResponse.status).toBe(200);
    const started = (await startedResponse.json()) as KanbanStarted;
    owned.push(started.card.workspace_id!);
    expect(started.card).toMatchObject({ column: "active", base_branch: "main", branch: "kanban/add-a-file", worktree_path: join(root, "checkout") });
    expect((await sessionSnapshot()).workspaces.find((workspace) => workspace.workspace_id === started.card.workspace_id)?.worktree?.is_linked_worktree).toBeTrue();

    expect(existsSync(join(root, "checkout", ".ovis", `kanban-${store.get(made.card.id)!.images[0]!.name}`))).toBeTrue();
    writeFileSync(join(root, "checkout", "added.txt"), "from the card\n");
    const closedResponse = (await post("/api/kanban/close", { id: made.card.id }))!;
    expect(closedResponse.status).toBe(200);
    expect(((await closedResponse.json()) as { card: KanbanCard }).card.column).toBe("closed");
    expect(readFileSync(join(repo, "added.txt"), "utf8")).toBe("from the card\n");
    expect(existsSync(join(root, "checkout"))).toBeFalse();
    expect((await runGit(repo, ["rev-parse", "--verify", "--quiet", "refs/heads/kanban/add-a-file"])).code).not.toBe(0);
    const workspaces = (await sessionSnapshot()).workspaces.map((workspace) => workspace.workspace_id);
    expect(workspaces).not.toContain(started.card.workspace_id);
    expect(workspaces).toContain(parent.workspace.workspace_id);
  }, 120_000);
});
