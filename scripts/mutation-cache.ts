import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir, hostname } from "node:os";
import { TTL } from "@local/plugin-cache";

export const DEFAULT_DIRTY_QUARANTINE_MAX_AGE_MS = TTL.HOUR;
const DEFAULT_LOCK_WAIT_MS = 5_000;
const LOCK_POLL_INTERVAL_MS = 25;

export interface DirtyTagQuarantineOptions {
  maxAgeMs?: number;
  now?: () => number;
  lockWaitMs?: number;
}

interface DirtyOperation {
  operationId: string;
  tags: string[];
  state: string;
  recordedAt: string;
}

interface LockOwner {
  schemaVersion: "inflow-dirty-cache-lock/v1";
  pid: number;
  hostname: string;
  createdAt: string;
  pendingOperations: DirtyOperation[];
}

type LockOwnerRead =
  | { status: "in_flight" }
  | { status: "invalid" }
  | { status: "valid"; owner: LockOwner };

function parseLockOwner(raw: string): LockOwner | undefined {
  const parsed = JSON.parse(raw) as Partial<LockOwner>;
  if (parsed.schemaVersion !== "inflow-dirty-cache-lock/v1" || !Number.isInteger(parsed.pid) || typeof parsed.hostname !== "string" || typeof parsed.createdAt !== "string" || !Array.isArray(parsed.pendingOperations)) return undefined;
  parseOperations(JSON.stringify({ schemaVersion: "inflow-dirty-cache/v1", operations: parsed.pendingOperations }));
  return parsed as LockOwner;
}

function parseOperations(raw: string): DirtyOperation[] {
  const parsed = JSON.parse(raw) as { schemaVersion?: unknown; operations?: unknown };
  if (parsed.schemaVersion !== "inflow-dirty-cache/v1" || !Array.isArray(parsed.operations)) {
    throw new Error("INVALID_DIRTY_QUARANTINE_SCHEMA");
  }
  for (const operation of parsed.operations) {
    if (!operation || typeof operation !== "object") throw new Error("INVALID_DIRTY_QUARANTINE_ROW");
    const row = operation as Partial<DirtyOperation>;
    if (typeof row.operationId !== "string" || !Array.isArray(row.tags) || !row.tags.every((tag) => typeof tag === "string") || typeof row.state !== "string" || typeof row.recordedAt !== "string") {
      throw new Error("INVALID_DIRTY_QUARANTINE_ROW");
    }
    const recordedAtMs = Date.parse(row.recordedAt);
    if (Number.isNaN(recordedAtMs)) throw new Error("INVALID_DIRTY_QUARANTINE_ROW");
  }
  return parsed.operations as DirtyOperation[];
}

function defaultPath(): string {
  const root = process.env.BIZ_ROOT || join(homedir(), "biz");
  return join(root, "var", "inflow-inventory-manager", "dirty-cache-tags.json");
}

export class DirtyTagQuarantine {
  private operations = new Map<string, DirtyOperation>();
  private corruptState = false;
  private clearedOperationIds = new Set<string>();
  private readonly maxAgeMs: number;
  private readonly now: () => number;
  private readonly lockWaitMs: number;

  constructor(private readonly path = defaultPath(), options: DirtyTagQuarantineOptions = {}) {
    this.maxAgeMs = options.maxAgeMs ?? DEFAULT_DIRTY_QUARANTINE_MAX_AGE_MS;
    this.now = options.now ?? Date.now;
    this.lockWaitMs = options.lockWaitMs ?? DEFAULT_LOCK_WAIT_MS;
    const pendingOwner = this.awaitLockOwner();
    this.loadLedger();
    if (pendingOwner) this.overlayPendingOperations(pendingOwner.pendingOperations);
    this.pruneExpired();
  }

  private loadLedger(): void {
    try {
      for (const operation of parseOperations(readFileSync(this.path, "utf8"))) this.operations.set(operation.operationId, operation);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") this.corruptState = true;
    }
  }

  private overlayPendingOperations(pendingOperations: DirtyOperation[]): void {
    for (const operation of pendingOperations) this.operations.set(operation.operationId, operation);
  }

  private get lockPath(): string {
    return `${this.path}.lock`;
  }

  private lockHeld(): boolean {
    return existsSync(this.lockPath);
  }

  hasAny(tags: string[]): boolean {
    this.pruneExpired();
    return this.corruptState || this.lockHeld() || [...this.operations.values()].some((operation) => operation.tags.some((dirty) => tags.some((tag) => dirty === tag || dirty.startsWith(`${tag}:`) || tag.startsWith(`${dirty}:`))));
  }

  hasDirtyState(): boolean {
    this.pruneExpired();
    return this.corruptState || this.lockHeld() || this.operations.size > 0;
  }

  record(operationId: string, tags: string[], state: string): void {
    const recordedAt = new Date(this.now()).toISOString();
    const uniqueSortedTags = [...new Set(tags)].sort();
    this.operations.set(operationId, { operationId, tags: uniqueSortedTags, state, recordedAt });
    this.clearedOperationIds.delete(operationId);
    this.persist();
  }

  clear(operationId: string): void {
    this.operations.delete(operationId);
    this.clearedOperationIds.add(operationId);
    this.persist();
  }

  list(): DirtyOperation[] {
    this.pruneExpired();
    return this.sortedOperations();
  }

  private sortedOperations(): DirtyOperation[] {
    return [...this.operations.values()].sort((a, b) => a.recordedAt.localeCompare(b.recordedAt));
  }

  private isExpired(operation: DirtyOperation): boolean {
    const ageMs = this.now() - Date.parse(operation.recordedAt);
    return ageMs > this.maxAgeMs;
  }

  private dropExpired(): boolean {
    const expired = [...this.operations.values()].filter((operation) => this.isExpired(operation));
    for (const operation of expired) this.operations.delete(operation.operationId);
    return expired.length > 0;
  }

  private pruneExpired(): void {
    const dropped = this.dropExpired();
    if (!dropped) return;
    if (this.lockHeld()) return;
    try {
      this.persist();
    } catch {
      return;
    }
  }

  private readLockOwner(lockPath: string): LockOwnerRead {
    let raw: string;
    try {
      raw = readFileSync(join(lockPath, "owner.json"), "utf8");
    } catch (error) {
      const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
      return missing ? { status: "in_flight" } : { status: "invalid" };
    }
    const stillEmpty = raw.length === 0;
    if (stillEmpty) return { status: "in_flight" };
    try {
      const owner = parseLockOwner(raw);
      return owner ? { status: "valid", owner } : { status: "invalid" };
    } catch {
      return { status: "invalid" };
    }
  }

  private awaitLockOwner(): LockOwner | undefined {
    const waitCell = new Int32Array(new SharedArrayBuffer(4));
    const started = Date.now();
    while (this.lockHeld()) {
      const ownerRead = this.readLockOwner(this.lockPath);
      if (ownerRead.status === "valid") return ownerRead.owner;
      if (ownerRead.status === "invalid") {
        this.corruptState = true;
        return undefined;
      }
      const waitedMs = Date.now() - started;
      if (waitedMs > this.lockWaitMs) {
        this.corruptState = true;
        return undefined;
      }
      Atomics.wait(waitCell, 0, 0, LOCK_POLL_INTERVAL_MS);
    }
    return undefined;
  }

  private ownerIsDead(owner: LockOwner): boolean {
    if (owner.hostname !== hostname()) return false;
    try {
      process.kill(owner.pid, 0);
      return false;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ESRCH";
    }
  }

  private persist(): void {
    if (this.corruptState) return;
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const lockPath = this.lockPath;
    const waitCell = new Int32Array(new SharedArrayBuffer(4));
    const started = Date.now();
    while (true) {
      try {
        mkdirSync(lockPath, { mode: 0o700 });
        const owner: LockOwner = {
          schemaVersion: "inflow-dirty-cache-lock/v1",
          pid: process.pid,
          hostname: hostname(),
          createdAt: new Date().toISOString(),
          pendingOperations: this.sortedOperations(),
        };
        const ownerPath = join(lockPath, "owner.json");
        const ownerTempPath = join(lockPath, "owner.json.tmp");
        writeFileSync(ownerTempPath, `${JSON.stringify(owner)}\n`, { mode: 0o600 });
        renameSync(ownerTempPath, ownerPath);
        break;
      }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const ownerRead = this.readLockOwner(lockPath);
        if (ownerRead.status === "valid" && this.ownerIsDead(ownerRead.owner)) {
          this.overlayPendingOperations(ownerRead.owner.pendingOperations);
          rmSync(lockPath, { recursive: true, force: true });
          continue;
        }
        if (ownerRead.status === "invalid") this.corruptState = true;
        const waitedMs = Date.now() - started;
        if (waitedMs > this.lockWaitMs) throw new Error("DIRTY_QUARANTINE_LOCK_TIMEOUT");
        Atomics.wait(waitCell, 0, 0, LOCK_POLL_INTERVAL_MS);
      }
    }
    try {
      const merged = new Map<string, DirtyOperation>();
      try {
        for (const operation of parseOperations(readFileSync(this.path, "utf8"))) merged.set(operation.operationId, operation);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("CORRUPT_DIRTY_QUARANTINE_STATE");
      }
      for (const id of this.clearedOperationIds) merged.delete(id);
      for (const operation of this.operations.values()) merged.set(operation.operationId, operation);
      for (const operation of [...merged.values()]) {
        if (this.isExpired(operation)) merged.delete(operation.operationId);
      }
      const rows = [...merged.values()].sort((a, b) => a.recordedAt.localeCompare(b.recordedAt));
      const temp = `${this.path}.${process.pid}.tmp`;
      writeFileSync(temp, `${JSON.stringify({ schemaVersion: "inflow-dirty-cache/v1", operations: rows }, null, 2)}\n`, { mode: 0o600 });
      renameSync(temp, this.path);
      chmodSync(this.path, 0o600);
      this.operations = merged;
      this.clearedOperationIds.clear();
    } finally {
      rmSync(lockPath, { recursive: true, force: true });
    }
  }
}
