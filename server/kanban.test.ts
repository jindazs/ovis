import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { KanbanCard } from "../shared/kanban.ts";
import { closeCard, handleKanbanRequest, KanbanConflict, KanbanStore, runGit, startCard, sweepCards, type KanbanDeps } from "./kanban.ts";

// Real git in a temporary repository; herdr's worktree calls are stood in for by git itself, so the
// user's herdr session is never touched.
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await runGit(cwd, args);
  if (result.code !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

/** the smallest PNG: a 1x1 transparent pixel */
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64");

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "ovis-kanban-"));
  roots.push(root);
  const repo = join(root, "repo");
  const state = join(root, "state");
  await runGit(root, ["init", "-q", "-b", "main", repo]);
  for (const [key, value] of [["user.name", "Test"], ["user.email", "test@example.invalid"], ["commit.gpgsign", "false"]] as const) await git(repo, "config", key, value);
  writeFileSync(join(repo, "README.md"), "hello\n");
  await git(repo, "add", "-A");
  await git(repo, "commit", "-q", "-m", "first");
  const workspaces: { workspace_id: string; agent_status: string }[] = [{ workspace_id: "w-main", agent_status: "idle" }];
  const calls: string[] = [];
  const deps: KanbanDeps = {
    git: runGit,
    worktreeList: async () => ({ source: { repo_key: "k", repo_name: "repo", repo_root: repo, source_checkout_path: repo, source_workspace_id: "w-main" }, worktrees: [] }),
    worktreeCreate: async ({ branch, base }) => {
      const path = join(root, "wt", branch.replace(/\//g, "-"));
      await git(repo, "worktree", "add", "-q", "-b", branch, path, base ?? "HEAD");
      workspaces.push({ workspace_id: "w-card", agent_status: "working" });
      return { type: "worktree_created", workspace: { workspace_id: "w-card" }, tab: {}, root_pane: { pane_id: "p-card" }, worktree: { path, branch } } as never;
    },
    worktreeRemove: async (workspaceId) => {
      const path = join(root, "wt", "kanban-test");
      await git(repo, "worktree", "remove", path);
      workspaces.splice(workspaces.findIndex((item) => item.workspace_id === workspaceId), 1);
      calls.push(`remove ${workspaceId}`);
      return { type: "worktree_removed", workspace_id: workspaceId, path, forced: false };
    },
    sessionSnapshot: async () => ({ workspaces }) as never,
    agentLaunch: async (paneId, agent) => { calls.push(`launch ${paneId} ${agent.kind as string}`); return { agent_started: true }; },
    queueFirstMessage: async (paneId, text) => { calls.push(`message ${paneId} ${text}`); return { id: "m1" } as never; },
    sessionChanged: () => calls.push("changed"),
  };
  return { root, repo, state, store: new KanbanStore(state), deps, workspaces, calls };
}

describe("kanban store", () => {
  it("keeps cards in kanban.json across a restart", async () => {
    const { state, store } = await fixture();
    const card = store.add("Idea", "details", null);
    store.change(card.id, { note: "more" });
    const again = new KanbanStore(state);
    expect(again.list().map((item) => [item.title, item.note, item.column])).toEqual([["Idea", "more", "parking"]]);
  });

  it("keeps a damaged board aside instead of writing over it", async () => {
    const { state } = await fixture();
    rmSync(state, { recursive: true, force: true });
    const { mkdirSync } = await import("node:fs");
    mkdirSync(state, { recursive: true });
    writeFileSync(join(state, "kanban.json"), "not json");
    const store = new KanbanStore(state);
    expect(store.list()).toEqual([]);
    store.add("New", "", null);
    expect(readFileSync(join(state, "kanban.json.bad"), "utf8")).toBe("not json");
  });
});

describe("start and close", () => {
  it("starts a worktree from the checked-out branch, then commits, merges, removes and deletes on close", async () => {
    const { repo, store, deps, workspaces, calls } = await fixture();
    const card = store.add("Add a greeting", "Write hello.txt", "w-main");
    const started = await startCard(store, deps, card.id, { sourceWorkspaceId: "w-main", branch: "kanban/test", agent: { kind: "claude" }, firstMessage: "Add a greeting", requester: null });
    expect(started.card.column).toBe("active");
    expect(started.card.base_branch).toBe("main");
    expect(started.first_message).toEqual({ id: "m1" });
    expect(calls).toContain("launch p-card claude");

    // the agent leaves its work uncommitted
    writeFileSync(join(started.card.worktree_path!, "hello.txt"), "hi\n");
    await expect(closeCard(store, deps, card.id)).rejects.toThrow(new KanbanConflict("agent_working", "the agent is still working in this worktree"));
    workspaces[1]!.agent_status = "done";

    const closed = await closeCard(store, deps, card.id);
    expect(closed.column).toBe("closed");
    expect(readFileSync(join(repo, "hello.txt"), "utf8")).toBe("hi\n");
    expect(await git(repo, "log", "-1", "--format=%s")).toBe("Add a greeting");
    expect((await runGit(repo, ["rev-parse", "--verify", "--quiet", "refs/heads/kanban/test"])).code).not.toBe(0);
    expect(existsSync(started.card.worktree_path!)).toBe(false);
    expect(closed.merge_commit).toBe(await git(repo, "rev-parse", "main"));
    expect(calls).toContain("remove w-card");
  });

  it("refuses to merge into a checkout with uncommitted changes and keeps the branch", async () => {
    const { repo, store, deps, workspaces } = await fixture();
    const card = store.add("Change", "", "w-main");
    const started = await startCard(store, deps, card.id, { sourceWorkspaceId: "w-main", branch: "kanban/test", requester: null });
    workspaces[1]!.agent_status = "idle";
    writeFileSync(join(started.card.worktree_path!, "new.txt"), "x\n");
    writeFileSync(join(repo, "README.md"), "edited\n");
    await expect(closeCard(store, deps, card.id)).rejects.toMatchObject({ code: "checkout_dirty" });
    expect(await git(repo, "rev-parse", "--verify", "refs/heads/kanban/test")).not.toBe("");
    expect(store.get(card.id)?.column).toBe("active");
    // once the checkout is clean, the same close goes on from where it stopped
    await git(repo, "checkout", "--", "README.md");
    expect((await closeCard(store, deps, card.id)).column).toBe("closed");
  });

  it("undoes a merge that conflicts", async () => {
    const { repo, store, deps, workspaces } = await fixture();
    const card = store.add("Conflict", "", "w-main");
    const started = await startCard(store, deps, card.id, { sourceWorkspaceId: "w-main", branch: "kanban/test", requester: null });
    workspaces[1]!.agent_status = "idle";
    writeFileSync(join(started.card.worktree_path!, "README.md"), "branch\n");
    writeFileSync(join(repo, "README.md"), "main\n");
    await git(repo, "commit", "-q", "-am", "main change");
    await expect(closeCard(store, deps, card.id)).rejects.toMatchObject({ code: "merge_failed" });
    expect(await git(repo, "status", "--porcelain")).toBe("");
    expect(existsSync(started.card.worktree_path!)).toBe(true);
  });

  it("copies a card's images into the worktree's ignored .ovis folder and mentions them after the card's text", async () => {
    const { store, deps, calls, workspaces } = await fixture();
    const card = store.add("Fix the header", "", null);
    const [image] = store.addImage(card.id, PNG.toString("base64")).images;
    const started = await startCard(store, deps, card.id, { sourceWorkspaceId: "w-main", branch: "kanban/test", agent: { kind: "claude" }, firstMessage: "Fix the header", requester: null });
    const copied = join(started.card.worktree_path!, ".ovis", `kanban-${image!.name}`);
    expect(readFileSync(copied)).toEqual(PNG);
    expect(calls).toContain(`message p-card Fix the header\n\n@${copied}`);
    expect(await git(started.card.worktree_path!, "status", "--porcelain")).toBe("");

    // an agent that takes its prompt as an argument gets the mentions there
    const other = store.add("Codex card", "", null);
    store.addImage(other.id, PNG.toString("base64"));
    const launched: unknown[] = [];
    await startCard(store, { ...deps, agentLaunch: async (_pane, agent) => { launched.push(agent.args); return { agent_started: true }; } }, other.id,
      { sourceWorkspaceId: "w-main", branch: "kanban/codex", agent: { kind: "codex", args: ["--", "Codex card"] }, requester: null });
    expect(launched[0]).toEqual(["--", expect.stringMatching(/^Codex card\n\n@.*\/\.ovis\/kanban-image-.*\.png$/)]);

    // the worktree goes on close with the copies in it
    workspaces[1]!.agent_status = "idle";
    expect((await closeCard(store, deps, card.id)).column).toBe("closed");
  });

  it("refuses a branch that already exists", async () => {
    const { repo, store, deps } = await fixture();
    await git(repo, "branch", "kanban/test");
    const card = store.add("Twice", "", "w-main");
    await expect(startCard(store, deps, card.id, { sourceWorkspaceId: "w-main", branch: "kanban/test", requester: null })).rejects.toMatchObject({ code: "branch_exists" });
    expect(store.get(card.id)?.column).toBe("parking");
  });
});

describe("closing what was merged outside the board", () => {
  async function startedCard() {
    const f = await fixture();
    const card = f.store.add("Outside", "", "w-main");
    const started = await startCard(f.store, f.deps, card.id, { sourceWorkspaceId: "w-main", branch: "kanban/test", requester: null });
    f.workspaces[1]!.agent_status = "done";
    const wt = started.card.worktree_path!;
    writeFileSync(join(wt, "work.txt"), "done\n");
    await git(wt, "add", "-A");
    await git(wt, "commit", "-q", "-m", "work");
    return { ...f, id: card.id, wt };
  }

  it("closes a card whose branch the agent merged and deleted from its worktree, and removes the worktree", async () => {
    const { repo, store, deps, calls, id, wt } = await startedCard();
    await git(repo, "merge", "-q", "--no-edit", "kanban/test");
    await git(wt, "checkout", "-q", "--detach");
    await git(repo, "branch", "-d", "kanban/test");
    expect(await sweepCards(store, deps)).toBe(true);
    const card = store.get(id)!;
    expect(card.column).toBe("closed");
    expect(card.closed_outside).toBe(true);
    expect(card.merge_commit).toBe(await git(repo, "rev-parse", "main"));
    expect(calls).toContain("remove w-card");
    expect(existsSync(wt)).toBe(false);
  });

  it("closes a card whose worktree and branch were both removed, from the branch tip it last saw", async () => {
    const { repo, store, deps, workspaces, calls, id, wt } = await startedCard();
    await sweepCards(store, deps);
    expect(store.get(id)?.branch_head).toBe(await git(repo, "rev-parse", "kanban/test"));
    await git(repo, "merge", "-q", "--no-edit", "kanban/test");
    await git(repo, "worktree", "remove", wt);
    await git(repo, "branch", "-d", "kanban/test");
    workspaces.splice(1, 1);
    await sweepCards(store, deps);
    expect(store.get(id)?.column).toBe("closed");
    expect(calls).not.toContain("remove w-card");
  });

  it("leaves a card whose branch is still there, deleted unmerged, or whose worktree has changes", async () => {
    const { repo, store, deps, id, wt } = await startedCard();
    expect(await sweepCards(store, deps)).toBe(true);
    expect(store.get(id)?.column).toBe("active");
    await git(wt, "checkout", "-q", "--detach");
    await git(repo, "branch", "-D", "kanban/test");
    await sweepCards(store, deps);
    expect(store.get(id)?.column).toBe("active");
    await git(repo, "merge", "-q", "--no-edit", await git(wt, "rev-parse", "HEAD"));
    writeFileSync(join(wt, "left.txt"), "x\n");
    await sweepCards(store, deps);
    expect(store.get(id)?.column).toBe("active");
    rmSync(join(wt, "left.txt"));
    await sweepCards(store, deps);
    expect(store.get(id)?.column).toBe("closed");
  });

  it("waits while the agent works", async () => {
    const { repo, store, deps, workspaces, id, wt } = await startedCard();
    await git(repo, "merge", "-q", "--no-edit", "kanban/test");
    await git(wt, "checkout", "-q", "--detach");
    await git(repo, "branch", "-d", "kanban/test");
    workspaces[1]!.agent_status = "working";
    await sweepCards(store, deps);
    expect(store.get(id)?.column).toBe("active");
  });
});

describe("routes", () => {
  const timeout = { timeout: () => undefined };
  const post = (path: string, body: unknown) => new Request(`http://localhost${path}`, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });

  it("creates, edits and deletes a parked card, and moves a card only between active and done", async () => {
    const { store, deps } = await fixture();
    const created = await handleKanbanRequest(post("/api/kanban/cards", { title: " Idea ", note: "n" }), "/api/kanban/cards", store, deps, timeout);
    expect(created?.status).toBe(201);
    const { card } = await created!.json() as { card: { id: string; title: string } };
    expect(card.title).toBe("Idea");
    const moved = await handleKanbanRequest(post("/api/kanban/update", { id: card.id, column: "done" }), "/api/kanban/update", store, deps, timeout);
    expect(moved?.status).toBe(409);
    const blank = await handleKanbanRequest(post("/api/kanban/cards", { title: "  " }), "/api/kanban/cards", store, deps, timeout);
    expect(blank?.status).toBe(400);
    const listed = await handleKanbanRequest(new Request("http://localhost/api/kanban"), "/api/kanban", store, deps, timeout);
    expect(((await listed!.json()) as { cards: unknown[] }).cards).toHaveLength(1);
    const deleted = await handleKanbanRequest(post("/api/kanban/delete", { id: card.id }), "/api/kanban/delete", store, deps, timeout);
    expect(deleted?.status).toBe(200);
    expect(store.list()).toEqual([]);
  });

  it("keeps a parked card's images, serves them, and lets them go with the card", async () => {
    const { state, store, deps } = await fixture();
    const { card } = await (await handleKanbanRequest(post("/api/kanban/cards", { title: "Idea" }), "/api/kanban/cards", store, deps, timeout))!.json() as { card: KanbanCard };
    const added = await handleKanbanRequest(post("/api/kanban/image", { id: card.id, data_base64: PNG.toString("base64") }), "/api/kanban/image", store, deps, timeout);
    expect(added?.status).toBe(201);
    const [image] = ((await added!.json()) as { card: KanbanCard }).card.images;
    expect(image).toMatchObject({ content_type: "image/png", size: PNG.byteLength });
    expect(new KanbanStore(state).get(card.id)?.images).toEqual([image!]);

    const served = await handleKanbanRequest(new Request(`http://localhost/api/kanban/image?id=${card.id}&name=${image!.name}`), "/api/kanban/image", store, deps, timeout);
    expect(served?.headers.get("content-type")).toBe("image/png");
    expect(Buffer.from(await served!.arrayBuffer())).toEqual(PNG);
    const outside = await handleKanbanRequest(new Request(`http://localhost/api/kanban/image?id=${card.id}&name=../../kanban.json`), "/api/kanban/image", store, deps, timeout);
    expect(outside?.status).toBe(404);

    const text = await handleKanbanRequest(post("/api/kanban/image", { id: card.id, data_base64: Buffer.from("not an image").toString("base64") }), "/api/kanban/image", store, deps, timeout);
    expect(text?.status).toBe(400);

    const removed = await handleKanbanRequest(post("/api/kanban/image/delete", { id: card.id, name: image!.name }), "/api/kanban/image/delete", store, deps, timeout);
    expect(((await removed!.json()) as { card: KanbanCard }).card.images).toEqual([]);
    expect(existsSync(join(state, "kanban-images", card.id, image!.name))).toBe(false);

    store.addImage(card.id, PNG.toString("base64"));
    store.remove(card.id);
    expect(existsSync(join(state, "kanban-images", card.id))).toBe(false);
  });

  it("answers no other path", async () => {
    const { store, deps } = await fixture();
    expect(await handleKanbanRequest(new Request("http://localhost/api/session"), "/api/session", store, deps, timeout)).toBeNull();
  });
});
