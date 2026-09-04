/**
 * The one real SQLite database behind `@op-engineering/op-sqlite` for a test
 * file. Kept dependency-free so a `jest.mock` factory can require it without
 * pulling the production modules into the mock graph.
 */
import { createNodeSqliteHandle, type NodeSqliteHandle } from './nodeSqlite';

export const sqliteHandle: NodeSqliteHandle = createNodeSqliteHandle();
