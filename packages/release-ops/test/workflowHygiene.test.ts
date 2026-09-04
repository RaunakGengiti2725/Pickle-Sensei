import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { findRepoRoot } from "../src/generateManifest.js";

// Pins the CI hygiene rules from REVIEW.md ("CI, runner and verification
// scripts"): every workflow token is least-privilege (`permissions:
// contents: read`), every job on the single physical Mac runner is bounded by
// `timeout-minutes`, the runner labels are exactly [self-hosted, macOS, ARM64],
// and no workflow that reaches that runner has a `pull_request` trigger
// (public repository x personal machine).

const REPO_ROOT = findRepoRoot(process.cwd());
const WORKFLOWS_DIR = join(REPO_ROOT, ".github", "workflows");
const SELF_HOSTED_LABELS = ["self-hosted", "macOS", "ARM64"];
const MAX_SELF_HOSTED_TIMEOUT_MINUTES = 150;

interface TopLevelBlock {
  key: string;
  lines: string[];
}

interface WorkflowJob {
  name: string;
  runsOn: string | null;
  timeoutMinutes: number | null;
}

interface Workflow {
  file: string;
  blocks: Map<string, TopLevelBlock>;
  jobs: WorkflowJob[];
}

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

function isContentLine(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.length > 0 && !trimmed.startsWith("#");
}

function splitTopLevelBlocks(source: string): Map<string, TopLevelBlock> {
  const blocks = new Map<string, TopLevelBlock>();
  let current: TopLevelBlock | null = null;
  for (const line of source.split(/\r?\n/)) {
    if (!isContentLine(line)) continue;
    const topLevel = /^([A-Za-z_][\w-]*):(?:\s|$)/.exec(line);
    if (topLevel && indentOf(line) === 0) {
      const key = topLevel[1] ?? "";
      current = { key, lines: [line] };
      blocks.set(key, current);
      continue;
    }
    if (current) current.lines.push(line);
  }
  return blocks;
}

function scalarValue(lines: string[], key: string): string | null {
  const pattern = new RegExp(`^\\s*${key}:\\s*(.*?)\\s*$`);
  for (const line of lines) {
    const match = pattern.exec(line);
    if (match) return match[1] ?? "";
  }
  return null;
}

function parseJobs(jobsBlock: TopLevelBlock | undefined): WorkflowJob[] {
  if (!jobsBlock) return [];
  const jobs: WorkflowJob[] = [];
  let currentLines: string[] | null = null;
  let currentName: string | null = null;
  const flush = () => {
    if (currentName === null || currentLines === null) return;
    const timeoutRaw = scalarValue(currentLines, "timeout-minutes");
    jobs.push({
      name: currentName,
      runsOn: scalarValue(currentLines, "runs-on"),
      timeoutMinutes: timeoutRaw === null ? null : Number(timeoutRaw),
    });
  };
  for (const line of jobsBlock.lines.slice(1)) {
    const jobHeader = /^([A-Za-z_][\w-]*):\s*$/.exec(line.trim());
    if (jobHeader && indentOf(line) === 2) {
      flush();
      currentName = jobHeader[1] ?? "";
      currentLines = [];
      continue;
    }
    if (currentLines && indentOf(line) > 2) currentLines.push(line);
  }
  flush();
  return jobs;
}

function loadWorkflows(): Workflow[] {
  return readdirSync(WORKFLOWS_DIR)
    .filter((file) => /\.ya?ml$/.test(file))
    .sort()
    .map((file) => {
      const source = readFileSync(join(WORKFLOWS_DIR, file), "utf8");
      const blocks = splitTopLevelBlocks(source);
      return { file, blocks, jobs: parseJobs(blocks.get("jobs")) };
    });
}

function isSelfHostedJob(job: WorkflowJob): boolean {
  return job.runsOn !== null && job.runsOn.includes("self-hosted");
}

function labelsOf(runsOn: string): string[] {
  const inner = runsOn.replace(/^\[/, "").replace(/\]$/, "");
  return inner
    .split(",")
    .map((label) => label.trim().replace(/^['"]|['"]$/g, ""))
    .filter((label) => label.length > 0);
}

const workflows = loadWorkflows();

describe("GitHub workflow hygiene (.github/workflows)", () => {
  it("finds the workflows this repo is known to ship", () => {
    const files = workflows.map((workflow) => workflow.file);
    expect(files).toEqual(
      expect.arrayContaining(["ci.yml", "mac-full-verify.yml", "mac-smoke-test.yml"]),
    );
  });

  it.each(workflows.map((workflow) => [workflow.file, workflow] as const))(
    "%s declares a top-level `permissions: contents: read` token",
    (_file, workflow) => {
      const permissions = workflow.blocks.get("permissions");
      expect(permissions, "missing top-level permissions block").toBeDefined();
      const contents = scalarValue(permissions?.lines.slice(1) ?? [], "contents");
      expect(contents).toBe("read");
      const extraScopes = (permissions?.lines.slice(1) ?? []).filter(
        (line) => !/^\s*contents:\s*read\s*$/.test(line),
      );
      expect(extraScopes, "only `contents: read` may be granted").toEqual([]);
    },
  );

  it.each(workflows.map((workflow) => [workflow.file, workflow] as const))(
    "%s has at least one job",
    (_file, workflow) => {
      expect(workflow.jobs.length).toBeGreaterThan(0);
      for (const job of workflow.jobs) {
        expect(job.runsOn, `${job.name} has no runs-on`).not.toBeNull();
      }
    },
  );

  const selfHostedJobs = workflows.flatMap((workflow) =>
    workflow.jobs.filter(isSelfHostedJob).map((job) => [workflow.file, job.name, job] as const),
  );

  it("routes Mac work through the self-hosted runner in every mac-* workflow", () => {
    const macWorkflows = workflows.filter((workflow) => workflow.file.startsWith("mac-"));
    expect(macWorkflows.length).toBeGreaterThan(0);
    for (const workflow of macWorkflows) {
      expect(workflow.jobs.some(isSelfHostedJob), `${workflow.file} has no self-hosted job`).toBe(
        true,
      );
    }
  });

  it.each(selfHostedJobs)(
    "%s job `%s` uses exactly the labels [self-hosted, macOS, ARM64]",
    (_file, _name, job) => {
      expect(labelsOf(job.runsOn ?? "")).toEqual(SELF_HOSTED_LABELS);
    },
  );

  it.each(selfHostedJobs)(
    `%s job \`%s\` is bounded by timeout-minutes <= ${MAX_SELF_HOSTED_TIMEOUT_MINUTES}`,
    (_file, _name, job) => {
      expect(job.timeoutMinutes, "self-hosted job has no timeout-minutes").not.toBeNull();
      expect(Number.isInteger(job.timeoutMinutes)).toBe(true);
      expect(job.timeoutMinutes ?? Number.POSITIVE_INFINITY).toBeGreaterThan(0);
      expect(job.timeoutMinutes ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(
        MAX_SELF_HOSTED_TIMEOUT_MINUTES,
      );
    },
  );

  it.each(
    workflows
      .filter((workflow) => workflow.jobs.some(isSelfHostedJob))
      .map((workflow) => [workflow.file, workflow] as const),
  )("%s (reaches the personal Mac) has no pull_request trigger", (_file, workflow) => {
    const on = workflow.blocks.get("on");
    expect(on, "missing `on:` block").toBeDefined();
    const triggers = (on?.lines ?? []).filter((line) => /^\s*pull_request(_target)?:/.test(line));
    expect(triggers).toEqual([]);
  });
});
