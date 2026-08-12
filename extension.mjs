import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { joinSession, createCanvas } from "@github/copilot-sdk/extension";

const servers = new Map();
const instanceState = new Map();
const extensionDirectory = dirname(fileURLToPath(import.meta.url));

// Data lives in the user extension folder — fully detached from any repo.
const releaseManagerDir = join(extensionDirectory, "data");
const runHistoryPath = join(releaseManagerDir, "run-history.json");
const configPath = join(releaseManagerDir, "config.json");

// The target repo path — loaded from config or set via the UI.
let _repoRoot = "";

async function loadConfig() {
    try {
        const raw = await readFile(configPath, "utf8");
        const cfg = JSON.parse(raw);
        if (cfg.repoRoot) {
            _repoRoot = cfg.repoRoot;
        }
    } catch {
        // no config yet
    }
}

async function saveConfig(repoRoot) {
  repoRoot = validateRepoRoot(repoRoot);
    await mkdir(releaseManagerDir, { recursive: true });
    await writeFile(configPath, `${JSON.stringify({ repoRoot }, null, 2)}\n`, "utf8");
    _repoRoot = repoRoot;
}

function escapeHtml(value) {
    return String(value)
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#39;");
}

function tokenizeList(value) {
    if (typeof value !== "string") {
        return [];
    }
    return value
        .replaceAll(",", " ")
        .replaceAll("\r", " ")
        .replaceAll("\n", " ")
        .replaceAll("\t", " ")
        .split(" ")
        .map((token) => token.trim())
        .filter(Boolean);
}

function readRequestBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
        req.on("error", reject);
    });
}

function runCommand(command, args, overrideCwd) {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, {
            cwd: overrideCwd ?? _repoRoot,
            stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk) => {
            stdout += chunk.toString("utf8");
        });
        child.stderr.on("data", (chunk) => {
            stderr += chunk.toString("utf8");
        });
        child.on("error", reject);
        child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
    });
}

async function runGh(args) {
    const result = await runCommand("gh", args);
    if (result.code !== 0) {
        throw new Error(`gh ${args.join(" ")} failed:\n${result.stderr || result.stdout}`.trim());
    }
    return result.stdout.trim();
}

  function isSafeHttpUrl(value) {
    try {
      const url = new URL(String(value ?? ""));
      return url.protocol === "http:" || url.protocol === "https:";
    } catch {
      return false;
    }
  }

  function validateRepoRoot(repoRoot) {
    if (!repoRoot || !repoRoot.trim()) {
      throw new Error("Repository path is required.");
    }
    return repoRoot.trim();
  }

async function ensureReleaseManagerDir() {
    await mkdir(releaseManagerDir, { recursive: true });
}

function extractPrimaryPrId(text) {
    const match = /#(\d+)\b/.exec(String(text ?? ""));
    return match ? Number.parseInt(match[1], 10) : null;
}

async function findMainMergeShaForPrId(prId) {
    const result = await runCommand("git", [
        "log",
        "origin/main",
        "--merges",
        "--grep",
        `Merge pull request #${prId} `,
        "--format=%H",
        "-n",
        "1",
    ]);
    if (result.code !== 0) {
        return null;
    }
    const sha = result.stdout.trim();
    return sha || null;
}

async function listRecentPrIdsOnBranch(branch, limit = 80) {
    const result = await runCommand("git", [
        "log",
        `origin/${branch}`,
        "--max-count",
        String(limit),
        "--format=%s",
    ]);
    if (result.code !== 0) {
        return [];
    }

    const ids = [];
    const seen = new Set();
    for (const line of result.stdout.split(/\r?\n/)) {
        const prId = extractPrimaryPrId(line);
        if (Number.isInteger(prId) && !seen.has(prId)) {
            seen.add(prId);
            ids.push(prId);
        }
    }
    return ids;
}

function getPreferredBackfillBranches(allBranches) {
    const preferred = ["release/28.0", "release/27.1", "release/26.4", "release/25.9"];
    const selected = preferred.filter((branch) => allBranches.includes(branch));
    if (selected.length >= 2) {
        return selected;
    }
    return allBranches.slice(0, Math.min(4, allBranches.length));
}

async function trySeedRunHistory(entries) {
    if (entries.length > 0) {
        return entries;
    }

    const allBranches = await listReleaseBranches();
    const targetBranches = getPreferredBackfillBranches(allBranches);
    if (targetBranches.length < 2) {
        return entries;
    }

    const prLists = await Promise.all(targetBranches.map((branch) => listRecentPrIdsOnBranch(branch)));
    const commonPrIds = prLists
        .reduce((acc, list) => {
            const set = new Set(list);
            return acc.filter((id) => set.has(id));
        }, [...prLists[0]])
        .sort((a, b) => b - a);

    const chosenPrIds = commonPrIds.slice(0, 8);
    const mergeCommits = [];
    for (const prId of chosenPrIds) {
        const sha = await findMainMergeShaForPrId(prId);
        if (sha) {
            mergeCommits.push(sha);
        }
    }

    if (mergeCommits.length === 0) {
        return entries;
    }

    const createdAt = new Date().toISOString();
    const imported = {
        id: `imported-${Date.now()}`,
        createdAt,
        mode: "imported",
        run: {
            databaseId: `imported-${Date.now()}`,
            status: "completed",
            conclusion: "success",
            url: "",
        },
        runInput: {
            mergeCommits,
            branches: targetBranches,
            pushChanges: true,
            generateReleaseNotes: true,
        },
        details: targetBranches.map((branch) => ({
            branch,
            status: "success",
            applied: [...mergeCommits],
            skipped: [],
            pushed: true,
            failure: "",
        })),
        releaseNotesPath: "",
    };

    const next = [imported, ...entries];
    await saveRunHistory(next);
    return next;
}

async function loadRunHistory() {
    await ensureReleaseManagerDir();
    try {
        const raw = await readFile(runHistoryPath, "utf8");
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) {
            return trySeedRunHistory([]);
        }
        return trySeedRunHistory(parsed);
    } catch (error) {
        if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
            return trySeedRunHistory([]);
        }
        throw error;
    }
}

async function saveRunHistory(entries) {
    await ensureReleaseManagerDir();
    await writeFile(runHistoryPath, `${JSON.stringify(entries, null, 2)}\n`, "utf8");
}

async function recordRunHistory(run, runInput) {
    if (!run || !run.databaseId) {
        return;
    }
    const entries = await loadRunHistory();
    const id = String(run.databaseId);
    const next = entries.filter((entry) => String(entry.id) !== id);
    next.unshift({
        id,
        createdAt: new Date().toISOString(),
        mode: run.mode ?? "local",
        run: {
            databaseId: run.databaseId,
            status: run.status ?? "",
            conclusion: run.conclusion ?? "",
            url: run.url ?? "",
        },
        runInput: {
            mergeCommits: [...(runInput.mergeCommits ?? [])],
            branches: [...(runInput.branches ?? [])],
            pushChanges: Boolean(runInput.pushChanges),
            generateReleaseNotes: Boolean(runInput.generateReleaseNotes),
            executionMode: runInput.executionMode === "online" ? "online" : "local",
        },
        details: Array.isArray(run.details) ? run.details : undefined,
        releaseNotesPath: run.releaseNotesPath ?? "",
    });
    await saveRunHistory(next.slice(0, 100));
}

async function getCurrentBranch() {
    const result = await runCommand("git", ["rev-parse", "--abbrev-ref", "HEAD"]);
    if (result.code !== 0) {
        throw new Error(`Unable to determine current branch:\n${result.stderr || result.stdout}`.trim());
    }
    const branch = result.stdout.trim();
    if (!branch) {
        throw new Error("Unable to determine current branch.");
    }
    return branch;
}

function normalizeBoolean(value, defaultValue = true) {
    if (typeof value === "boolean") {
        return value;
    }
    if (typeof value === "string") {
        if (value.toLowerCase() === "true") {
            return true;
        }
        if (value.toLowerCase() === "false") {
            return false;
        }
    }
    return defaultValue;
}

async function listReleaseBranches() {
    await runCommand("git", ["fetch", "--no-tags", "origin", "refs/heads/release/*:refs/remotes/origin/release/*"]);
    const refsResult = await runCommand("git", ["for-each-ref", "--format=%(refname:short)", "refs/remotes/origin/release"]);
    if (refsResult.code !== 0) {
        throw new Error(`Unable to list release branches:\n${refsResult.stderr || refsResult.stdout}`.trim());
    }
    return refsResult.stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => line.replace(/^origin\//, ""))
        .sort((a, b) => b.localeCompare(a, undefined, { numeric: true, sensitivity: "base" }));
}

async function listMainMergeCommits(limit = 40) {
    await runCommand("git", ["fetch", "--no-tags", "origin", "main"]);
    const logResult = await runCommand("git", [
        "log",
        "origin/main",
        "--merges",
        "--date=short",
        `-n${limit}`,
        "--pretty=format:%H%x1f%ad%x1f%s",
    ]);
    if (logResult.code !== 0) {
        throw new Error(`Unable to list merge commits from main:\n${logResult.stderr || logResult.stdout}`.trim());
    }
    return logResult.stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
            const [sha, date, subject] = line.split("\u001f");
            return { sha, date, subject };
        });
}

function normalizeRunInput(input) {
    const selectedCommits = Array.isArray(input?.selectedMergeCommits)
        ? input.selectedMergeCommits.map((sha) => String(sha).trim()).filter(Boolean)
        : [];
    const manualCommits = tokenizeList(typeof input?.extraMergeCommits === "string" ? input.extraMergeCommits : "");
    const mergeCommits = [...new Set([...selectedCommits, ...manualCommits])];
    if (mergeCommits.length === 0) {
        throw new Error("Select at least one merge commit from main or add one manually.");
    }

    const branches = Array.isArray(input?.branches)
        ? input.branches.map((branch) => String(branch).trim()).filter((branch) => branch.startsWith("release/"))
        : [];
    if (branches.length === 0) {
        throw new Error("Select at least one target release branch.");
    }

    return {
        mergeCommits,
        branches: [...new Set(branches)],
        pushChanges: normalizeBoolean(input?.pushChanges, true),
        generateReleaseNotes: normalizeBoolean(input?.generateReleaseNotes, true),
        executionMode: input?.executionMode === "online" ? "online" : "local",
    };
}

function buildWorkflowFields(runInput) {
    return [
        `mergeCommits=${runInput.mergeCommits.join(",")}`,
        `releaseBranches=${runInput.branches.join(",")}`,
        `pushChanges=${runInput.pushChanges}`,
        `generateReleaseNotes=${runInput.generateReleaseNotes}`,
    ];
}

function sortReleaseBranchesAscending(branches) {
    function key(branch) {
        const match = /^release\/([0-9]+(?:\.[0-9]+)*)$/i.exec(branch);
        if (!match) {
            return branch.toLowerCase();
        }
        return match[1]
            .split(".")
            .map((part) => part.padStart(6, "0"))
            .join(".");
    }

    return [...branches].sort((left, right) => key(left).localeCompare(key(right), undefined, { sensitivity: "base" }));
}

async function getCommitSubject(sha) {
    const result = await runCommand("git", ["show", "-s", "--format=%s", sha]);
    if (result.code !== 0) {
        throw new Error(`Unable to inspect commit ${sha}:\n${result.stderr || result.stdout}`.trim());
    }
    return result.stdout.trim();
}

async function getCommitSubjectsMap(commits) {
    const map = new Map();
    for (const commit of commits) {
        map.set(commit, await getCommitSubject(commit));
    }
    return map;
}

async function validateLocalBackportInput(runInput) {
  for (const branch of runInput.branches) {
    const branchRef = await runCommand("git", ["rev-parse", "--verify", `refs/remotes/origin/${branch}`]);
    if (branchRef.code !== 0) {
      throw new Error(`Release branch '${branch}' does not exist on origin.`);
    }
  }
  for (const sha of runInput.mergeCommits) {
    const commit = await runCommand("git", ["cat-file", "-e", `${sha}^{commit}`]);
    if (commit.code !== 0) {
      throw new Error(`Commit '${sha}' does not exist in this repository.`);
    }
    const parents = await runCommand("git", ["rev-list", "--parents", "-n", "1", sha]);
    if (parents.code !== 0 || parents.stdout.trim().split(/\s+/).length < 3) {
      throw new Error(`Commit '${sha}' is not a merge commit.`);
    }
    const reachable = await runCommand("git", ["merge-base", "--is-ancestor", sha, "origin/main"]);
    if (reachable.code !== 0) {
      throw new Error(`Commit '${sha}' is not reachable from origin/main.`);
    }
  }
}

function getPrimaryPrIdFromSubject(subject) {
    const values = extractPrNumbers(subject).map((value) => Number.parseInt(value, 10)).filter(Number.isFinite);
    return values.length > 0 ? values[0] : null;
}

async function sortMergeCommitsByPrDescending(mergeCommits) {
    const subjects = await getCommitSubjectsMap(mergeCommits);
    const decorated = mergeCommits.map((sha, index) => {
        const subject = subjects.get(sha) ?? "";
        return {
            sha,
            index,
            prId: getPrimaryPrIdFromSubject(subject),
        };
    });

    decorated.sort((left, right) => {
        if (left.prId !== null && right.prId !== null && left.prId !== right.prId) {
            return right.prId - left.prId;
        }
        if (left.prId !== null && right.prId === null) {
            return -1;
        }
        if (left.prId === null && right.prId !== null) {
            return 1;
        }
        return left.index - right.index;
    });

    return decorated.map((entry) => entry.sha);
}

function isWorkflowNotFoundError(error) {
    return error instanceof Error && error.message.includes("workflow ReleaseManager.yaml not found on the default branch");
}

async function listRecentRuns(limit = 10) {
  const safeLimit = Math.max(1, Math.min(20, Number.parseInt(String(limit), 10) || 10));
  try {
    const output = await runGh([
      "run", "list", "--workflow", "ReleaseManager.yaml", "--limit", String(safeLimit),
      "--json", "databaseId,status,conclusion,createdAt,url",
    ]);
    const runs = JSON.parse(output || "[]");
    return Array.isArray(runs) ? runs : [];
  } catch {
    // GitHub run history is optional for local execution. Dispatching an
    // online run still reports authentication/CLI errors from runGh().
    return [];
  }
}

async function buildPastRunsForUi(recentRuns) {
    const history = await loadRunHistory();
    const historyMap = new Map(history.map((entry) => [String(entry.id), entry]));

    const runs = [];
    for (const run of recentRuns) {
        const id = String(run.databaseId);
        const historyEntry = historyMap.get(id);
        runs.push({
            id,
            mode: "github",
            status: run.status ?? "",
            conclusion: run.conclusion ?? "",
            createdAt: run.createdAt ?? (historyEntry?.createdAt ?? ""),
            url: run.url ?? "",
            hasStoredInput: Boolean(historyEntry?.runInput),
            releaseNotesPath: historyEntry?.releaseNotesPath ?? "",
            canApprovePush: Boolean(
                Array.isArray(historyEntry?.details)
                && historyEntry.details.some((detail) => detail && detail.readyForPush && detail.previewBranch),
            ),
        });
    }

    for (const entry of history) {
        if (runs.some((run) => run.id === String(entry.id))) {
            continue;
        }
        runs.push({
            id: String(entry.id),
            mode: entry.mode ?? "local",
            status: entry.run?.status ?? "completed",
            conclusion: entry.run?.conclusion ?? "",
            createdAt: entry.createdAt ?? "",
            url: entry.run?.url ?? "",
            hasStoredInput: Boolean(entry.runInput),
            releaseNotesPath: entry.releaseNotesPath ?? "",
            canApprovePush: Boolean(
                Array.isArray(entry.details)
                && entry.details.some((detail) => detail && detail.readyForPush && detail.previewBranch),
            ),
        });
    }

    runs.sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)));
    return runs.slice(0, 20);
}

async function triggerReleaseWorkflow(runInput) {
    const sortedMergeCommits = await sortMergeCommitsByPrDescending(runInput.mergeCommits);
    const orderedInput = {
        ...runInput,
        mergeCommits: sortedMergeCommits,
    };
    if (orderedInput.executionMode === "online") {
      return runOnlineWorkflow(orderedInput);
    }
    return runLocalBackport(orderedInput);
}

  async function runOnlineWorkflow(runInput) {
    const startedAt = Date.now();
    const fields = buildWorkflowFields(runInput);
    await runGh(["workflow", "run", "ReleaseManager.yaml", ...fields.flatMap((field) => ["-f", field])]);
    const runs = await listRecentRuns(5);
    const run = runs.find((candidate) => Date.parse(candidate.createdAt ?? "") >= startedAt - 60_000) ?? runs[0];
    return {
      databaseId: run?.databaseId ?? `online-${Date.now()}`,
      status: run?.status ?? "queued",
      conclusion: run?.conclusion ?? "",
      createdAt: run?.createdAt ?? new Date().toISOString(),
      url: run?.url ?? "",
      mode: "github",
    };
  }

function isEmptyCherryPick(text) {
    const value = String(text ?? "").toLowerCase();
    return value.includes("previous cherry-pick is now empty")
        || value.includes("nothing to commit")
        || value.includes("the previous cherry-pick is now empty");
}

async function runLocalBackportUnsafe(runInput) {
    const mergeCommits = runInput.mergeCommits;
    const branches = sortReleaseBranchesAscending(runInput.branches);
    const pushChanges = runInput.pushChanges;
    const results = [];
    let hadFailures = false;
    const localId = `local-${Date.now()}`;

    const fetchAll = await runCommand("git", ["fetch", "--no-tags", "origin"]);
    if (fetchAll.code !== 0) {
      throw new Error(`Unable to fetch origin:\n${fetchAll.stderr || fetchAll.stdout}`.trim());
    }

    for (const branch of branches) {
        const fetchBranch = await runCommand("git", ["fetch", "--no-tags", "origin", branch]);
        if (fetchBranch.code !== 0) {
            throw new Error(`Unable to fetch branch '${branch}':\n${fetchBranch.stderr || fetchBranch.stdout}`.trim());
        }

        const workBranch = `release-manager-local/${Date.now()}/${branch.replaceAll("/", "-")}`;
        const checkout = await runCommand("git", ["checkout", "-B", workBranch, `origin/${branch}`]);
        if (checkout.code !== 0) {
            throw new Error(`Unable to checkout '${branch}':\n${checkout.stderr || checkout.stdout}`.trim());
        }

        const applied = [];
        const skipped = [];
        let status = "success";
        let failure = "";
        let previewBranch = "";
        let readyForPush = false;
        let pushed = false;
        for (const mergeCommit of mergeCommits) {
            const pick = await runCommand("git", ["cherry-pick", "-m", "1", mergeCommit]);
            if (pick.code !== 0) {
                const output = `${pick.stdout}\n${pick.stderr}`.trim();
                if (isEmptyCherryPick(output)) {
                    const skip = await runCommand("git", ["cherry-pick", "--skip"]);
                    if (skip.code !== 0) {
                        throw new Error(`Cherry-pick '${mergeCommit}' on '${branch}' was empty, but skip failed:\n${skip.stderr || skip.stdout}`.trim());
                    }
                    skipped.push(mergeCommit);
                    continue;
                }

                await runCommand("git", ["cherry-pick", "--abort"]);
                status = "failed";
                failure = `Conflict while cherry-picking ${mergeCommit} on ${branch}.\n${output}`;
                hadFailures = true;
                break;
            }
            applied.push(mergeCommit);
        }

        if (status === "success" && applied.length > 0 && pushChanges) {
            previewBranch = `release-manager/preview/${localId}/${branch.replaceAll("/", "-")}`;
            const push = await runCommand("git", ["push", "origin", `HEAD:${previewBranch}`]);
            if (push.code !== 0) {
                status = "failed";
                failure = `Cherry-picks succeeded on ${branch}, but preview push failed.\n${push.stderr || push.stdout}`.trim();
                hadFailures = true;
            } else {
                readyForPush = true;
            }
        }

        results.push({
            branch,
            status,
            applied,
            skipped,
            pushed,
            previewBranch,
            readyForPush,
            failure,
        });
    }

    let releaseNotesPath = "";
    if (runInput.generateReleaseNotes) {
        const subjects = await getCommitSubjectsMap(mergeCommits);
        const lines = [];
        lines.push("# Local release backport notes");
        lines.push("");
        lines.push(`Generated: ${new Date().toISOString()}`);
        lines.push("");
        lines.push("## Merge commits (processed order)");
        lines.push("");
        for (const commit of mergeCommits) {
            lines.push(`- \`${commit}\` ${subjects.get(commit) ?? ""}`);
        }
        lines.push("");
        for (const entry of results) {
            lines.push(`## ${entry.branch}`);
            lines.push("");
            lines.push(`- Status: **${entry.status}**`);
            lines.push(`- Applied: ${entry.applied.length}`);
            lines.push(`- Skipped: ${entry.skipped.length}`);
            lines.push(`- Pushed: ${entry.pushed}`);
            if (entry.previewBranch) {
                lines.push(`- Preview branch: ${entry.previewBranch}`);
                lines.push(`- Ready for push approval: ${entry.readyForPush}`);
            }
            if (entry.failure) {
                lines.push("");
                lines.push("### Failure details");
                lines.push("```text");
                lines.push(entry.failure);
                lines.push("```");
            }
            lines.push("");
        }

        await ensureReleaseManagerDir();
        const fileName = `release-notes-local-${Date.now()}.md`;
        releaseNotesPath = join(releaseManagerDir, fileName);
        await writeFile(releaseNotesPath, `${lines.join("\n")}\n`, "utf8");
    }

    return {
        databaseId: localId,
        status: "completed",
        conclusion: hadFailures ? "failure" : "success",
        url: "",
        mode: "local",
        releaseNotesPath,
        details: results,
    };
}

  async function runLocalBackport(runInput) {
    const statusResult = await runCommand("git", ["status", "--porcelain"]);
    if (statusResult.code !== 0) {
      throw new Error(`Unable to inspect the local Git worktree:\n${statusResult.stderr || statusResult.stdout}`.trim());
    }
    if (statusResult.stdout.trim()) {
      throw new Error("The local worktree has uncommitted changes. Commit or stash them before starting a local backport.");
    }
    await validateLocalBackportInput(runInput);
    const branchResult = await runCommand("git", ["symbolic-ref", "--short", "-q", "HEAD"]);
    const headResult = await runCommand("git", ["rev-parse", "HEAD"]);
    const restoreRef = branchResult.code === 0 && branchResult.stdout.trim()
      ? branchResult.stdout.trim()
      : headResult.stdout.trim();
    if (!restoreRef) {
      throw new Error("Unable to determine the current Git checkout before starting the local run.");
    }

    try {
      return await runLocalBackportUnsafe(runInput);
    } finally {
      const restoreArgs = branchResult.code === 0 && branchResult.stdout.trim()
        ? ["checkout", restoreRef]
        : ["checkout", "--detach", restoreRef];
      const restored = await runCommand("git", restoreArgs);
      if (restored.code !== 0) {
        // Do not hide the original run error, but make restoration failure visible.
        console.error(`Release manager could not restore Git checkout: ${restored.stderr || restored.stdout}`);
      }
    }
  }

async function approvePushForRun(runId) {
    const id = String(runId ?? "").trim();
    if (!id) {
        throw new Error("runId is required.");
    }

    const history = await loadRunHistory();
    const index = history.findIndex((entry) => String(entry.id) === id);
    if (index < 0) {
        throw new Error(`Run '${id}' is not available in local history.`);
    }
    const entry = history[index];
    if (entry.run?.conclusion === "failure") {
      throw new Error(`Run '${id}' contains failures; no preview branches can be approved.`);
    }
    if (!Array.isArray(entry.details) || entry.details.length === 0) {
        throw new Error(`Run '${id}' has no branch details to push.`);
    }

    const toPush = entry.details
        .filter((detail) => detail && detail.readyForPush && detail.previewBranch && detail.status === "success")
        .sort((left, right) => {
            const sorted = sortReleaseBranchesAscending([left.branch, right.branch]);
            return sorted[0] === left.branch ? -1 : 1;
        });

    if (toPush.length === 0) {
        throw new Error(`Run '${id}' has no approved preview branches waiting to push.`);
    }

    const branchResult = await runCommand("git", ["symbolic-ref", "--short", "-q", "HEAD"]);
    const headResult = await runCommand("git", ["rev-parse", "HEAD"]);
    const restoreRef = branchResult.code === 0 && branchResult.stdout.trim()
      ? branchResult.stdout.trim()
      : headResult.stdout.trim();
    try {
      for (const detail of toPush) {
        const fetchPreview = await runCommand("git", ["fetch", "--no-tags", "origin", detail.previewBranch]);
        if (fetchPreview.code !== 0) {
          throw new Error(`Unable to fetch preview branch '${detail.previewBranch}':\n${fetchPreview.stderr || fetchPreview.stdout}`.trim());
        }

        const workBranch = `release-manager/final/${id}/${detail.branch.replaceAll("/", "-")}`;
        const checkout = await runCommand("git", ["checkout", "-B", workBranch, `origin/${detail.previewBranch}`]);
        if (checkout.code !== 0) {
          throw new Error(`Unable to checkout preview branch '${detail.previewBranch}':\n${checkout.stderr || checkout.stdout}`.trim());
        }

        const push = await runCommand("git", ["push", "origin", `HEAD:${detail.branch}`]);
        if (push.code !== 0) {
          throw new Error(`Failed to push '${detail.branch}' from preview '${detail.previewBranch}':\n${push.stderr || push.stdout}`.trim());
        }

        detail.pushed = true;
        detail.readyForPush = false;
        detail.approvedPushAt = new Date().toISOString();
      }
    } finally {
      const restoreArgs = branchResult.code === 0 && branchResult.stdout.trim()
        ? ["checkout", restoreRef]
        : ["checkout", "--detach", restoreRef];
      await runCommand("git", restoreArgs);
    }

    history[index] = {
        ...entry,
        run: {
            ...(entry.run ?? {}),
            status: "completed",
            conclusion: "success",
        },
        details: entry.details,
    };
    await saveRunHistory(history);
    return { pushedBranches: toPush.map((detail) => detail.branch) };
}

async function generateReleaseNotesFromPastRun(runId) {
    const id = String(runId ?? "").trim();
    if (!id) {
        throw new Error("runId is required.");
    }

    const history = await loadRunHistory();
    const index = history.findIndex((entry) => String(entry.id) === id);
    if (index < 0) {
        throw new Error(`Run '${id}' is not available in local history.`);
    }

    const entry = history[index];
    if (!entry.runInput || !Array.isArray(entry.runInput.mergeCommits) || entry.runInput.mergeCommits.length === 0) {
        throw new Error(`Run '${id}' has no stored commit input for note generation.`);
    }

    const mergeCommits = entry.runInput.mergeCommits;
    const subjects = await getCommitSubjectsMap(mergeCommits);
    const lines = [];
    lines.push(`# Release notes for run ${id}`);
    lines.push("");
    lines.push(`Generated: ${new Date().toISOString()}`);
    lines.push(`Source mode: ${entry.mode ?? "unknown"}`);
    lines.push(`Run status: ${entry.run?.status ?? ""}${entry.run?.conclusion ? ` (${entry.run.conclusion})` : ""}`);
    lines.push("");
    lines.push("## Merge commits (processed order)");
    lines.push("");
    for (const commit of mergeCommits) {
        lines.push(`- \`${commit}\` ${subjects.get(commit) ?? ""}`);
    }
    lines.push("");

    if (Array.isArray(entry.details) && entry.details.length > 0) {
        for (const branchEntry of entry.details) {
            lines.push(`## ${branchEntry.branch}`);
            lines.push("");
            lines.push(`- Status: **${branchEntry.status}**`);
            lines.push(`- Applied: ${(branchEntry.applied ?? []).length}`);
            lines.push(`- Skipped: ${(branchEntry.skipped ?? []).length}`);
            lines.push(`- Pushed: ${Boolean(branchEntry.pushed)}`);
            if (branchEntry.failure) {
                lines.push("");
                lines.push("### Failure details");
                lines.push("```text");
                lines.push(String(branchEntry.failure));
                lines.push("```");
            }
            lines.push("");
        }
    } else {
        lines.push("## Branch scope");
        lines.push("");
        for (const branch of entry.runInput.branches ?? []) {
            lines.push(`- ${branch}`);
        }
        lines.push("");
    }

    await ensureReleaseManagerDir();
    const fileName = `release-notes-from-run-${id.replace(/[^a-zA-Z0-9._-]/g, "_")}-${Date.now()}.md`;
    const notesPath = join(releaseManagerDir, fileName);
    await writeFile(notesPath, `${lines.join("\n")}\n`, "utf8");

    history[index].releaseNotesPath = notesPath;
    await saveRunHistory(history);
    return notesPath;
}

async function getUiData() {
    if (!_repoRoot) {
        return {
            releaseBranches: [],
            mergeCommits: [],
            recentRuns: [],
            pastRuns: [],
            needsConfig: true,
        };
    }
    const [releaseBranches, mergeCommits, recentRuns] = await Promise.all([
        listReleaseBranches(),
        listMainMergeCommits(40),
        listRecentRuns(5),
    ]);
    const pastRuns = await buildPastRunsForUi(recentRuns);
    return {
        releaseBranches,
        mergeCommits,
        recentRuns,
        pastRuns,
    };
}

function normalizeSha(value) {
    return String(value ?? "").trim().toLowerCase();
}

function shaMatches(left, right) {
    const a = normalizeSha(left);
    const b = normalizeSha(right);
    return a === b || (a.length >= 7 && b.startsWith(a)) || (b.length >= 7 && a.startsWith(b));
}

function extractPrNumbers(text) {
    const values = new Set();
    const regex = /#(\d+)\b/g;
    let match = regex.exec(String(text ?? ""));
    while (match) {
        values.add(match[1]);
        match = regex.exec(String(text ?? ""));
    }
    return [...values];
}

async function getCherryPickedSourceShas(branch) {
    const result = await runCommand("git", [
        "log",
        `origin/${branch}`,
        "-n",
        "5000",
        "--grep",
        "cherry picked from commit",
        "--format=%B%x1e",
    ]);
    if (result.code !== 0) {
        throw new Error(`Unable to inspect cherry-picks for ${branch}:\n${result.stderr || result.stdout}`.trim());
    }

    const set = new Set();
    const blocks = result.stdout.split("\u001e");
    const regex = /cherry picked from commit ([0-9a-f]{7,40})/gi;
    for (const block of blocks) {
        let match = regex.exec(block);
        while (match) {
            set.add(match[1].toLowerCase());
            match = regex.exec(block);
        }
    }
    return set;
}

async function getBranchPrNumbers(branch) {
    const result = await runCommand("git", [
        "log",
        `origin/${branch}`,
        "-n",
        "5000",
        "--format=%s",
    ]);
    if (result.code !== 0) {
        throw new Error(`Unable to inspect PR references for ${branch}:\n${result.stderr || result.stdout}`.trim());
    }

    const set = new Set();
    for (const line of result.stdout.split(/\r?\n/)) {
        for (const number of extractPrNumbers(line)) {
            set.add(number);
        }
    }
    return set;
}

async function getCommitPrNumbers(mergeCommits) {
    const map = new Map();
    for (const commit of mergeCommits) {
        const result = await runCommand("git", ["show", "-s", "--format=%s", commit]);
        if (result.code !== 0) {
            throw new Error(`Unable to inspect commit ${commit}:\n${result.stderr || result.stdout}`.trim());
        }
        map.set(commit, extractPrNumbers(result.stdout));
    }
    return map;
}

async function getCommitCoverage(branches, mergeCommits) {
    const selectedBranches = Array.isArray(branches)
        ? branches.map((branch) => String(branch).trim()).filter((branch) => branch.startsWith("release/"))
        : [];
    const commits = Array.isArray(mergeCommits)
        ? mergeCommits.map((sha) => String(sha).trim()).filter(Boolean)
        : [];

    const coverage = {};
    if (selectedBranches.length === 0 || commits.length === 0) {
        return coverage;
    }

    const branchSources = new Map();
    const branchPrNumbers = new Map();
    for (const branch of selectedBranches) {
        const [sources, prNumbers] = await Promise.all([
            getCherryPickedSourceShas(branch),
            getBranchPrNumbers(branch),
        ]);
        branchSources.set(branch, sources);
        branchPrNumbers.set(branch, prNumbers);
    }
    const commitPrNumbers = await getCommitPrNumbers(commits);

    for (const commit of commits) {
        const prNumbers = commitPrNumbers.get(commit) ?? [];
        const coveredBranches = [];
        const uncoveredBranches = [];
        for (const branch of selectedBranches) {
            const sources = branchSources.get(branch) ?? new Set();
            const branchPrs = branchPrNumbers.get(branch) ?? new Set();
            const foundBySha = Array.from(sources).some((sha) => shaMatches(commit, sha));
            const foundByPrNumber = prNumbers.some((pr) => branchPrs.has(pr));
            const found = foundBySha || foundByPrNumber;
            if (found) {
                coveredBranches.push(branch);
            } else {
                uncoveredBranches.push(branch);
            }
        }
        coverage[commit] = {
            coveredBranches,
            uncoveredBranches,
            fullyCovered: coveredBranches.length === selectedBranches.length,
        };
    }

    return coverage;
}

function renderHtml(instanceId) {
    const state = instanceState.get(instanceId) ?? { lastRun: null, lastError: "" };
    const lastError = state.lastError ? `<div class="error">${escapeHtml(state.lastError)}</div>` : "";
    const runLink = state.lastRun?.url
        ? `<a class="link-btn" href="${escapeHtml(state.lastRun.url)}" target="_blank" rel="noreferrer">Open workflow run</a>`
        : `<span class="muted small">Local run (no GitHub Actions run URL)</span>`;
    const runCard = state.lastRun
        ? `<div class="run-card">
      <div class="run-card-head">
        <div class="run-pill">Latest run</div>
        <div class="run-id">#${escapeHtml(state.lastRun.databaseId)}</div>
      </div>
      <div class="run-meta">
        <span><strong>Status:</strong> ${escapeHtml(state.lastRun.status)}${state.lastRun.conclusion ? ` (${escapeHtml(state.lastRun.conclusion)})` : ""}</span>${state.lastRun.mode ? ` <span class="muted">(${escapeHtml(state.lastRun.mode)})</span>` : ""}
      </div>
      ${state.lastRun.releaseNotesPath ? `<div class="small muted"><strong>Release notes:</strong> <code>${escapeHtml(state.lastRun.releaseNotesPath)}</code></div>` : ""}
      ${runLink}
    </div>`
        : "";

    return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Release manager</title>
    <style>
      * { box-sizing: border-box; }
      body {
        margin: 0;
        padding: 18px;
        background: var(--background-color-default, #ffffff);
        color: var(--text-color-default, #1f2328);
        font-family: var(--font-sans, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif);
        font-size: var(--text-body-medium, 14px);
      }
      .shell {
        max-width: 1100px;
        margin: 0 auto;
      }
      .hero {
        border: 1px solid var(--border-color-default, #d1d9e0);
        border-radius: 14px;
        padding: 18px;
        background:
          linear-gradient(180deg, color-mix(in srgb, var(--background-color-default, #ffffff) 88%, var(--true-color-blue-muted, #ddf4ff) 12%) 0%, var(--background-color-default, #ffffff) 100%);
        margin-bottom: 14px;
      }
      h1 { margin: 0 0 6px; font-size: 24px; letter-spacing: -0.01em; }
      h2 { margin: 0 0 10px; font-size: 16px; }
      .muted { color: var(--text-color-muted, #656d76); }
      .row { margin-bottom: 14px; }
      .layout {
        display: grid;
        grid-template-columns: minmax(280px, 1fr) minmax(420px, 2fr);
        gap: 12px;
      }
      .panel {
        border: 1px solid var(--border-color-default, #d1d9e0);
        border-radius: 12px;
        padding: 12px;
        background: var(--background-color-default, #ffffff);
        box-shadow: 0 1px 0 color-mix(in srgb, var(--border-color-default, #d1d9e0) 50%, transparent);
      }
      .panel-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 10px; }
      .badge {
        border: 1px solid var(--border-color-default, #d1d9e0);
        border-radius: 999px;
        padding: 2px 9px;
        font-size: 12px;
        color: var(--text-color-muted, #656d76);
      }
      .list {
        max-height: 260px;
        overflow: auto;
        border: 1px solid var(--border-color-default, #d1d9e0);
        border-radius: 10px;
        padding: 8px;
        background: color-mix(in srgb, var(--background-color-default, #ffffff) 94%, var(--border-color-default, #d1d9e0) 6%);
      }
      .item {
        display: flex;
        align-items: flex-start;
        gap: 8px;
        margin: 0;
        padding: 8px;
        border-radius: 8px;
        cursor: pointer;
      }
      .item:hover {
        background: color-mix(in srgb, var(--background-color-default, #ffffff) 86%, var(--true-color-blue-muted, #ddf4ff) 14%);
      }
      .item + .item { margin-top: 4px; }
      .chip-wrap {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
      }
      .chip {
        border: 1px solid var(--border-color-default, #d1d9e0);
        border-radius: 999px;
        padding: 7px 12px;
        font-weight: 600;
        cursor: pointer;
        background: color-mix(in srgb, var(--background-color-default, #ffffff) 92%, var(--border-color-default, #d1d9e0) 8%);
      }
      .chip.selected {
        background: color-mix(in srgb, var(--true-color-blue, #0969da) 24%, var(--background-color-default, #ffffff) 76%);
        border-color: color-mix(in srgb, var(--true-color-blue, #0969da) 45%, var(--border-color-default, #d1d9e0) 55%);
      }
      .switches {
        display: flex;
        flex-wrap: wrap;
        gap: 10px;
      }
      .switch {
        border: 1px solid var(--border-color-default, #d1d9e0);
        border-radius: 999px;
        padding: 7px 12px;
        cursor: pointer;
        user-select: none;
      }
      .switch.on {
        background: color-mix(in srgb, var(--true-color-blue, #0969da) 20%, var(--background-color-default, #ffffff) 80%);
      }
      .item-content { min-width: 0; }
      .item-title { display: block; font-weight: 600; }
      .item-subtitle { display: block; margin-top: 2px; }
      textarea {
        width: 100%;
        min-height: 88px;
        background: transparent;
        color: inherit;
        border: 1px solid var(--border-color-default, #d1d9e0);
        border-radius: 10px;
        padding: 10px;
      }
      .commit-card {
        border: 1px solid var(--border-color-default, #d1d9e0);
        border-radius: 10px;
        padding: 9px 10px;
      }
      .commit-card.selected {
        border-color: color-mix(in srgb, var(--true-color-blue, #0969da) 45%, var(--border-color-default, #d1d9e0) 55%);
        background: color-mix(in srgb, var(--true-color-blue-muted, #ddf4ff) 25%, var(--background-color-default, #ffffff) 75%);
      }
      .commit-card.covered {
        opacity: 0.55;
        background: color-mix(in srgb, var(--background-color-default, #ffffff) 88%, var(--border-color-default, #d1d9e0) 12%);
      }
      .commit-card-head {
        display: flex;
        justify-content: space-between;
        gap: 8px;
        align-items: baseline;
      }
      .commit-cover-badge {
        border: 1px solid var(--border-color-default, #d1d9e0);
        border-radius: 999px;
        padding: 2px 8px;
        font-size: 11px;
        color: var(--text-color-muted, #656d76);
      }
      .checks {
        display: flex;
        gap: 10px;
        flex-wrap: wrap;
        border: 1px solid var(--border-color-default, #d1d9e0);
        border-radius: 12px;
        padding: 12px;
      }
      button {
        border: 1px solid var(--border-color-default, #d1d9e0);
        background: color-mix(in srgb, var(--background-color-default, #ffffff) 88%, var(--border-color-default, #d1d9e0) 12%);
        color: inherit;
        border-radius: 10px;
        padding: 8px 13px;
        cursor: pointer;
        font-weight: 600;
      }
      button:hover {
        background: color-mix(in srgb, var(--background-color-default, #ffffff) 74%, var(--border-color-default, #d1d9e0) 26%);
      }
      button:disabled {
        opacity: 0.65;
        cursor: default;
      }
      .actions { display: flex; gap: 8px; flex-wrap: wrap; }
      .primary {
        background: color-mix(in srgb, var(--true-color-blue, #0969da) 22%, var(--background-color-default, #ffffff) 78%);
        border-color: color-mix(in srgb, var(--true-color-blue, #0969da) 35%, var(--border-color-default, #d1d9e0) 65%);
      }
      .primary:hover {
        background: color-mix(in srgb, var(--true-color-blue, #0969da) 34%, var(--background-color-default, #ffffff) 66%);
      }
      .run-card {
        margin-top: 14px;
        border: 1px solid var(--border-color-default, #d1d9e0);
        border-radius: 12px;
        padding: 12px;
      }
      .run-card-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        margin-bottom: 8px;
      }
      .run-pill {
        border: 1px solid var(--border-color-default, #d1d9e0);
        border-radius: 999px;
        padding: 2px 10px;
        font-size: 12px;
        color: var(--text-color-muted, #656d76);
      }
      .run-id {
        font-weight: 700;
        font-family: var(--font-mono, Consolas, monospace);
      }
      .run-meta {
        margin-bottom: 8px;
      }
      .link-btn {
        display: inline-flex;
        align-items: center;
        text-decoration: none;
        border: 1px solid var(--border-color-default, #d1d9e0);
        border-radius: 8px;
        padding: 6px 10px;
        color: inherit;
      }
      .error {
        margin-top: 12px;
        border: 1px solid #cf222e;
        color: #cf222e;
        border-radius: 12px;
        padding: 10px 12px;
        white-space: pre-wrap;
        background: color-mix(in srgb, var(--background-color-default, #ffffff) 92%, #cf222e 8%);
      }
      .commit-sha { font-family: var(--font-mono, Consolas, monospace); }
      .small { font-size: 12px; }
      .footer-actions {
        position: sticky;
        bottom: 0;
        background: var(--background-color-default, #ffffff);
        padding-top: 10px;
      }
      #status {
        min-height: 20px;
        margin-top: 6px;
      }
      .past-run {
        border: 1px solid var(--border-color-default, #d1d9e0);
        border-radius: 10px;
        padding: 8px 10px;
        margin-top: 8px;
      }
      .past-run-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
      }
      .past-run-meta {
        margin-top: 4px;
      }
      code {
        font-family: var(--font-mono, Consolas, monospace);
        font-size: 12px;
        border: 1px solid var(--border-color-default, #d1d9e0);
        border-radius: 6px;
        padding: 1px 5px;
      }
      @media (max-width: 900px) {
        .layout { grid-template-columns: 1fr; }
      }
    </style>
  </head>
  <body>
    <div class="shell">
      <div class="hero">
        <h1>Release manager</h1>
        <div class="muted">Select branches and merge commits from <code>main</code>, then run <code>ReleaseManager.yaml</code>.</div>
        <div class="actions" style="margin-top:12px;">
          <button id="changeRepoBtn" type="button">Change repository</button>
          ${_repoRoot ? `<span class="muted small">Connected to <code>${escapeHtml(_repoRoot)}</code></span>` : ""}
        </div>
      </div>

      <div id="loading" class="row">Loading branches and merge commits…</div>

      <div id="app" style="display:none;">
        <div class="layout">
          <div class="panel">
            <div class="panel-head">
              <h2>1. Target release branches</h2>
              <div id="branchCount" class="badge">0 selected</div>
            </div>
            <div class="actions row">
              <button id="selectAllBranchesBtn" type="button">Select all</button>
              <button id="clearBranchesBtn" type="button">Clear</button>
            </div>
            <div id="branchesList" class="chip-wrap"></div>
          </div>

          <div class="panel">
            <div class="panel-head">
              <h2>2. Merge commits from main</h2>
              <div id="commitCount" class="badge">0 selected</div>
            </div>
            <div class="actions row">
              <button id="selectTopCommitsBtn" type="button">Select top 5</button>
              <button id="clearCommitsBtn" type="button">Clear</button>
            </div>
            <div id="coverageStatus" class="row small muted">Calculating selected-branch coverage…</div>
            <div id="commitsList" class="list"></div>
            <div class="row small muted">Commits already in all selected release branches are grayed out and auto-skipped.</div>
            <div class="row small muted">Missing one? Add extra SHA(s) manually.</div>
            <textarea id="extraMergeCommits" placeholder="Extra merge commit SHA(s): space/comma/newline separated"></textarea>
          </div>
        </div>

        <div class="row checks">
          <div id="executionModeToggle" class="switch">Execution: Local</div>
          <div id="pushChangesToggle" class="switch on">Push to release branches after manual approval: On</div>
          <div id="releaseNotesToggle" class="switch on">Generate release notes: On</div>
        </div>

        <div class="footer-actions">
          <div class="actions row">
            <button id="runBtn" class="primary" type="button">Run release workflow</button>
            <button id="reloadBtn" type="button">Reload branches/commits</button>
          </div>
        </div>
      </div>

      <div id="status" class="muted"></div>
      ${runCard}
      <div class="panel" style="margin-top:12px;">
        <div class="panel-head">
          <h2>Past runs</h2>
          <div class="badge">Generate notes on demand</div>
        </div>
        <div id="pastRunsList" class="row muted small">No run history yet.</div>
      </div>
      ${lastError}
    </div>

    <script>
      const status = document.getElementById("status");
      const loading = document.getElementById("loading");
      const app = document.getElementById("app");
      const branchCount = document.getElementById("branchCount");
      const commitCount = document.getElementById("commitCount");
      const coverageStatus = document.getElementById("coverageStatus");
      const pastRunsList = document.getElementById("pastRunsList");
      const branchesList = document.getElementById("branchesList");
      const commitsList = document.getElementById("commitsList");
      const runBtn = document.getElementById("runBtn");
      const reloadBtn = document.getElementById("reloadBtn");
      const selectAllBranchesBtn = document.getElementById("selectAllBranchesBtn");
      const clearBranchesBtn = document.getElementById("clearBranchesBtn");
      const selectTopCommitsBtn = document.getElementById("selectTopCommitsBtn");
      const clearCommitsBtn = document.getElementById("clearCommitsBtn");
      const pushChangesToggle = document.getElementById("pushChangesToggle");
      const releaseNotesToggle = document.getElementById("releaseNotesToggle");
      const changeRepoBtn = document.getElementById("changeRepoBtn");
      const executionModeToggle = document.getElementById("executionModeToggle");
      let pushChanges = true;
      let generateReleaseNotes = true;
      let executionMode = "local";
      let selectedBranches = new Set();
      let branchesInitialized = false;
      let selectedCommits = new Set();
      let allCommits = [];
      let coverageMap = {};

      function escapeClient(value) {
        return String(value ?? "")
          .replaceAll("&", "&amp;")
          .replaceAll("<", "&lt;")
          .replaceAll(">", "&gt;")
          .replaceAll('"', "&quot;")
          .replaceAll("'", "&#39;");
      }

      function safeClientUrl(value) {
        try {
          const url = new URL(String(value ?? ""));
          return url.protocol === "http:" || url.protocol === "https:" ? url.href : "";
        } catch {
          return "";
        }
      }

      function setLoading(isLoading, text) {
        loading.style.display = isLoading ? "block" : "none";
        if (text) loading.textContent = text;
        app.style.display = isLoading ? "none" : "block";
      }

      async function request(path, options = {}) {
        const response = await fetch(path, options);
        if (!response.ok) {
          const text = await response.text();
          throw new Error(text || ("Request failed: " + response.status));
        }
        return response.json();
      }

      function renderPastRuns(runs) {
        pastRunsList.innerHTML = "";
        if (!Array.isArray(runs) || runs.length === 0) {
          pastRunsList.textContent = "No run history yet.";
          return;
        }

        for (const run of runs) {
          const card = document.createElement("div");
          card.className = "past-run";

          const head = document.createElement("div");
          head.className = "past-run-head";
          head.innerHTML = '<div><strong>#' + escapeClient(run.id) + '</strong> <span class="muted">(' + escapeClient(run.mode || "github") + ')</span></div>';

          const actions = document.createElement("div");
          if (run.canApprovePush) {
            const pushBtn = document.createElement("button");
            pushBtn.type = "button";
            pushBtn.textContent = "Approve & push";
            pushBtn.addEventListener("click", async () => {
              pushBtn.disabled = true;
              status.textContent = "Pushing approved preview branches for run #" + run.id + "...";
              try {
                const result = await request("/api/approve-push", {
                  method: "POST",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({ runId: run.id }),
                });
                status.textContent = "Pushed branches: " + (result.pushedBranches || []).join(", ");
                await loadOptions();
              } catch (error) {
                status.textContent = error.message;
              } finally {
                pushBtn.disabled = false;
              }
            });
            actions.appendChild(pushBtn);
          }

          const notesBtn = document.createElement("button");
          notesBtn.type = "button";
          notesBtn.textContent = "Generate release notes";
          notesBtn.disabled = !run.hasStoredInput;
          notesBtn.addEventListener("click", async () => {
            notesBtn.disabled = true;
            status.textContent = "Generating release notes for run #" + run.id + "...";
            try {
              const result = await request("/api/generate-release-notes", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ runId: run.id }),
              });
              status.textContent = "Release notes generated: " + result.path;
              await loadOptions();
            } catch (error) {
              status.textContent = error.message;
            } finally {
              notesBtn.disabled = false;
            }
          });
          actions.appendChild(notesBtn);
          head.appendChild(actions);

          const meta = document.createElement("div");
          meta.className = "past-run-meta muted small";
          const runUrl = safeClientUrl(run.url);
          meta.innerHTML =
            'Status: ' + escapeClient(run.status || "unknown") + (run.conclusion ? ' (' + escapeClient(run.conclusion) + ')' : '') +
            (run.createdAt ? ' • ' + escapeClient(run.createdAt) : '') +
            (runUrl ? ' • <a href="' + escapeClient(runUrl) + '" target="_blank" rel="noreferrer">Open run</a>' : '');

          card.appendChild(head);
          card.appendChild(meta);

          if (!run.hasStoredInput) {
            const warn = document.createElement("div");
            warn.className = "muted small";
            warn.textContent = "This run was not triggered from this canvas history, so commit inputs are unavailable.";
            card.appendChild(warn);
          }

          if (run.releaseNotesPath) {
            const path = document.createElement("div");
            path.className = "small";
            path.innerHTML = '<strong>Latest notes:</strong> <code>' + escapeClient(run.releaseNotesPath) + '</code>';
            card.appendChild(path);
          }

          pastRunsList.appendChild(card);
        }
      }

      function updateCounts() {
        branchCount.textContent = selectedBranches.size + " selected";
        commitCount.textContent = selectedCommits.size + " selected";
      }

      function renderBranches(branches) {
        branchesList.innerHTML = "";
        if (!branches.length) {
          branchesList.textContent = "No release/* branches found.";
          updateCounts();
          return;
        }
        if (!branchesInitialized) {
          branches.forEach((branch) => selectedBranches.add(branch));
          branchesInitialized = true;
        } else {
          selectedBranches = new Set(branches.filter((branch) => selectedBranches.has(branch)));
        }
        for (const branch of branches) {
          const chip = document.createElement("button");
          chip.type = "button";
          chip.className = "chip" + (selectedBranches.has(branch) ? " selected" : "");
          chip.textContent = branch;
          chip.addEventListener("click", async () => {
            if (selectedBranches.has(branch)) {
              selectedBranches.delete(branch);
            } else {
              selectedBranches.add(branch);
            }
            renderBranches(branches);
            await refreshCoverage();
          });
          branchesList.appendChild(chip);
        }
        updateCounts();
      }

      function renderCommits(commits) {
        allCommits = commits.slice();
        commitsList.innerHTML = "";
        if (!commits.length) {
          commitsList.textContent = "No merge commits found on origin/main.";
          updateCounts();
          return;
        }
        for (const commit of commits) {
          const coverage = coverageMap[commit.sha] || { coveredBranches: [], uncoveredBranches: [], fullyCovered: false };
          const disabled = coverage.fullyCovered;
          if (disabled) {
            selectedCommits.delete(commit.sha);
          }

          const card = document.createElement("div");
          card.className = "commit-card" +
            (selectedCommits.has(commit.sha) ? " selected" : "") +
            (disabled ? " covered" : "");
          card.innerHTML =
            '<div class="commit-card-head">' +
              '<div class="item-title"><span class="commit-sha">' + escapeClient(commit.sha.substring(0, 10)) + '</span> ' + escapeClient(commit.subject) + '</div>' +
              '<div class="commit-cover-badge">' + coverage.coveredBranches.length + '/' + selectedBranches.size + ' branches</div>' +
            '</div>' +
            '<div class="item-subtitle muted small">' + escapeClient(commit.date) + '</div>';

          card.addEventListener("click", () => {
            if (disabled) {
              return;
            }
            if (selectedCommits.has(commit.sha)) {
              selectedCommits.delete(commit.sha);
            } else {
              selectedCommits.add(commit.sha);
            }
            renderCommits(allCommits);
          });
          commitsList.appendChild(card);
        }
        updateCounts();
      }

      function getCheckedValues(selector) {
        return [...document.querySelectorAll(selector + ":checked")].map((el) => el.value);
      }

      async function loadOptions() {
        setLoading(true, "Loading branches and merge commits…");
        try {
          const payload = await request("/api/options");
          if (payload.needsConfig) {
            setLoading(false);
            showConfigPanel();
            return;
          }
          renderBranches(payload.releaseBranches || []);
          allCommits = payload.mergeCommits || [];
          renderPastRuns(payload.pastRuns || []);
          await refreshCoverage();
          setLoading(false);
          status.textContent = "";
        } catch (error) {
          status.textContent = error.message;
          setLoading(true, "Unable to load data.");
        }
      }

      function showConfigPanel() {
        const shell = document.querySelector(".shell");
        shell.innerHTML = \`
          <div class="hero" style="margin-bottom:18px;">
            <div class="hero-inner">
              <span style="font-size:1.6em;">⚙️</span>
              <div>
                <div class="hero-title">Configure Repository</div>
                <div class="hero-sub">Set the path to your BC.BE-Project local checkout</div>
              </div>
            </div>
          </div>
          <div class="section-card" style="max-width:600px;">
            <div class="section-title">Repository Root Path</div>
            <p style="margin:0 0 12px;color:var(--text-color-muted);">
              Enter the absolute path to the root of the BC.BE-Project git repository on this machine.
            </p>
            <input id="repo-path-input" type="text" value="${escapeHtml(_repoRoot)}" placeholder="e.g. D:\\\\DevOps\\\\BC.BE-Project"
              style="width:100%;padding:8px 12px;border:1px solid var(--border-color-default);border-radius:6px;
                     background:var(--background-color-default);color:var(--text-color-default);font-size:14px;margin-bottom:12px;" />
            <div style="display:flex;gap:8px;">
              <button id="save-config-btn" class="btn-primary" style="padding:8px 20px;">Save & Connect</button>
              ${_repoRoot ? `<button id="cancel-config-btn" type="button" style="padding:8px 20px;">Cancel</button>` : ""}
            </div>
            <div id="config-status" style="margin-top:10px;color:var(--true-color-red,#d1242f);"></div>
          </div>
        \`;
        const input = document.getElementById("repo-path-input");
        const btn = document.getElementById("save-config-btn");
        const configStatus = document.getElementById("config-status");
        const cancelBtn = document.getElementById("cancel-config-btn");
        cancelBtn?.addEventListener("click", () => location.reload());
        btn.addEventListener("click", async () => {
          const path = input.value.trim();
          if (!path) { configStatus.textContent = "Please enter a path."; return; }
          configStatus.textContent = "";
          btn.disabled = true;
          btn.textContent = "Saving…";
          try {
            await request("/api/config", { method: "POST", body: JSON.stringify({ repoRoot: path }) });
            location.reload();
          } catch (err) {
            configStatus.textContent = err.message;
            btn.disabled = false;
            btn.textContent = "Save & Connect";
          }
        });
      }

      function setChecked(selector, checked, max = null) {
        if (selector === ".branch-box") {
          const branches = [...branchesList.querySelectorAll(".chip")].map((chip) => chip.textContent);
          selectedBranches.clear();
          branches.forEach((branch, index) => {
            if (max === null ? checked : checked && index < max) {
              selectedBranches.add(branch);
            }
          });
          renderBranches(branches);
          return;
        }
        if (selector === ".commit-box") {
          selectedCommits.clear();
          allCommits.forEach((commit, index) => {
            const coverage = coverageMap[commit.sha] || { fullyCovered: false };
            if (coverage.fullyCovered) {
              return;
            }
            if (max === null ? checked : checked && index < max) {
              selectedCommits.add(commit.sha);
            }
          });
          renderCommits(allCommits);
        }
      }

      function buildRunPayload() {
        return {
          branches: [...selectedBranches],
          selectedMergeCommits: [...selectedCommits],
          extraMergeCommits: document.getElementById("extraMergeCommits").value,
          pushChanges,
          generateReleaseNotes,
          executionMode,
        };
      }

      async function refreshCoverage() {
        const branches = [...selectedBranches];
        coverageStatus.textContent = "Calculating selected-branch coverage…";
        if (branches.length === 0) {
          coverageMap = {};
          renderCommits(allCommits);
          coverageStatus.textContent = "Select one or more release branches to evaluate coverage.";
          return;
        }
        try {
          const payload = await request("/api/commit-coverage", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              branches,
              mergeCommits: allCommits.map((commit) => commit.sha),
            }),
          });
          coverageMap = payload.coverage || {};
          renderCommits(allCommits);
          const fullyCovered = Object.values(coverageMap).filter((entry) => entry && entry.fullyCovered).length;
          coverageStatus.textContent = fullyCovered > 0
            ? fullyCovered + " commit(s) already present in all selected branches."
            : "No commits are fully covered across the selected branches.";
        } catch (error) {
          coverageStatus.textContent = error.message;
        }
      }

      runBtn.addEventListener("click", async () => {
        runBtn.disabled = true;
        status.textContent = "Triggering workflow…";
        try {
          await request("/api/run", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(buildRunPayload()),
          });
          status.textContent = "Workflow dispatched. Reloading panel…";
          location.reload();
        } catch (error) {
          status.textContent = error.message;
        } finally {
          runBtn.disabled = false;
        }
      });

      reloadBtn.addEventListener("click", async () => {
        await loadOptions();
      });
      selectAllBranchesBtn.addEventListener("click", async () => {
        setChecked(".branch-box", true);
        await refreshCoverage();
      });
      clearBranchesBtn.addEventListener("click", async () => {
        setChecked(".branch-box", false);
        await refreshCoverage();
      });
      selectTopCommitsBtn.addEventListener("click", () => setChecked(".commit-box", true, 5));
      clearCommitsBtn.addEventListener("click", () => setChecked(".commit-box", false));
      pushChangesToggle.addEventListener("click", () => {
        pushChanges = !pushChanges;
        pushChangesToggle.classList.toggle("on", pushChanges);
        pushChangesToggle.textContent = "Push to release branches after manual approval: " + (pushChanges ? "On" : "Off");
      });
      releaseNotesToggle.addEventListener("click", () => {
        generateReleaseNotes = !generateReleaseNotes;
        releaseNotesToggle.classList.toggle("on", generateReleaseNotes);
        releaseNotesToggle.textContent = "Generate release notes: " + (generateReleaseNotes ? "On" : "Off");
      });
      executionModeToggle.addEventListener("click", () => {
        executionMode = executionMode === "local" ? "online" : "local";
        executionModeToggle.classList.toggle("on", executionMode === "online");
        executionModeToggle.textContent = "Execution: " + (executionMode === "online" ? "GitHub Actions" : "Local");
        runBtn.textContent = executionMode === "online" ? "Run online workflow" : "Run local workflow";
      });
      changeRepoBtn?.addEventListener("click", showConfigPanel);

      loadOptions();
    </script>
  </body>
</html>`;
}

async function startServer(instanceId) {
    const server = createServer(async (req, res) => {
        try {
            if (req.method === "GET" && req.url === "/api/options") {
                const payload = await getUiData();
                res.setHeader("Content-Type", "application/json; charset=utf-8");
                res.end(JSON.stringify(payload));
                return;
            }

            if (req.method === "POST" && req.url === "/api/run") {
                const body = await readRequestBody(req);
                const parsed = JSON.parse(body || "{}");
                const runInput = normalizeRunInput(parsed);
                const run = await triggerReleaseWorkflow(runInput);
                await recordRunHistory(run, runInput);
                instanceState.set(instanceId, { lastRun: run, lastError: "" });
                res.setHeader("Content-Type", "application/json; charset=utf-8");
                res.end(JSON.stringify({ ok: true, run }));
                return;
            }

            if (req.method === "POST" && req.url === "/api/commit-coverage") {
                const body = await readRequestBody(req);
                const parsed = JSON.parse(body || "{}");
                const coverage = await getCommitCoverage(parsed.branches, parsed.mergeCommits);
                res.setHeader("Content-Type", "application/json; charset=utf-8");
                res.end(JSON.stringify({ ok: true, coverage }));
                return;
            }

            if (req.method === "POST" && req.url === "/api/generate-release-notes") {
                const body = await readRequestBody(req);
                const parsed = JSON.parse(body || "{}");
                const notesPath = await generateReleaseNotesFromPastRun(parsed.runId);
                res.setHeader("Content-Type", "application/json; charset=utf-8");
                res.end(JSON.stringify({ ok: true, path: notesPath }));
                return;
            }

            if (req.method === "GET" && req.url === "/api/config") {
                res.setHeader("Content-Type", "application/json; charset=utf-8");
                res.end(JSON.stringify({ repoRoot: _repoRoot }));
                return;
            }

            if (req.method === "POST" && req.url === "/api/config") {
                const body = await readRequestBody(req);
                const parsed = JSON.parse(body || "{}");
                if (!parsed.repoRoot) {
                    res.statusCode = 400;
                    res.end("repoRoot is required");
                    return;
                }
                await saveConfig(parsed.repoRoot.trim());
                res.setHeader("Content-Type", "application/json; charset=utf-8");
                res.end(JSON.stringify({ ok: true, repoRoot: _repoRoot }));
                return;
            }

            if (req.method === "POST" && req.url === "/api/approve-push") {
                const body = await readRequestBody(req);
                const parsed = JSON.parse(body || "{}");
                const result = await approvePushForRun(parsed.runId);
                res.setHeader("Content-Type", "application/json; charset=utf-8");
                res.end(JSON.stringify({ ok: true, ...result }));
                return;
            }

            res.setHeader("Content-Type", "text/html; charset=utf-8");
            res.end(renderHtml(instanceId));
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            const state = instanceState.get(instanceId) ?? { lastRun: null, lastError: "" };
            state.lastError = message;
            instanceState.set(instanceId, state);
            res.statusCode = 400;
            res.setHeader("Content-Type", "text/plain; charset=utf-8");
            res.end(message);
        }
    });

    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    return { server, url: `http://127.0.0.1:${port}/` };
}

const _session = await joinSession({
    canvases: [
        createCanvas({
            id: "release-manager",
            displayName: "Release manager",
            description: "Run release cherry-pick workflow from selected branches and merge commits.",
            actions: [
                {
                    name: "run_release_workflow",
                    description: "Dispatch ReleaseManager.yaml with selected merge commits and release branches.",
                    inputSchema: {
                        type: "object",
                        additionalProperties: false,
                        properties: {
                            selectedMergeCommits: {
                                type: "array",
                                items: { type: "string" },
                            },
                            extraMergeCommits: { type: "string" },
                            branches: {
                                type: "array",
                                items: { type: "string" },
                            },
                            pushChanges: { type: "boolean" },
                            generateReleaseNotes: { type: "boolean" },
                            executionMode: { type: "string", enum: ["local", "online"] },
                        },
                    },
                    handler: async (ctx) => {
                        const runInput = normalizeRunInput(ctx.input ?? {});
                        const run = await triggerReleaseWorkflow(runInput);
                        await recordRunHistory(run, runInput);
                        const state = instanceState.get(ctx.instanceId) ?? { lastRun: null, lastError: "" };
                        state.lastRun = run;
                        state.lastError = "";
                        instanceState.set(ctx.instanceId, state);
                        return { ok: true, run };
                    },
                },
                {
                    name: "list_release_options",
                    description: "List release branches and merge commit candidates from main.",
                    handler: async () => {
                        const payload = await getUiData();
                        return { ok: true, ...payload };
                    },
                },
                {
                    name: "list_recent_runs",
                    description: "List recent ReleaseManager workflow runs.",
                    inputSchema: {
                        type: "object",
                        additionalProperties: false,
                        properties: {
                            limit: { type: "integer", minimum: 1, maximum: 20 },
                        },
                    },
                    handler: async (ctx) => {
                        const limit = Number.isInteger(ctx.input?.limit) ? ctx.input.limit : 10;
                        const runs = await listRecentRuns(limit);
                        const state = instanceState.get(ctx.instanceId) ?? { lastRun: null, lastError: "" };
                        state.lastRun = runs[0] ?? null;
                        state.lastError = "";
                        instanceState.set(ctx.instanceId, state);
                        return { ok: true, runs };
                    },
                },
            ],
            open: async (ctx) => {
                let entry = servers.get(ctx.instanceId);
                if (!entry) {
                    entry = await startServer(ctx.instanceId);
                    servers.set(ctx.instanceId, entry);
                }
                if (!instanceState.has(ctx.instanceId)) {
                    instanceState.set(ctx.instanceId, { lastRun: null, lastError: "" });
                }
                return {
                    title: "Release manager",
                    url: entry.url,
                };
            },
            onClose: async (ctx) => {
                const entry = servers.get(ctx.instanceId);
                if (entry) {
                    servers.delete(ctx.instanceId);
                    await new Promise((resolve) => entry.server.close(() => resolve()));
                }
                instanceState.delete(ctx.instanceId);
            },
        }),
    ],
});

// Resolve repo root from the session workspace once joinSession has completed.
// NOTE: workspacePath for user-scope extensions is the session-state dir, not the project repo.
// We rely on the config file or the user setting it via the UI instead.
await loadConfig();
_session.log(`Release Manager (user-scope): repo = ${_repoRoot || "(not configured — open canvas to set path)"}`, { ephemeral: true });
