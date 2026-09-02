/**
 * Microtask storage — reads/writes ~/.blue-agent/microtasks.json,
 * ~/.blue-agent/microclaims.json, ~/.blue-agent/microreputation.json
 *
 * These three JSON files are the whole system. There is no server, no RPC,
 * and no chain call anywhere in `blue micro` — the dollar amounts below are
 * bookkeeping, and settling them is the operator's job.
 */

import fs from "fs";
import path from "path";
import os from "os";
import crypto from "crypto";

// ── Types ────────────────────────────────────────────────────────────────────

export type MicroPlatform = "x" | "farcaster" | "telegram" | "web";
export type MicroProof = "reply" | "quote" | "screenshot" | "url" | "video" | "text";
export type MicroApproval = "auto" | "manual" | "hybrid";
export type MicroStatus =
  | "open" | "active" | "submitted" | "approved" | "completed" | "expired" | "cancelled";
export type MicroClaimStatus = "accepted" | "submitted" | "approved" | "rejected" | "expired";
export type EscrowStatus = "pending" | "funded" | "released" | "refunded";

export interface MicroTask {
  id: string;
  title: string;
  description: string;
  creator_address: string;
  creator_handle?: string;

  platform: MicroPlatform;
  proof_required: MicroProof;
  must_mention?: string;

  reward_per_slot: number;
  slots_total: number;
  slots_filled: number;
  slots_remaining: number;

  approval_mode: MicroApproval;
  deadline: string;
  status: MicroStatus;

  // Named `escrow` because that is the on-disk key in existing
  // ~/.blue-agent/microtasks.json files. Nothing is held or escrowed —
  // these are counters over the task's stated budget.
  escrow: {
    amount_total: number;
    amount_locked: number;
    amount_released: number;
    amount_refunded: number;
    status: EscrowStatus;
  };

  created_at: string;
  updated_at: string;
}

export interface MicroClaim {
  id: string;
  task_id: string;
  claimant_address: string;
  claimant_handle: string;
  accepted_at: string;
  submitted_at?: string;
  proof?: string;
  proof_note?: string;
  status: MicroClaimStatus;
}

export interface MicroReputation {
  address: string;
  handle: string;
  score: number;
  completed: number;
  rejected: number;
  approved_rate: number;
  total_earned_usdc: number;
  avg_turnaround_minutes: number;
  last_activity: string;
}

// ── Paths ────────────────────────────────────────────────────────────────────

const DIR = path.join(os.homedir(), ".blue-agent");
const TASKS_FILE = path.join(DIR, "microtasks.json");
const CLAIMS_FILE = path.join(DIR, "microclaims.json");
const REP_FILE = path.join(DIR, "microreputation.json");

function ensureDir() {
  if (!fs.existsSync(DIR)) fs.mkdirSync(DIR, { recursive: true });
}

// ── Task storage ─────────────────────────────────────────────────────────────

export function loadTasks(): MicroTask[] {
  ensureDir();
  if (!fs.existsSync(TASKS_FILE)) return [];
  try {
    return JSON.parse(fs.readFileSync(TASKS_FILE, "utf8")) as MicroTask[];
  } catch {
    return [];
  }
}

export function saveTasks(tasks: MicroTask[]): void {
  ensureDir();
  fs.writeFileSync(TASKS_FILE, JSON.stringify(tasks, null, 2));
}

export function getTask(id: string): MicroTask | undefined {
  return loadTasks().find((t) => t.id === id);
}

export function upsertTask(task: MicroTask): void {
  const tasks = loadTasks();
  const idx = tasks.findIndex((t) => t.id === task.id);
  if (idx >= 0) tasks[idx] = task;
  else tasks.push(task);
  saveTasks(tasks);
}

export function createMicroTask(
  params: Omit<MicroTask, "id" | "slots_filled" | "slots_remaining" | "status" | "escrow" | "created_at" | "updated_at">
): MicroTask {
  const now = new Date().toISOString();
  const id = "micro_" + crypto.randomBytes(4).toString("hex");
  const task: MicroTask = {
    ...params,
    id,
    slots_filled: 0,
    slots_remaining: params.slots_total,
    status: "open",
    escrow: {
      amount_total: params.reward_per_slot * params.slots_total,
      amount_locked: params.reward_per_slot * params.slots_total,
      amount_released: 0,
      amount_refunded: 0,
      status: "funded",
    },
    created_at: now,
    updated_at: now,
  };
  upsertTask(task);
  return task;
}

// ── Claim storage ─────────────────────────────────────────────────────────────

export function loadClaims(): MicroClaim[] {
  ensureDir();
  if (!fs.existsSync(CLAIMS_FILE)) return [];
  try {
    return JSON.parse(fs.readFileSync(CLAIMS_FILE, "utf8")) as MicroClaim[];
  } catch {
    return [];
  }
}

export function saveClaims(claims: MicroClaim[]): void {
  ensureDir();
  fs.writeFileSync(CLAIMS_FILE, JSON.stringify(claims, null, 2));
}

export function getClaim(id: string): MicroClaim | undefined {
  return loadClaims().find((c) => c.id === id);
}

export function getClaimsForTask(taskId: string): MicroClaim[] {
  return loadClaims().filter((c) => c.task_id === taskId);
}

export function getClaimForTaskByHandle(taskId: string, handle: string): MicroClaim | undefined {
  const h = handle.replace(/^@/, "").toLowerCase();
  return loadClaims().find(
    (c) => c.task_id === taskId && c.claimant_handle.toLowerCase() === h
  );
}

export function upsertClaim(claim: MicroClaim): void {
  const claims = loadClaims();
  const idx = claims.findIndex((c) => c.id === claim.id);
  if (idx >= 0) claims[idx] = claim;
  else claims.push(claim);
  saveClaims(claims);
}

export function createClaim(taskId: string, handle: string): MicroClaim {
  const claim: MicroClaim = {
    id: "claim_" + crypto.randomBytes(4).toString("hex"),
    task_id: taskId,
    claimant_address: "0x" + "0".repeat(40),  // resolved from handle in production
    claimant_handle: handle.replace(/^@/, ""),
    accepted_at: new Date().toISOString(),
    status: "accepted",
  };
  upsertClaim(claim);
  return claim;
}

// ── Reputation storage ───────────────────────────────────────────────────────

export function loadReputation(): MicroReputation[] {
  ensureDir();
  if (!fs.existsSync(REP_FILE)) return [];
  try {
    return JSON.parse(fs.readFileSync(REP_FILE, "utf8")) as MicroReputation[];
  } catch {
    return [];
  }
}

export function saveReputation(reps: MicroReputation[]): void {
  ensureDir();
  fs.writeFileSync(REP_FILE, JSON.stringify(reps, null, 2));
}

export function getReputation(handle: string): MicroReputation {
  const h = handle.replace(/^@/, "").toLowerCase();
  const reps = loadReputation();
  return (
    reps.find((r) => r.handle.toLowerCase() === h) ?? {
      address: "0x" + "0".repeat(40),
      handle: h,
      score: 50,
      completed: 0,
      rejected: 0,
      approved_rate: 100,
      total_earned_usdc: 0,
      avg_turnaround_minutes: 0,
      last_activity: new Date().toISOString(),
    }
  );
}

export function updateReputation(
  handle: string,
  delta: Partial<Pick<MicroReputation, "completed" | "rejected" | "total_earned_usdc" | "avg_turnaround_minutes">>
): MicroReputation {
  const reps = loadReputation();
  const h = handle.replace(/^@/, "").toLowerCase();
  let rep = reps.find((r) => r.handle.toLowerCase() === h);

  if (!rep) {
    rep = {
      address: "0x" + "0".repeat(40),
      handle: h,
      score: 50,
      completed: 0,
      rejected: 0,
      approved_rate: 100,
      total_earned_usdc: 0,
      avg_turnaround_minutes: 0,
      last_activity: new Date().toISOString(),
    };
    reps.push(rep);
  }

  if (delta.completed !== undefined) rep.completed += delta.completed;
  if (delta.rejected !== undefined) rep.rejected += delta.rejected;
  if (delta.total_earned_usdc !== undefined) rep.total_earned_usdc += delta.total_earned_usdc;
  if (delta.avg_turnaround_minutes !== undefined) {
    rep.avg_turnaround_minutes = rep.avg_turnaround_minutes === 0
      ? delta.avg_turnaround_minutes
      : Math.round((rep.avg_turnaround_minutes + delta.avg_turnaround_minutes) / 2);
  }

  // Recalculate approval rate and score
  const total = rep.completed + rep.rejected;
  rep.approved_rate = total === 0 ? 100 : Math.round((rep.completed / total) * 100);
  rep.score = Math.min(
    100,
    Math.max(0, 50 + rep.completed * 2 - rep.rejected * 5 + (rep.approved_rate - 80) / 2)
  );
  rep.last_activity = new Date().toISOString();

  saveReputation(reps);
  return rep;
}

// ── Budget counters ───────────────────────────────────────────────────────────
// Arithmetic over the JSON file. No transfer happens here or anywhere else.

export const PLATFORM_FEE = 0.05;  // 5%

export function escrowRelease(task: MicroTask, _claimant: string, netAmount: number): MicroTask {
  task.escrow.amount_released += netAmount / (1 - PLATFORM_FEE);  // gross
  task.escrow.amount_locked = Math.max(0, task.escrow.amount_locked - task.reward_per_slot);
  task.escrow.status = task.escrow.amount_locked <= 0 ? "released" : "funded";
  task.updated_at = new Date().toISOString();
  return task;
}

export function escrowRefundSlot(task: MicroTask): MicroTask {
  task.escrow.amount_refunded += task.reward_per_slot;
  task.escrow.amount_locked = Math.max(0, task.escrow.amount_locked - task.reward_per_slot);
  task.escrow.status = task.escrow.amount_locked <= 0 ? "refunded" : "funded";
  task.updated_at = new Date().toISOString();
  return task;
}
