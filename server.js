import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import Database from "better-sqlite3";
import { join } from "node:path";
import { mkdirSync } from "node:fs";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const AGENT_ID = process.env.SPARKS_AGENT || "unknown";
const DB_DIR = process.env.SPARKS_BUS_DB_DIR || join(process.env.HOME, ".sparks");
const DB_PATH = join(DB_DIR, "bus.sqlite");

const KNOWN_AGENTS = ["CC", "Opie", "Rocky", "BW", "Cliff"];

// Wake endpoints — how to poke each agent
const WAKE_ENDPOINTS = {
  Rocky: { method: "queue" },  // Watcher delivers via Discord; Rocky pulls via bus_read
  BW:    { method: "http", url: "http://localhost:50090/api_message" },
  Cliff: { method: "http", url: "http://10.0.0.6:50091/api_message" },
  CC:    { method: "spawn", command: "claude" },
  Opie:  { method: "queue" },  // Opie pulls on next session
};

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------
mkdirSync(DB_DIR, { recursive: true });
const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    from_agent TEXT NOT NULL,
    to_agent TEXT NOT NULL,
    subject TEXT NOT NULL,
    body TEXT NOT NULL DEFAULT '{}',
    reply_to INTEGER REFERENCES messages(id),
    read INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    read_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_messages_to ON messages(to_agent, read);
  CREATE INDEX IF NOT EXISTS idx_messages_reply ON messages(reply_to);
`);

// Prepared statements
const insertMsg = db.prepare(`
  INSERT INTO messages (from_agent, to_agent, subject, body, reply_to)
  VALUES (?, ?, ?, ?, ?)
`);

const readUnread = db.prepare(`
  SELECT id, from_agent, to_agent, subject, body, reply_to, created_at
  FROM messages
  WHERE to_agent = ? AND read = 0
  ORDER BY created_at ASC
`);

const markRead = db.prepare(`
  UPDATE messages SET read = 1, read_at = datetime('now')
  WHERE to_agent = ? AND read = 0
`);

const markOneRead = db.prepare(`
  UPDATE messages SET read = 1, read_at = datetime('now')
  WHERE id = ?
`);

// Race-safe claim used by bus_listen — only succeeds if still unread
const markOneReadIfUnread = db.prepare(`
  UPDATE messages SET read = 1, read_at = datetime('now')
  WHERE id = ? AND read = 0
`);

const getMsg = db.prepare(`
  SELECT id, from_agent, to_agent, subject, body, reply_to, created_at, read
  FROM messages WHERE id = ?
`);

const getThread = db.prepare(`
  SELECT id, from_agent, to_agent, subject, body, reply_to, created_at, read
  FROM messages
  WHERE id = ? OR reply_to = ?
  ORDER BY created_at ASC
`);

// ---------------------------------------------------------------------------
// Wake mechanism
// ---------------------------------------------------------------------------
async function wakeAgent(agent, reason) {
  const endpoint = WAKE_ENDPOINTS[agent];
  if (!endpoint) return `Unknown agent: ${agent}`;

  switch (endpoint.method) {
    case "http": {
      try {
        const res = await fetch(endpoint.url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            text: `[Sparks Bus] Wake from ${AGENT_ID}: ${reason}`,
          }),
        });
        return res.ok ? `Woke ${agent} via HTTP` : `Wake failed: ${res.status}`;
      } catch (e) {
        return `Wake failed: ${e.message}`;
      }
    }

    case "spawn": {
      // CC: just queue, the discord bot or next session picks it up
      return `Message queued for ${agent} (spawns on next check)`;
    }

    case "queue": {
      return `Message queued for ${agent} (pulls on next session)`;
    }

    default:
      return `No wake method for ${agent}`;
  }
}

// ---------------------------------------------------------------------------
// MCP Server
// ---------------------------------------------------------------------------
const server = new McpServer({
  name: "sparks-bus",
  version: "0.1.0",
  description: `Sparks Bus — inter-agent message broker. You are ${AGENT_ID}. Use bus_send to message other agents (${KNOWN_AGENTS.filter(a => a !== AGENT_ID).join(", ")}). Use bus_read to check your inbox. Messages carry structured data — file paths, search results, task specs — not chat text.`,
});

// --- bus_send ---
server.tool(
  "bus_send",
  `Send a structured message to another agent. Available agents: ${KNOWN_AGENTS.join(", ")}`,
  {
    to: z.string().describe("Target agent name: CC, Opie, Rocky, BW, or Cliff"),
    subject: z.string().describe("Message subject — short, descriptive (e.g. 'research-complete', 'deploy-request')"),
    body: z.string().describe("Message body as JSON string — structured data, file paths, results, specs"),
    wake: z.boolean().optional().default(false).describe("If true, attempt to wake the target agent"),
  },
  async ({ to, subject, body, wake }) => {
    if (!KNOWN_AGENTS.includes(to)) {
      return { content: [{ type: "text", text: `Unknown agent "${to}". Known: ${KNOWN_AGENTS.join(", ")}` }] };
    }

    // Validate body is valid JSON
    try { JSON.parse(body); } catch {
      body = JSON.stringify({ text: body });
    }

    const result = insertMsg.run(AGENT_ID, to, subject, body, null);
    const msgId = result.lastInsertRowid;

    let wakeResult = "";
    if (wake) {
      wakeResult = "\n" + await wakeAgent(to, subject);
    }

    return {
      content: [{ type: "text", text: `Message #${msgId} sent to ${to}: "${subject}"${wakeResult}` }],
    };
  }
);

// --- bus_read ---
server.tool(
  "bus_read",
  `Read your unread messages. Returns all pending messages for ${AGENT_ID}.`,
  {
    mark_read: z.boolean().optional().default(true).describe("Mark messages as read after retrieving"),
  },
  async ({ mark_read }) => {
    const msgs = readUnread.all(AGENT_ID);

    if (!msgs.length) {
      return { content: [{ type: "text", text: "No unread messages." }] };
    }

    const formatted = msgs.map((m) => {
      let bodyParsed;
      try { bodyParsed = JSON.parse(m.body); } catch { bodyParsed = m.body; }
      return {
        id: m.id,
        from: m.from_agent,
        subject: m.subject,
        body: bodyParsed,
        reply_to: m.reply_to,
        time: m.created_at,
      };
    });

    if (mark_read) {
      markRead.run(AGENT_ID);
    }

    return {
      content: [{ type: "text", text: JSON.stringify(formatted, null, 2) }],
    };
  }
);

// --- bus_reply ---
server.tool(
  "bus_reply",
  "Reply to a specific message by ID. Creates a threaded response.",
  {
    message_id: z.number().describe("ID of the message to reply to"),
    body: z.string().describe("Reply body as JSON string"),
  },
  async ({ message_id, body }) => {
    const original = getMsg.get(message_id);
    if (!original) {
      return { content: [{ type: "text", text: `Message #${message_id} not found` }] };
    }

    try { JSON.parse(body); } catch {
      body = JSON.stringify({ text: body });
    }

    const subject = `re: ${original.subject}`;
    const result = insertMsg.run(AGENT_ID, original.from_agent, subject, body, message_id);

    markOneRead.run(message_id);

    return {
      content: [{ type: "text", text: `Reply #${result.lastInsertRowid} sent to ${original.from_agent}: "${subject}"` }],
    };
  }
);

// --- bus_broadcast ---
server.tool(
  "bus_broadcast",
  "Broadcast a message to all agents.",
  {
    subject: z.string().describe("Broadcast subject"),
    body: z.string().describe("Broadcast body as JSON string"),
  },
  async ({ subject, body }) => {
    try { JSON.parse(body); } catch {
      body = JSON.stringify({ text: body });
    }

    const targets = KNOWN_AGENTS.filter((a) => a !== AGENT_ID);
    const ids = [];
    for (const to of targets) {
      const result = insertMsg.run(AGENT_ID, to, subject, body, null);
      ids.push(result.lastInsertRowid);
    }

    return {
      content: [{ type: "text", text: `Broadcast "${subject}" sent to ${targets.join(", ")} (IDs: ${ids.join(", ")})` }],
    };
  }
);

// --- bus_wake ---
server.tool(
  "bus_wake",
  "Wake up a specific agent. Pings their endpoint to check messages.",
  {
    agent: z.string().describe("Agent to wake: CC, Opie, Rocky, BW, or Cliff"),
    reason: z.string().describe("Why you're waking them"),
  },
  async ({ agent, reason }) => {
    if (!KNOWN_AGENTS.includes(agent)) {
      return { content: [{ type: "text", text: `Unknown agent "${agent}"` }] };
    }
    const result = await wakeAgent(agent, reason);
    return { content: [{ type: "text", text: result }] };
  }
);

// --- bus_listen ---
// Real-time notification primitive. Blocks until a message arrives for AGENT_ID
// (server-bound identity — caller cannot listen as another agent), then returns
// it. Polls the indexed unread query every 2s; idle CPU is negligible.
// Race-safe with bus_read: claim via conditional UPDATE, only return rows we won.
server.tool(
  "bus_listen",
  `Block until a new message arrives for ${AGENT_ID}, then return it. Real-time alternative to bus_read. The tool call blocks server-side; use it when you're idle and willing to wait. Default 5min, max 1h. Auto-marks claimed messages read=1.`,
  {
    timeout_seconds: z.number().int().min(5).max(3600).optional().default(300).describe("Max seconds to block. Default 300, capped at 3600."),
  },
  async ({ timeout_seconds }) => {
    const POLL_INTERVAL_MS = 2000;
    const startMs = Date.now();
    const deadlineMs = startMs + timeout_seconds * 1000;

    while (Date.now() < deadlineMs) {
      const candidates = readUnread.all(AGENT_ID);

      // Race-safe claim — UPDATE WHERE id=? AND read=0; keep only winners.
      const claimed = [];
      for (const m of candidates) {
        const result = markOneReadIfUnread.run(m.id);
        if (result.changes === 1) claimed.push(m);
      }

      if (claimed.length) {
        const formatted = claimed.map((m) => {
          let bodyParsed;
          try { bodyParsed = JSON.parse(m.body); } catch { bodyParsed = m.body; }
          return {
            id: m.id,
            from: m.from_agent,
            subject: m.subject,
            body: bodyParsed,
            reply_to: m.reply_to,
            time: m.created_at,
          };
        });
        return {
          content: [{ type: "text", text: JSON.stringify({
            waited_ms: Date.now() - startMs,
            messages: formatted,
          }, null, 2) }],
        };
      }

      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }

    return {
      content: [{ type: "text", text: JSON.stringify({
        waited_ms: Date.now() - startMs,
        messages: [],
        timeout: true,
      }) }],
    };
  }
);

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
const transport = new StdioServerTransport();
await server.connect(transport);
