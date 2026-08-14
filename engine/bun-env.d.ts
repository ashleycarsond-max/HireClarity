/**
 * Minimal ambient types for the Bun APIs the engine uses (bun:sqlite,
 * Bun.serve, Bun.argv). The site itself also runs on Bun (see serve.ts) but
 * does not install @types/bun; this keeps the engine type-checkable without
 * pulling in the full Bun type package.
 */

declare module "bun:sqlite" {
  export interface SqlQuery {
    get(...params: unknown[]): Record<string, unknown> | null;
    all(...params: unknown[]): Record<string, unknown>[];
    run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
  }

  export class Database {
    constructor(path: string, opts?: { create?: boolean });
    exec(sql: string): void;
    query(sql: string): SqlQuery;
    close(): void;
  }
}

declare namespace Bun {
  const argv: string[];
  interface ServeOptions {
    port: number | string;
    fetch(req: Request): Response | Promise<Response>;
  }
  interface Server {
    stop(closeActiveConnections?: boolean): void;
  }
  function serve(opts: ServeOptions): Server;
}
