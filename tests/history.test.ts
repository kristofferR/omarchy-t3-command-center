import assert from "node:assert/strict";
import test from "node:test";
import * as Schema from "effect/Schema";
import { OrchestrationV2ThreadHistoryPage } from "@t3tools/contracts";
import { T3EnvironmentSession } from "../bridge/src/t3/session.ts";
import type { ThreadDto } from "../bridge/src/protocol/types.ts";
import { T3Projection } from "../bridge/src/t3/projection.ts";
import { T3ThreadHistory } from "../bridge/src/t3/history.ts";
import { decodeRequestLine } from "../bridge/src/protocol/decode.ts";
import { config, v2Projection, v2ShellSnapshot, assistantItem, projectedItem } from "./fixtures/t3.ts";

function projection(count = 2, prefix = "recent") {
  const items = Array.from({ length: count }, (_, index) => assistantItem(`${prefix} ${index}`, `${prefix}-${index}`));
  return { ...v2Projection, turnItems: items, visibleTurnItems: items.map((item, index) => projectedItem(item, index)) };
}
function page(prefix: string, count = 16, nextCursor: string | null = null) {
  return Schema.decodeUnknownSync(OrchestrationV2ThreadHistoryPage)({
    snapshotSequence: 1, items: projection(count, prefix).visibleTurnItems,
    nextCursor, hasMoreHistory: nextCursor !== null,
  });
}

test("history prepends upstream-decoded pages, deduplicates overlap, and keeps live text", () => {
  const history = new T3ThreadHistory();
  const initial = projection();
  history.reset("opaque-cursor", true);
  const request = history.begin(initial)!;
  assert.equal(history.begin(initial), null);
  const updated = { ...initial, turnItems: initial.turnItems.map((item) => ({ ...item, text: "Live update" })),
    visibleTurnItems: initial.visibleTurnItems.map((row) => ({ ...row, item: { ...row.item, text: "Live update" } })) };
  const older = page("older", 2);
  assert(history.complete(request, { ...older, items: [...older.items, initial.visibleTurnItems[0]!] }, updated));
  assert.deepEqual(history.rows(updated).map((row) => row.item.id), ["older-0", "older-1", "recent-0", "recent-1"]);
  assert.equal(history.rows(updated).at(-1)?.item.type, "assistant_message");
  assert.equal((history.rows(updated).at(-1)!.item as { text: string }).text, "Live update");
  assert.equal(history.state(updated).hasMore, false);
});

test("history cursor survives live events but stale completions and failures cannot replace a new snapshot", () => {
  const adapter = new T3Projection();
  adapter.config = config;
  adapter.shell = v2ShellSnapshot;
  adapter.applyThread({ kind: "snapshot", snapshotSequence: 1, projection: projection(), historyCursor: "first", hasMoreHistory: true });
  const request = adapter.history.begin(adapter.thread!)!;
  adapter.applyThread({ kind: "snapshot", snapshotSequence: 5, projection: projection(1, "replacement"), historyCursor: "second", hasMoreHistory: true });
  assert.equal(adapter.history.complete(request, page("stale"), adapter.thread!), false);
  assert.equal(adapter.history.fail(request, "Stale failure"), false);
  assert.equal(adapter.threadDto("environment-1").history.error, null);
  assert.equal(adapter.history.begin(adapter.thread!)?.cursor, "second");
  adapter.clearThread();
  assert.equal(adapter.history.complete(request, page("stale"), projection()), false);
});

test("history errors retain the cursor for retry, and jump to latest discards in-flight pages", () => {
  const history = new T3ThreadHistory();
  const initial = projection();
  history.reset("retry-cursor", true);
  const request = history.begin(initial)!;
  assert(history.fail(request, "Try again"));
  assert.equal(history.state(initial).loading, false);
  assert.equal(history.state(initial).error, "Try again");
  const retry = history.begin(initial)!;
  assert.equal(retry.cursor, "retry-cursor");
  history.latest();
  assert.equal(history.complete(retry, page("stale"), initial), false);
  assert.equal(history.state(initial).browsing, false);
  assert.deepEqual(history.rows(initial), initial.visibleTurnItems);
});

test("retained history pages locally and remote paging continues within memory and IPC limits", () => {
  const initial = projection(100);
  const history = new T3ThreadHistory();
  history.reset("remote-cursor", true);
  assert.equal(history.rows(initial).length, 64);
  assert.equal(history.begin(initial)?.cursor, null);
  assert.equal(history.rows(initial)[0]?.item.id, "recent-20");
  history.begin(initial);
  history.begin(initial);
  assert.equal(history.rows(initial)[0]?.item.id, "recent-0");
  for (let index = 0; index < 40; index++) {
    const request = history.begin(initial)!;
    assert.notEqual(request.cursor, null);
    assert(history.complete(request, page(`page-${index}`, 16, `cursor-${index}`), initial));
    assert(history.rows(initial).length <= 64);
  }
  assert.equal(history.rows(initial)[0]?.item.id, "page-39-0");
  history.latest();
  assert.equal(history.rows(initial).at(-1)?.item.id, "recent-99");
});

test("history does not resurrect a row hidden by a live update while its page was in flight", () => {
  const initial = projection();
  const history = new T3ThreadHistory();
  history.reset("cursor", true);
  const request = history.begin(initial)!;
  const hidden = assistantItem("Hidden", "hidden");
  const current = { ...initial, turnItems: [...initial.turnItems, hidden] };
  const older = page("older", 1);
  history.complete(request, { ...older, items: [projectedItem(hidden), ...older.items] }, current);
  assert(!history.rows(current).some((row) => row.item.id === hidden.id));
});

test("history operation validation requires environment and thread identity", () => {
  for (const type of ["thread.history.load", "thread.history.latest"]) {
    const decode = (payload: Record<string, unknown>) => decodeRequestLine(JSON.stringify({ protocolVersion: 1, requestId: "history", type, payload }));
    assert.throws(() => decode({ threadId: "thread" }), /environmentId/);
    assert.throws(() => decode({ environmentId: "environment" }), /threadId/);
    assert.equal(decode({ environmentId: "environment", threadId: "thread" }).type, type);
  }
});

test("session history loads publish loading state and ignore pages after close or reconnect", async () => {
  const snapshots: ThreadDto[] = [];
  let finishPage!: (value: OrchestrationV2ThreadHistoryPage) => void;
  const session = new T3EnvironmentSession({ onInbox() {}, onThread(dto) { snapshots.push(dto); },
    onMessageDelta() {}, onMessageCompleted() {}, onApproval() {}, onInput() {}, onClosed() {}, onError() {} },
    async () => new Promise((resolve) => { finishPage = resolve; }));
  Object.assign(session, { environmentId: "environment-1", prepared: {} });
  session.projection.config = config;
  session.projection.shell = v2ShellSnapshot;
  session.projection.applyThread({ kind: "snapshot", snapshotSequence: 1, projection: projection(), historyCursor: "cursor", hasMoreHistory: true });
  const loading = session.loadEarlier(v2Projection.thread.id);
  assert.equal(snapshots.at(-1)?.history.loading, true);
  assert.deepEqual(await session.loadEarlier(v2Projection.thread.id), { loaded: false });
  finishPage(page("older"));
  assert.deepEqual(await loading, { loaded: true });
  assert.equal(snapshots.at(-1)?.history.loading, false);
  session.projection.applyThread({ kind: "snapshot", snapshotSequence: 2, projection: projection(), historyCursor: "new", hasMoreHistory: true });
  const stale = session.loadEarlier(v2Projection.thread.id);
  await session.closeThread();
  const count = snapshots.length;
  finishPage(page("stale"));
  assert.deepEqual(await stale, { loaded: false });
  assert.equal(snapshots.length, count);
  assert.equal(session.projection.thread, null);
});

test("unsupported history loading returns a retryable UI state without querying the server", async () => {
  const session = new T3EnvironmentSession({ onInbox() {}, onThread() {}, onMessageDelta() {},
    onMessageCompleted() {}, onApproval() {}, onInput() {}, onClosed() {}, onError() {} });
  Object.assign(session, { environmentId: "environment-1", prepared: {} });
  session.projection.config = { ...config, threadSnapshotPagination: false };
  session.projection.shell = v2ShellSnapshot;
  session.projection.applyThread({ kind: "snapshot", snapshotSequence: 1, projection: projection(), historyCursor: "cursor", hasMoreHistory: true });
  await assert.rejects(session.loadEarlier(v2Projection.thread.id), /does not support/);
  assert.equal(session.projection.history.loading, false);
  assert.equal(session.projection.history.state(session.projection.thread!).hasMore, true);
});
