import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir, hostname } from "node:os";

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

  constructor(private readonly path = defaultPath()) {
    try {
      for (const operation of parseOperations(readFileSync(path, "utf8"))) this.operations.set(operation.operationId, operation);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") this.corruptState = true;
    }
    this.loadPendingLockState();
  }

  hasAny(tags: string[]): boolean {
    return this.corruptState || existsSync(`${this.path}.lock`) || [...this.operations.values()].some((operation) => operation.tags.some((dirty) => tags.some((tag) => dirty === tag || dirty.startsWith(`${tag}:`) || tag.startsWith(`${dirty}:`))));
  }

  hasDirtyState(): boolean { return this.corruptState || existsSync(`${this.path}.lock`) || this.operations.size > 0; }

  record(operationId: string, tags: string[], state: string): void {
    this.operations.set(operationId, { operationId, tags: [...new Set(tags)].sort(), state, recordedAt: new Date().toISOString() });
    this.clearedOperationIds.delete(operationId);
    this.persist();
  }

  clear(operationId: string): void {
    this.operations.delete(operationId);
    this.clearedOperationIds.add(operationId);
    this.persist();
  }

  list(): DirtyOperation[] { return [...this.operations.values()].sort((a, b) => a.recordedAt.localeCompare(b.recordedAt)); }

  private readLockOwner(lockPath: string): LockOwner | undefined {
    try {
      const parsed = JSON.parse(readFileSync(join(lockPath, "owner.json"), "utf8")) as Partial<LockOwner>;
      if (parsed.schemaVersion !== "inflow-dirty-cache-lock/v1" || !Number.isInteger(parsed.pid) || typeof parsed.hostname !== "string" || typeof parsed.createdAt !== "string" || !Array.isArray(parsed.pendingOperations)) return undefined;
      parseOperations(JSON.stringify({ schemaVersion: "inflow-dirty-cache/v1", operations: parsed.pendingOperations }));
      return parsed as LockOwner;
    } catch {
      return undefined;
    }
  }

  private loadPendingLockState(): void {
    const lockPath = `${this.path}.lock`;
    if (!existsSync(lockPath)) return;
    const owner = this.readLockOwner(lockPath);
    if (!owner) {
      this.corruptState = true;
      return;
    }
    for (const operation of owner.pendingOperations) this.operations.set(operation.operationId, operation);
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
    const lockPath = `${this.path}.lock`;
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
          pendingOperations: this.list(),
        };
        writeFileSync(join(lockPath, "owner.json"), `${JSON.stringify(owner)}\n`, { mode: 0o600 });
        break;
      }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const owner = this.readLockOwner(lockPath);
        if (owner && this.ownerIsDead(owner)) {
          for (const operation of owner.pendingOperations) this.operations.set(operation.operationId, operation);
          rmSync(lockPath, { recursive: true, force: true });
          continue;
        }
        if (!owner) this.corruptState = true;
        if (Date.now() - started > 5_000) throw new Error("DIRTY_QUARANTINE_LOCK_TIMEOUT");
        Atomics.wait(waitCell, 0, 0, 25);
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
