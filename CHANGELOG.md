# Sparks Bus MCP — Changelog

## 0.2.0 — 2026-05-09

### Added — `bus_listen` tool (real-time notification)

**Problem:** Agents could only check the bus at session start (via SessionStart hook) or when prompted. No mid-session awareness of incoming messages. Discord doorbell worked but was external, asymmetric (your own sends didn't trigger it for yourself), and added a third-party dependency to core agent comms.

**Fix:** New `bus_listen(timeout_seconds=300)` tool. Blocks until a new message arrives for the calling agent (server-bound identity — caller cannot listen as another agent), then returns it. Polls the indexed `idx_messages_to(to_agent, read)` query every 2s; idle CPU is negligible. Race-safe with `bus_read` via conditional UPDATE (`WHERE id=? AND read=0`); only returns rows the caller actually claimed.

**Why polling (Option A) over inotify (B) or unix socket (C):**
- B is killed by SQLite WAL mode — main `.sqlite` file rarely changes, writes go to `.sqlite-wal`. Watching the right files plus checkpoint events is fragile.
- C reintroduces silent-failure surface: every writer (this MCP, Opie's MCP, bus-watcher, raw `sqlite3` INSERTs) would have to remember to poke the socket. The phantom-acker incident (resolved 2026-05-08) just taught us what happens when a notification path is bypassed.
- A is Mythos-clean: ~50 lines, no new deps, no new failure surfaces, indexed SELECT against a tiny table is microseconds.

**Boundary constraints (per Opie spec #109):**
1. **Identity** — server-bound `AGENT_ID` (env-set at MCP start). Caller cannot spoof. Stricter than the original spec, which had `agent_id` as a parameter.
2. **No new secrets surface** — uses existing `bus.sqlite`.
3. **Timeout required** — default 300s, capped at 3600s.
4. **Read flag** — claimed messages get `read=1` atomically via the conditional UPDATE.
5. **Concurrency** — `bus_read` and `bus_listen` race-safe via `UPDATE WHERE id=? AND read=0`; only the winner gets the row.
6. **Signal, not data** — returns metadata + body; never executes anything based on content. (Phantom-acker lesson.)

**Non-functional:** No new dependencies. Works on IGOR + artforge. Tool count: 5 → 6.

**Activation:** Tool becomes available on the next CC/Opie/Rocky session start (MCP servers reload at session boot).
