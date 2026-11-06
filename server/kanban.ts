/**
 * The work board's cards (shared/kanban.ts), kept in kanban.json in the state directory, and the
 * two steps that touch herdr and git: start (a worktree of the card's project with an agent in it,
 * the card as its first message) and close (commit the worktree, merge its branch into the branch it
 * started from, remove the checkout through herdr, delete the branch). Close stops at the first step
 * that cannot go on safely, and each step is skipped when it is already done, so a close that
 * stopped is retried as it is.
 */
import { randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { firstMessageFault } from "../shared/launch-rules.ts";
import { KANBAN_COLUMNS, MAX_CARD_IMAGES, MAX_CARD_NOTE_CHARS, MAX_CARD_TITLE_CHARS, type KanbanCard, type KanbanColumn, type KanbanImage, type KanbanStarted } from "../shared/kanban.ts";
import type { PendingMessage, SessionSnapshot } from "../shared/protocol.ts";
import { MAX_LABEL_CHARS } from "../shared/labels.ts";
import { agentFault, agentLaunch, type AgentPayload } from "./agent-launch.ts";
import { imageType } from "./codex-images.ts";
import { sessionSnapshot, worktreeCreate, worktreeList, worktreeRemove } from "./herdr/client.ts";
import { badRequest, conflictResponse, errorResponse, isJsonObject, jsonResponse, readJsonObject, setRequestRoute } from "./http.ts";
import { MAX_IMAGE_BYTES, PasteImageError, preparePasteDirectory, readImageBody } from "./paste.ts";
import type { ShellAgentLocator } from "./shell-agent.ts";
import { readStateDocument, writeStateDocument } from "./state-document.ts";

/** A step the board refused, in the API's words: a 409 with its code. */
export class KanbanConflict extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

const isColumn = (value: unknown): value is KanbanColumn => typeof value === "string" && (KANBAN_COLUMNS as readonly string[]).includes(value);
const textOrNull = (value: unknown): string | null => typeof value === "string" && value !== "" ? value : null;
const numberOrNull = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) ? value : null;

/** the names the board gives its images: nothing a path could be built from but the file itself */
const IMAGE_NAME = /^image-[a-f0-9-]{8,36}\.(?:png|jpg|gif|webp)$/;
const IMAGE_EXTENSIONS: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" };

function imageOf(value: unknown): KanbanImage | null {
  if (!isJsonObject(value) || typeof value["name"] !== "string" || !IMAGE_NAME.test(value["name"]) || typeof value["content_type"] !== "string") return null;
  return { name: value["name"], content_type: value["content_type"], size: numberOrNull(value["size"]) ?? 0 };
}

/** A card as stored, or null when the entry is not one. */
function cardOf(value: unknown): KanbanCard | null {
  if (!isJsonObject(value) || typeof value["id"] !== "string" || typeof value["title"] !== "string" || !isColumn(value["column"])) return null;
  return {
    id: value["id"],
    title: value["title"],
    note: typeof value["note"] === "string" ? value["note"] : "",
    column: value["column"],
    created_at: numberOrNull(value["created_at"]) ?? 0,
    updated_at: numberOrNull(value["updated_at"]) ?? 0,
    source_workspace_id: textOrNull(value["source_workspace_id"]),
    repo_root: textOrNull(value["repo_root"]),
    base_branch: textOrNull(value["base_branch"]),
    branch: textOrNull(value["branch"]),
    worktree_path: textOrNull(value["worktree_path"]),
    workspace_id: textOrNull(value["workspace_id"]),
    pane_id: textOrNull(value["pane_id"]),
    agent: textOrNull(value["agent"]),
    closed_at: numberOrNull(value["closed_at"]),
    merge_commit: textOrNull(value["merge_commit"]),
    branch_head: textOrNull(value["branch_head"]),
    closed_outside: value["closed_outside"] === true,
    images: Array.isArray(value["images"]) ? value["images"].map(imageOf).filter((image): image is KanbanImage => image !== null) : [],
  };
}

export class KanbanStore {
  private cards: KanbanCard[] = [];
  private readonly path: string;
  /** a folder per card under it, holding the card's images */
  private readonly imageRoot: string;
  /** a kanban.json that would not parse is kept as kanban.json.bad by the first write, never written over */
  private damaged = false;

  constructor(stateDir: string, private readonly now: () => number = Date.now) {
    this.path = join(stateDir, "kanban.json");
    this.imageRoot = join(stateDir, "kanban-images");
    let read;
    try { read = readStateDocument(this.path); } catch (error) {
      // an unreadable board is not an empty one: it is kept aside by the first write, never written over
      this.damaged = true;
      console.error(`Cannot read ${this.path} (${(error as NodeJS.ErrnoException).code ?? "error"}); the board starts empty`);
      return;
    }
    if (read.kind === "missing") return;
    const list = read.kind === "json" && isJsonObject(read.value) && Array.isArray(read.value["cards"]) ? read.value["cards"] : null;
    if (list === null) {
      this.damaged = true;
      console.error(`${this.path} is not a board; it starts empty and the next change keeps it as ${this.path}.bad`);
      return;
    }
    this.cards = list.map(cardOf).filter((card): card is KanbanCard => card !== null);
  }

  list(): KanbanCard[] { return this.cards; }

  private queue: Promise<unknown> = Promise.resolve();

  /** one start, close or sweep at a time: two of them on the same worktree would race on git and herdr */
  exclusive<T>(run: () => Promise<T>): Promise<T> {
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => undefined);
    return next;
  }

  get(id: string): KanbanCard | undefined { return this.cards.find((card) => card.id === id); }

  private save(): void {
    writeStateDocument(this.path, `${JSON.stringify({ cards: this.cards }, null, 2)}\n`, this.damaged);
    this.damaged = false;
  }

  add(title: string, note: string, sourceWorkspaceId: string | null): KanbanCard {
    const at = this.now();
    const card: KanbanCard = {
      id: randomUUID(), title, note, column: "parking", created_at: at, updated_at: at, source_workspace_id: sourceWorkspaceId,
      repo_root: null, base_branch: null, branch: null, worktree_path: null, workspace_id: null, pane_id: null, agent: null, closed_at: null, merge_commit: null,
      branch_head: null, closed_outside: false, images: [],
    };
    this.cards = [...this.cards, card];
    this.save();
    return card;
  }

  change(id: string, patch: Partial<Omit<KanbanCard, "id" | "created_at">>): KanbanCard {
    const card = this.get(id);
    if (!card) throw new KanbanConflict("card_not_found", "no card with that id");
    const next = { ...card, ...patch, updated_at: this.now() };
    this.cards = this.cards.map((item) => (item.id === id ? next : item));
    this.save();
    return next;
  }

  remove(id: string): void {
    this.cards = this.cards.filter((card) => card.id !== id);
    this.save();
    rmSync(this.imageFolder(id), { recursive: true, force: true });
  }

  private imageFolder(id: string): string { return join(this.imageRoot, id); }

  /** Where a card's image is, or null when the card has no image of that name. */
  imagePath(id: string, name: string): string | null {
    return this.get(id)?.images.some((image) => image.name === name) ? join(this.imageFolder(id), name) : null;
  }

  /** Stores one image for a card, named after the type its bytes show; a PasteImageError when they show none. */
  addImage(id: string, dataBase64: string): KanbanCard {
    const card = this.get(id);
    if (!card) throw new KanbanConflict("card_not_found", "no card with that id");
    if (card.images.length >= MAX_CARD_IMAGES) throw new KanbanConflict("too_many_images", `a card holds at most ${MAX_CARD_IMAGES} images`);
    // the encoded length first, so an oversized body is never decoded
    if (dataBase64.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 4) throw new PasteImageError("image_too_large", `file exceeds ${MAX_IMAGE_BYTES} bytes`, 413);
    const data = Buffer.from(dataBase64, "base64");
    if (data.byteLength === 0) throw new PasteImageError("empty_image", "file is empty", 400);
    if (data.byteLength > MAX_IMAGE_BYTES) throw new PasteImageError("image_too_large", `file exceeds ${MAX_IMAGE_BYTES} bytes`, 413);
    const type = imageType(data);
    const extension = type === null ? undefined : IMAGE_EXTENSIONS[type];
    if (type === null || extension === undefined) throw new PasteImageError("invalid_image", "file is not a PNG, JPEG, GIF or WebP image", 400);
    const name = `image-${randomUUID()}.${extension}`;
    mkdirSync(this.imageFolder(id), { recursive: true, mode: 0o700 });
    writeFileSync(join(this.imageFolder(id), name), data, { mode: 0o600 });
    return this.change(id, { images: [...card.images, { name, content_type: type, size: data.byteLength }] });
  }

  removeImage(id: string, name: string): KanbanCard {
    const card = this.get(id);
    if (!card) throw new KanbanConflict("card_not_found", "no card with that id");
    if (!card.images.some((image) => image.name === name)) throw new KanbanConflict("image_not_found", "the card has no image of that name");
    rmSync(join(this.imageFolder(id), name), { force: true });
    return this.change(id, { images: card.images.filter((image) => image.name !== name) });
  }

  /**
   * Copies a card's images into the `.ovis/` folder of its worktree, the one a pasted image goes to (it
   * ignores itself in git, so close's `git add -A` leaves them out), and returns their paths there.
   */
  copyImagesTo(id: string, worktreePath: string): string[] {
    const card = this.get(id);
    if (!card || card.images.length === 0) return [];
    const directory = preparePasteDirectory(worktreePath);
    return card.images.flatMap((image) => {
      const target = join(directory, `kanban-${image.name}`);
      try {
        copyFileSync(join(this.imageFolder(id), image.name), target);
        return [target];
      } catch (error) {
        console.error(`kanban: cannot copy ${image.name} into the worktree (${(error as NodeJS.ErrnoException).code ?? "error"})`);
        return [];
      }
    });
  }
}

/** What git answered: its exit code (null when it was killed at the deadline) and both outputs. */
export interface GitResult { code: number | null; stdout: string; stderr: string }

const GIT_DEADLINE_MS = 60_000;

function gitEnvironment(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    // a repository the server itself was started inside is not the one asked about
    if (value === undefined || name === "GIT_DIR" || name === "GIT_WORK_TREE" || name === "GIT_INDEX_FILE" || name === "GIT_COMMON_DIR") continue;
    env[name] = value;
  }
  return { ...env, GIT_TERMINAL_PROMPT: "0", GIT_EDITOR: "true", LC_ALL: "C" };
}

/** One git process in `cwd`, its arguments passed as they are (no shell). */
export async function runGit(cwd: string, args: string[]): Promise<GitResult> {
  const proc = Bun.spawn(["git", "--no-pager", "-C", cwd, ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe", env: gitEnvironment() });
  let killed = false;
  const timer = setTimeout(() => { killed = true; proc.kill("SIGKILL"); }, GIT_DEADLINE_MS);
  try {
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    return { code: killed ? null : code, stdout, stderr };
  } finally {
    clearTimeout(timer);
  }
}

/** git's last line of complaint, for a refusal's message */
const said = (result: GitResult): string => (result.stderr.trim() || result.stdout.trim()).split("\n").slice(-3).join(" ") || `git exited with ${result.code ?? "a timeout"}`;

export interface KanbanDeps {
  git: (cwd: string, args: string[]) => Promise<GitResult>;
  worktreeCreate: typeof worktreeCreate;
  worktreeList: typeof worktreeList;
  worktreeRemove: typeof worktreeRemove;
  sessionSnapshot: () => Promise<Pick<SessionSnapshot, "workspaces">>;
  agentLaunch: (paneId: string, agent: AgentPayload, launched: (pid: number) => void) => ReturnType<typeof agentLaunch>;
  queueFirstMessage: (paneId: string, text: string, kind: string, requester: string | null, launchedPid: number | null) => Promise<PendingMessage>;
  /** tell every page that workspaces changed (a worktree went) */
  sessionChanged: () => void;
}

export interface StartRequest {
  sourceWorkspaceId: string;
  branch: string;
  agent?: AgentPayload;
  firstMessage?: string;
  requester: string | null;
}

/** The card's branch must be one git takes as a new branch name. */
async function checkBranch(deps: KanbanDeps, cwd: string, branch: string): Promise<void> {
  const checked = await deps.git(cwd, ["check-ref-format", "--branch", branch]);
  if (checked.code !== 0) throw new KanbanConflict("invalid_branch", `${branch} is not a branch name git takes`);
  const exists = await deps.git(cwd, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]);
  if (exists.code === 0) throw new KanbanConflict("branch_exists", `the branch ${branch} already exists`);
}

/** An agent whose prompt rides in its arguments (`-- <prompt>`, last) with the images' mentions after that prompt. */
function withMentions(agent: AgentPayload, mentions: string): AgentPayload {
  const args = Array.isArray(agent.args) ? agent.args as string[] : [];
  if (args.length < 2 || args[args.length - 2] !== "--") return agent;
  return { ...agent, args: [...args.slice(0, -1), `${args[args.length - 1]}\n\n${mentions}`] };
}

/** A parked card becomes a worktree of its project on a new branch, with the agent started there and the card as its first message. */
export async function startCard(store: KanbanStore, deps: KanbanDeps, id: string, request: StartRequest): Promise<KanbanStarted> {
  const card = store.get(id);
  if (!card) throw new KanbanConflict("card_not_found", "no card with that id");
  if (card.column !== "parking") throw new KanbanConflict("card_started", "this card has already been started");
  // herdr starts a worktree only from the workspace on the repository's main checkout
  const listing = await deps.worktreeList(request.sourceWorkspaceId);
  const sourceWorkspace = listing.source.source_workspace_id ?? request.sourceWorkspaceId;
  const repoRoot = listing.source.source_checkout_path || listing.source.repo_root;
  const head = await deps.git(repoRoot, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  const base = head.stdout.trim();
  if (head.code !== 0 || base === "") throw new KanbanConflict("detached_head", "the project's checkout is on no branch: check one out before starting");
  await checkBranch(deps, repoRoot, request.branch);
  const opened = await deps.worktreeCreate({ workspaceId: sourceWorkspace, branch: request.branch, base, label: card.title.slice(0, MAX_LABEL_CHARS) });
  const startHead = await deps.git(repoRoot, ["rev-parse", "--verify", "--quiet", `refs/heads/${opened.worktree.branch ?? request.branch}`]);
  // kept before the agent starts: the worktree is there whatever the agent does
  let started = store.change(id, {
    branch_head: startHead.code === 0 ? startHead.stdout.trim() : null,
    column: "active", source_workspace_id: sourceWorkspace, repo_root: repoRoot, base_branch: base, branch: opened.worktree.branch ?? request.branch,
    worktree_path: opened.worktree.path, workspace_id: opened.workspace.workspace_id, pane_id: opened.root_pane.pane_id, agent: null,
  });
  deps.sessionChanged();
  const mentions = store.copyImagesTo(id, opened.worktree.path).map((path) => `@${path}`).join(" ");
  if (!request.agent) return { card: started, agent_started: false };
  const agent = mentions === "" ? request.agent : withMentions(request.agent, mentions);
  let launchedPid: number | null = null;
  const launched = await deps.agentLaunch(opened.root_pane.pane_id, agent, (pid) => { launchedPid = pid; });
  if (!launched.agent_started) return { card: started, agent_started: false, error: launched.error };
  started = store.change(id, { agent: request.agent.kind as string });
  if (request.firstMessage === undefined) return { card: started, agent_started: true };
  const text = mentions === "" ? request.firstMessage : `${request.firstMessage}\n\n${mentions}`;
  const firstMessage = await deps.queueFirstMessage(opened.root_pane.pane_id, text, request.agent.kind as string, request.requester, launchedPid)
    .then((message) => ({ id: message.id }), (error: unknown) => ({ error: {
      code: typeof (error as { code?: unknown } | null)?.code === "string" ? (error as { code: string }).code : "first_message_not_queued",
      message: error instanceof Error ? error.message : String(error),
    } }));
  return { card: started, agent_started: true, first_message: firstMessage };
}

/** The commit message for a card's leftover changes: its title on one line. */
const commitMessage = (card: KanbanCard): string => card.title.replace(/\s+/g, " ").trim() || card.branch || "kanban card";

/**
 * Closes a started card: its worktree's changes committed, its branch merged into the base branch in
 * the project's checkout, the worktree removed through herdr and the branch deleted (`-d`: only once
 * merged). Refused while the agent works, while the project's checkout is on another branch or has
 * uncommitted changes, and when the merge does not go cleanly (it is aborted).
 */
export async function closeCard(store: KanbanStore, deps: KanbanDeps, id: string): Promise<KanbanCard> {
  const card = store.get(id);
  if (!card) throw new KanbanConflict("card_not_found", "no card with that id");
  if (card.column !== "active" && card.column !== "done") throw new KanbanConflict("card_not_started", "only a started card can be closed");
  const { repo_root: repoRoot, base_branch: base, branch, worktree_path: worktreePath } = card;
  if (!repoRoot || !base || !branch || !worktreePath) throw new KanbanConflict("card_not_started", "this card has no worktree to close");

  const workspaces = (await deps.sessionSnapshot()).workspaces;
  const workspace = card.workspace_id ? workspaces.find((item) => item.workspace_id === card.workspace_id) : undefined;
  if (workspace?.agent_status === "working") throw new KanbanConflict("agent_working", "the agent is still working in this worktree");

  const branchExists = (await deps.git(repoRoot, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`])).code === 0;
  const checkoutThere = existsSync(worktreePath);

  // 1. what the agent left uncommitted in the worktree
  if (checkoutThere) {
    const status = await deps.git(worktreePath, ["status", "--porcelain"]);
    if (status.code !== 0) throw new KanbanConflict("git_failed", said(status));
    if (status.stdout.trim() !== "") {
      const added = await deps.git(worktreePath, ["add", "-A"]);
      if (added.code !== 0) throw new KanbanConflict("commit_failed", said(added));
      const committed = await deps.git(worktreePath, ["commit", "-m", commitMessage(card)]);
      if (committed.code !== 0) throw new KanbanConflict("commit_failed", said(committed));
    }
  }

  // 2. the branch into the base, in the project's own checkout
  if (branchExists) {
    const merged = await deps.git(repoRoot, ["merge-base", "--is-ancestor", `refs/heads/${branch}`, `refs/heads/${base}`]);
    if (merged.code !== 0) {
      const head = await deps.git(repoRoot, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
      if (head.stdout.trim() !== base) throw new KanbanConflict("base_not_checked_out", `the project's checkout is not on ${base}: check it out there, then close again`);
      const dirty = await deps.git(repoRoot, ["status", "--porcelain", "--untracked-files=no"]);
      if (dirty.code !== 0) throw new KanbanConflict("git_failed", said(dirty));
      if (dirty.stdout.trim() !== "") throw new KanbanConflict("checkout_dirty", `the project's checkout has uncommitted changes: commit or stash them, then close again`);
      const merge = await deps.git(repoRoot, ["merge", "--no-edit", branch]);
      if (merge.code !== 0) {
        await deps.git(repoRoot, ["merge", "--abort"]);
        throw new KanbanConflict("merge_failed", `${branch} did not merge cleanly into ${base}, so the merge was undone: ${said(merge)}`);
      }
    }
  }

  // 3. the checkout, through herdr when its workspace is open, so the workspace leaves with it
  if (workspace) {
    await deps.worktreeRemove(workspace.workspace_id, false);
    deps.sessionChanged();
  } else if (checkoutThere) {
    const removed = await deps.git(repoRoot, ["worktree", "remove", worktreePath]);
    if (removed.code !== 0) throw new KanbanConflict("worktree_remove_failed", said(removed));
  }

  // 4. the branch, now that the base holds it
  if (branchExists) {
    const deleted = await deps.git(repoRoot, ["branch", "-d", branch]);
    if (deleted.code !== 0) throw new KanbanConflict("branch_delete_failed", said(deleted));
  }

  const head = await deps.git(repoRoot, ["rev-parse", `refs/heads/${base}`]);
  return store.change(id, { column: "closed", closed_at: Date.now(), merge_commit: head.code === 0 ? head.stdout.trim() : null, workspace_id: null, pane_id: null });
}

/**
 * Started cards whose work was merged and whose branch was deleted outside the board (by the agent in
 * its worktree, say) are closed as the close action would leave them: the worktree removed (through
 * herdr while its workspace is open, never forced) and the card in closed. A card is closed only when
 * its branch is gone and the commit it last stood on is in the base branch: the worktree's HEAD while
 * the worktree is there, else the branch tip last seen here. A worktree with uncommitted changes or an
 * agent at work is left for the next sweep. Branches still there have their tip noted for that check.
 * Returns whether any card changed.
 */
export async function sweepCards(store: KanbanStore, deps: KanbanDeps): Promise<boolean> {
  const started = store.list().filter((card) => card.column === "active" || card.column === "done");
  if (started.length === 0) return false;
  let workspaces: Awaited<ReturnType<KanbanDeps["sessionSnapshot"]>>["workspaces"] | null = null;
  let changed = false;
  for (const card of started) {
    const { repo_root: repoRoot, base_branch: base, branch, worktree_path: worktreePath } = card;
    if (!repoRoot || !base || !branch || !worktreePath || !existsSync(repoRoot)) continue;
    try {
      const tip = await deps.git(repoRoot, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]);
      if (tip.code === 0) {
        const at = tip.stdout.trim();
        if (at !== "" && at !== card.branch_head) { store.change(card.id, { branch_head: at }); changed = true; }
        continue;
      }
      const checkoutThere = existsSync(worktreePath);
      let last = card.branch_head;
      if (checkoutThere) {
        const status = await deps.git(worktreePath, ["status", "--porcelain"]);
        if (status.code !== 0 || status.stdout.trim() !== "") continue;
        const head = await deps.git(worktreePath, ["rev-parse", "--verify", "--quiet", "HEAD"]);
        if (head.code !== 0) continue;
        last = head.stdout.trim();
      }
      if (!last) continue;
      if ((await deps.git(repoRoot, ["merge-base", "--is-ancestor", last, `refs/heads/${base}`])).code !== 0) continue;
      workspaces ??= (await deps.sessionSnapshot()).workspaces;
      const workspace = card.workspace_id ? workspaces.find((item) => item.workspace_id === card.workspace_id) : undefined;
      if (workspace?.agent_status === "working") continue;
      if (workspace) {
        await deps.worktreeRemove(workspace.workspace_id, false);
        deps.sessionChanged();
      } else if (checkoutThere) {
        const removed = await deps.git(repoRoot, ["worktree", "remove", worktreePath]);
        if (removed.code !== 0) { console.error(`kanban: cannot remove the worktree of ${branch}: ${said(removed)}`); continue; }
      }
      const baseHead = await deps.git(repoRoot, ["rev-parse", `refs/heads/${base}`]);
      store.change(card.id, { column: "closed", closed_at: Date.now(), closed_outside: true, merge_commit: baseHead.code === 0 ? baseHead.stdout.trim() : null, workspace_id: null, pane_id: null });
      changed = true;
    } catch (error) {
      console.error(`kanban: cannot check ${branch}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return changed;
}

/** A card's title and note from a request, checked; a Response when they are not right. */
function cardText(payload: Record<string, unknown>, required: boolean): { title?: string; note?: string } | Response {
  const out: { title?: string; note?: string } = {};
  if (payload["title"] !== undefined || required) {
    const title = typeof payload["title"] === "string" ? payload["title"].trim() : "";
    if (title === "" || title.length > MAX_CARD_TITLE_CHARS) return badRequest("invalid_title", `title must contain text and be at most ${MAX_CARD_TITLE_CHARS} characters`);
    out.title = title;
  }
  if (payload["note"] !== undefined) {
    if (typeof payload["note"] !== "string" || payload["note"].length > MAX_CARD_NOTE_CHARS) return badRequest("invalid_note", `note must be a string of at most ${MAX_CARD_NOTE_CHARS} characters`);
    out.note = payload["note"].trim();
  }
  return out;
}

const workspaceIdOf = (value: unknown): string | null | Response => {
  if (value === undefined || value === null || value === "") return null;
  return typeof value === "string" ? value : badRequest("invalid_workspace_id", "source_workspace_id must be a string");
};

/** How the board's errors answer: a refused step is a 409 with its code, herdr's and the rest as every route answers them. */
const kanbanError = (error: unknown): Response => error instanceof KanbanConflict ? conflictResponse(error.code, error.message) : errorResponse(error);

/** The board's routes, or null when the path is not one. */
export async function handleKanbanRequest(request: Request, pathname: string, store: KanbanStore, deps: KanbanDeps, bunServer: { timeout: (request: Request, seconds: number) => void }): Promise<Response | null> {
  if (pathname !== "/api/kanban" && !pathname.startsWith("/api/kanban/")) return null;
  setRequestRoute(pathname);
  if (pathname === "/api/kanban/image" && request.method === "GET") {
    const query = new URL(request.url).searchParams;
    const card = store.get(query.get("id") ?? "");
    const name = query.get("name") ?? "";
    const path = card ? store.imagePath(card.id, name) : null;
    const image = card?.images.find((item) => item.name === name);
    if (!path || !image) return jsonResponse({ error: { code: "image_not_found", message: "no such image" } }, 404);
    let data: Buffer;
    try { data = readFileSync(path); } catch { return jsonResponse({ error: { code: "image_not_found", message: "no such image" } }, 404); }
    // a name is never reused for other bytes
    return new Response(new Uint8Array(data), { headers: { "content-type": image.content_type, "x-content-type-options": "nosniff", "cache-control": "private, max-age=31536000, immutable" } });
  }
  if (pathname === "/api/kanban/image") {
    if (request.method !== "POST") return badRequest("method_not_allowed", "use POST");
    let payload: unknown;
    try { payload = JSON.parse(await readImageBody(request)); } catch (error) {
      if (error instanceof PasteImageError) return jsonResponse({ error: { code: error.code, message: error.message } }, error.status);
      return badRequest("invalid_json", "request body must be JSON");
    }
    if (!isJsonObject(payload) || typeof payload["id"] !== "string" || typeof payload["data_base64"] !== "string") return badRequest("invalid_image", "id and data_base64 are required strings");
    const card = store.get(payload["id"]);
    if (!card) return jsonResponse({ error: { code: "card_not_found", message: "no card with that id" } }, 404);
    if (card.column !== "parking") return conflictResponse("card_started", "images are added to a parked card only");
    try {
      return jsonResponse({ card: store.addImage(card.id, payload["data_base64"]) }, 201);
    } catch (error) {
      if (error instanceof PasteImageError) return jsonResponse({ error: { code: error.code, message: error.message } }, error.status);
      return kanbanError(error);
    }
  }
  if (pathname === "/api/kanban") {
    if (request.method !== "GET") return badRequest("method_not_allowed", "use GET");
    // what was merged and deleted outside the board shows closed on the next read
    await store.exclusive(() => sweepCards(store, deps));
    return jsonResponse({ cards: store.list() });
  }
  if (request.method !== "POST") return badRequest("method_not_allowed", "use POST");
  const payload = await readJsonObject<Record<string, unknown>>(request);
  if (payload instanceof Response) return payload;

  if (pathname === "/api/kanban/cards") {
    const text = cardText(payload, true);
    if (text instanceof Response) return text;
    const source = workspaceIdOf(payload["source_workspace_id"]);
    if (source instanceof Response) return source;
    return jsonResponse({ card: store.add(text.title as string, text.note ?? "", source) }, 201);
  }

  const id = payload["id"];
  if (typeof id !== "string" || id === "") return badRequest("missing_id", "id is required");
  const card = store.get(id);
  if (!card) return jsonResponse({ error: { code: "card_not_found", message: "no card with that id" } }, 404);

  try {
    if (pathname === "/api/kanban/update") {
      const text = cardText(payload, false);
      if (text instanceof Response) return text;
      const patch: Partial<KanbanCard> = { ...text };
      if (payload["source_workspace_id"] !== undefined) {
        if (card.column !== "parking") return conflictResponse("card_started", "a started card keeps its project");
        const source = workspaceIdOf(payload["source_workspace_id"]);
        if (source instanceof Response) return source;
        patch.source_workspace_id = source;
      }
      if (payload["column"] !== undefined) {
        const column = payload["column"];
        // only between work and its waiting place: starting and closing have their own routes
        const allowed = (card.column === "active" && column === "done") || (card.column === "done" && column === "active") || column === card.column;
        if (!isColumn(column) || !allowed) return conflictResponse("invalid_move", "a card moves only between active and done here; start and close it with their own actions");
        patch.column = column;
      }
      return jsonResponse({ card: store.change(id, patch) });
    }
    if (pathname === "/api/kanban/image/delete") {
      if (card.column !== "parking") return conflictResponse("card_started", "a started card keeps its images");
      if (typeof payload["name"] !== "string") return badRequest("missing_name", "name is required");
      return jsonResponse({ card: store.removeImage(id, payload["name"]) });
    }
    if (pathname === "/api/kanban/delete") {
      // a started card has a worktree and a branch: it leaves the board only by its close
      if (card.column !== "parking" && card.column !== "closed") return conflictResponse("card_started", "close a started card instead of deleting it");
      store.remove(id);
      return jsonResponse({ ok: true });
    }
    if (pathname === "/api/kanban/start") {
      const source = workspaceIdOf(payload["source_workspace_id"] ?? card.source_workspace_id);
      if (source instanceof Response) return source;
      if (source === null) return badRequest("missing_workspace_id", "source_workspace_id is required");
      const branch = typeof payload["branch"] === "string" ? payload["branch"].trim() : "";
      if (branch === "") return badRequest("missing_branch", "branch is required");
      const agent = payload["agent"] === null ? undefined : payload["agent"] as AgentPayload | undefined;
      const fault = agentFault(agent);
      if (fault !== null) return badRequest("invalid_agent", fault);
      const firstMessage = payload["first_message"] === null ? undefined : payload["first_message"];
      const messageFault = firstMessageFault(firstMessage, agent);
      if (messageFault !== null) return badRequest("invalid_first_message", messageFault);
      const requester = payload["first_message_connection"] ?? null;
      if (requester !== null && (typeof requester !== "string" || requester.length === 0 || requester.length > 128)) {
        return badRequest("invalid_first_message", "first_message_connection must be the id of this page's connection");
      }
      // git's checkout, then agent.start: up to a minute each
      bunServer.timeout(request, 150);
      const started = await store.exclusive(() => startCard(store, deps, id, { sourceWorkspaceId: source, branch, ...(agent ? { agent } : {}), ...(typeof firstMessage === "string" ? { firstMessage } : {}), requester: requester as string | null }));
      return jsonResponse(started);
    }
    if (pathname === "/api/kanban/close") {
      bunServer.timeout(request, 150);
      return jsonResponse({ card: await store.exclusive(() => closeCard(store, deps, id)) });
    }
  } catch (error) {
    return kanbanError(error);
  }
  return jsonResponse({ error: { code: "not_found", message: "not found" } }, 404);
}

/** The board's dependencies on this PC's herdr and git. */
export function kanbanDeps(options: { queueFirstMessage: KanbanDeps["queueFirstMessage"]; sessionChanged: () => void; shellAgents?: ShellAgentLocator }): KanbanDeps {
  return {
    git: runGit,
    worktreeCreate,
    worktreeList,
    worktreeRemove,
    sessionSnapshot: () => sessionSnapshot(),
    agentLaunch: (paneId, agent, launched) => agentLaunch(paneId, agent, launched, options.shellAgents),
    queueFirstMessage: options.queueFirstMessage,
    sessionChanged: options.sessionChanged,
  };
}
