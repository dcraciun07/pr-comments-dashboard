// Minimal MCP server over Streamable HTTP (JSON responses, no SSE), so Claude
// can query the same cached comment data the dashboard shows.
const SUPPORTED_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

const LIST_TOOL = {
  name: "list_pr_comments",
  title: "List PR comments",
  description:
    "List review comments and conversation (issue) comments on the user's GitHub PRs (open, and optionally recently merged). " +
    "Conversation comments from bots are excluded. " +
    "Defaults to unreacted comments on open PRs from " +
    "other people (comments with zero reactions, excluding the user's own), newest first. " +
    "Replies are separate comments. Each result includes a link to the comment on GitHub. " +
    "With source=others (or any), also covers other people's PRs the user reviewed or commented on, " +
    "keeping only replies in review threads the user joined, conversation comments that @mention the user, " +
    "and the user's own comments there (use include_mine + reaction=reacted to see reactions to them).",
  inputSchema: {
    type: "object",
    properties: {
      reaction: {
        type: "string",
        enum: ["unreacted", "reacted", "any"],
        default: "unreacted",
        description: "Filter by whether the comment has any reactions.",
      },
      source: {
        type: "string",
        enum: ["mine", "others", "any"],
        default: "mine",
        description: "mine = comments on the user's own PRs; others = replies to the user on other people's PRs.",
      },
      state: {
        type: "string",
        enum: ["open", "merged", "any"],
        default: "open",
        description: "PR state. Merged PRs are limited to those merged in the last MERGED_DAYS (default 30) days.",
      },
      kind: {
        type: "string",
        enum: ["review", "conversation", "any"],
        default: "any",
        description: "review = inline code review comments; conversation = comments on the PR's Conversation tab (never resolvable).",
      },
      resolved: {
        type: "string",
        enum: ["unresolved", "resolved", "any"],
        default: "any",
        description: "Filter by whether the comment's review thread is resolved.",
      },
      author: { type: "string", description: "Only comments by this GitHub login." },
      repo: { type: "string", description: "Repo as owner/name, or just name." },
      pr: { type: "integer", description: "PR number (combine with repo if numbers clash)." },
      text: { type: "string", description: "Case-insensitive substring of the comment body." },
      include_mine: { type: "boolean", default: false, description: "Include the user's own comments." },
      refresh: { type: "boolean", default: false, description: "Bypass the 5-minute cache and re-fetch from GitHub." },
      limit: { type: "integer", default: 50, minimum: 1, maximum: 500 },
    },
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true, openWorldHint: true },
};

function filterComments(data, args) {
  const reaction = args.reaction || "unreacted";
  const author = args.author?.toLowerCase();
  const repo = args.repo?.toLowerCase();
  const text = args.text?.toLowerCase();
  return data.comments.filter((c) => {
    const source = args.source || "mine";
    if (source !== "any" && c.onMyPr !== (source === "mine")) return false;
    if ((args.state || "open") !== "any" && c.prState !== (args.state || "open")) return false;
    if (!args.include_mine && c.author === data.viewer) return false;
    if (args.kind && args.kind !== "any" && c.kind !== args.kind) return false;
    if (reaction === "unreacted" && c.reactionCount > 0) return false;
    if (reaction === "reacted" && c.reactionCount === 0) return false;
    if (args.resolved === "resolved" && c.resolved !== true) return false;
    if (args.resolved === "unresolved" && c.resolved === true) return false;
    if (author && c.author.toLowerCase() !== author) return false;
    const r = c.repo.toLowerCase();
    if (repo && r !== repo && !r.endsWith("/" + repo)) return false;
    if (args.pr && c.pr !== args.pr) return false;
    if (text && !c.body.toLowerCase().includes(text)) return false;
    return true;
  });
}

async function callTool(name, args, getData) {
  if (name !== LIST_TOOL.name) throw rpcError(-32602, `Unknown tool: ${name}`);
  try {
    const data = await getData(Boolean(args.refresh));
    const matched = filterComments(data, args);
    const limit = Math.min(Math.max(args.limit || 50, 1), 500);
    const comments = matched.slice(0, limit).map(({ id, avatar, vscodeFileUrl, vscodeCheckoutUrl, inReplyTo, ...c }) => c);
    const result = {
      viewer: data.viewer,
      fetchedAt: data.fetchedAt,
      openPrs: data.openPrCount,
      mergedPrs: data.mergedPrCount,
      mergedWithinDays: data.mergedDays,
      othersPrs: data.otherPrCount,
      matched: matched.length,
      returned: comments.length,
      comments,
    };
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  } catch (err) {
    return { isError: true, content: [{ type: "text", text: `Failed to fetch comments: ${err.message}` }] };
  }
}

function rpcError(code, message) {
  return Object.assign(new Error(message), { rpcCode: code });
}

async function dispatch(msg, getData) {
  switch (msg.method) {
    case "initialize": {
      const requested = msg.params?.protocolVersion;
      return {
        protocolVersion: SUPPORTED_VERSIONS.includes(requested) ? requested : SUPPORTED_VERSIONS[0],
        capabilities: { tools: {} },
        serverInfo: { name: "pr-comments", version: "1.0.0" },
      };
    }
    case "ping":
      return {};
    case "tools/list":
      return { tools: [LIST_TOOL] };
    case "tools/call":
      return callTool(msg.params?.name, msg.params?.arguments || {}, getData);
    default:
      throw rpcError(-32601, `Method not found: ${msg.method}`);
  }
}

async function handle(msg, getData) {
  // Notifications and client responses carry no id and get no reply.
  if (msg.id === undefined || msg.id === null || !msg.method) return null;
  try {
    return { jsonrpc: "2.0", id: msg.id, result: await dispatch(msg, getData) };
  } catch (err) {
    return { jsonrpc: "2.0", id: msg.id, error: { code: err.rpcCode || -32603, message: err.message } };
  }
}

function send(res, status, body) {
  res.writeHead(status, body ? { "Content-Type": "application/json" } : {});
  res.end(body ? JSON.stringify(body) : undefined);
}

async function handleMcp(req, res, getData) {
  // Guard against DNS-rebinding: only accept browser origins from localhost.
  const origin = req.headers.origin;
  if (origin && !/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
    return send(res, 403, { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Forbidden origin" } });
  }
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return send(res, 405);
  }

  let msg;
  try {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    msg = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return send(res, 400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
  }

  if (Array.isArray(msg)) {
    const replies = (await Promise.all(msg.map((m) => handle(m, getData)))).filter(Boolean);
    return replies.length ? send(res, 200, replies) : send(res, 202);
  }
  const reply = await handle(msg, getData);
  return reply ? send(res, 200, reply) : send(res, 202);
}

module.exports = { handleMcp };
