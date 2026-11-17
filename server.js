// Dependency-free server: fetches review and conversation comments on your PRs, plus
// replies to you on other people's PRs, from GitHub and serves them, plus the static dashboard, on a single port.
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { handleMcp } = require("./mcp");

const PORT = Number(process.env.PORT || 8787);
// Loopback by default: the API serves data fetched with your token. The Docker
// image sets HOST=0.0.0.0 and relies on the compose port binding to 127.0.0.1.
const HOST = process.env.HOST || "127.0.0.1";
const VERSION = process.env.APP_VERSION || "dev";
const TOKEN = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
const CONCURRENCY = Number(process.env.CONCURRENCY) || 8;
const CACHE_TTL_MS = (Number(process.env.CACHE_TTL_SECONDS) || 300) * 1000;
// Merged PRs are included only if merged within this many days, to bound API calls.
const MERGED_DAYS = Number(process.env.MERGED_DAYS) || 30;
const API = "https://api.github.com";
// Where local clones live on the host, for "Open in VS Code" links. A repo
// owner/name maps to REPOS_DIR/name unless overridden in REPO_PATHS
// ("owner/name=/abs/path,owner/other=/abs/path").
const REPOS_DIR = (process.env.REPOS_DIR || "").replace(/\/+$/, "");
const REPO_PATHS = Object.fromEntries(
  (process.env.REPO_PATHS || "")
    .split(",")
    .map((pair) => pair.split("=").map((s) => s.trim()))
    .filter(([repo, dir]) => repo && dir)
);
const PR_EXTENSION = "vscode://GitHub.vscode-pull-request-github";

if (!TOKEN) {
  console.error("GH_TOKEN is not set. Run with: GH_TOKEN=$(gh auth token) docker compose up");
  process.exit(1);
}

async function gh(url) {
  const res = await fetch(url.startsWith("http") ? url : API + url, {
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "pr-comments-dashboard",
    },
  });
  if (!res.ok) {
    throw new Error(`GitHub ${res.status} for ${url}: ${(await res.text()).slice(0, 200)}`);
  }
  const next = /<([^>]+)>;\s*rel="next"/.exec(res.headers.get("link") || "");
  return { body: await res.json(), next: next && next[1] };
}

async function graphql(query, variables) {
  const res = await fetch(`${API}/graphql`, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "User-Agent": "pr-comments-dashboard" },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (!res.ok || json.errors) {
    throw new Error(`GitHub GraphQL ${res.status}: ${JSON.stringify(json.errors || json).slice(0, 200)}`);
  }
  return json.data;
}

const THREADS_QUERY = `
  query($owner: String!, $name: String!, $number: Int!, $cursor: String) {
    repository(owner: $owner, name: $name) {
      pullRequest(number: $number) {
        reviewThreads(first: 100, after: $cursor) {
          pageInfo { hasNextPage endCursor }
          nodes { isResolved isOutdated comments(first: 100) { nodes { databaseId } } }
        }
      }
    }
  }`;

// The REST API doesn't expose thread resolution, so map each comment id to its
// thread's resolved/outdated state via GraphQL.
async function threadStates(repo, number) {
  const [owner, name] = repo.split("/");
  const states = new Map();
  for (let cursor = null, more = true; more; ) {
    const data = await graphql(THREADS_QUERY, { owner, name, number, cursor });
    const threads = data.repository.pullRequest.reviewThreads;
    for (const t of threads.nodes) {
      for (const c of t.comments.nodes) states.set(c.databaseId, { resolved: t.isResolved, outdated: t.isOutdated });
    }
    ({ hasNextPage: more, endCursor: cursor } = threads.pageInfo);
  }
  return states;
}

function localRepoDir(repo) {
  if (REPO_PATHS[repo]) return REPO_PATHS[repo].replace(/\/+$/, "");
  return REPOS_DIR ? `${REPOS_DIR}/${repo.split("/")[1]}` : null;
}

async function ghAll(url) {
  const items = [];
  for (let u = url; u; ) {
    const { body, next } = await gh(u);
    items.push(...(Array.isArray(body) ? body : body.items));
    u = next;
  }
  return items;
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx]);
    }
  });
  await Promise.all(workers);
  return out;
}

let viewer = process.env.GITHUB_AUTHOR || null;

// On other people's PRs, keep only what responds to you: your own comments (so
// reactions to them show), later comments in review threads you joined, and
// conversation comments that @mention you. REST replies all point at the thread's
// first comment, so that id identifies the thread.
function repliesToViewer(review, conversation) {
  const joined = new Map();
  for (const c of review) {
    const thread = c.inReplyTo ?? c.id;
    if (c.author === viewer && !(joined.get(thread) <= c.createdAt)) joined.set(thread, c.createdAt);
  }
  const mention = new RegExp(`@${viewer.replace(/[^\w-]/g, "")}(?![\\w-])`, "i");
  return [
    ...review.filter((c) => {
      const since = joined.get(c.inReplyTo ?? c.id);
      return c.author === viewer || (since && c.createdAt > since);
    }),
    ...conversation.filter((c) => c.author === viewer || mention.test(c.body)),
  ];
}

async function loadComments() {
  if (!viewer) viewer = (await gh("/user")).body.login;

  const search = (q) => ghAll(`/search/issues?q=${encodeURIComponent(q)}&per_page=100`);
  const since = new Date(Date.now() - MERGED_DAYS * 86400000).toISOString().slice(0, 10);
  // Other people's PRs you took part in. reviewed-by covers inline review comments,
  // commenter covers the Conversation tab; search has no OR, so run both.
  const others = `is:pr -author:${viewer}`;
  const [open, merged, ...participated] = await Promise.all([
    search(`is:pr is:open author:${viewer}`),
    search(`is:pr is:merged author:${viewer} merged:>=${since}`),
    search(`${others} is:open reviewed-by:${viewer}`),
    search(`${others} is:open commenter:${viewer}`),
    search(`${others} is:merged reviewed-by:${viewer} merged:>=${since}`),
    search(`${others} is:merged commenter:${viewer} merged:>=${since}`),
  ]);
  const otherPrs = [...new Map(participated.flat().map((pr) => [pr.html_url, pr])).values()];
  const prs = [
    ...open.map((pr) => ({ ...pr, state: "open", mine: true })),
    ...merged.map((pr) => ({ ...pr, state: "merged", mine: true })),
    ...otherPrs.map((pr) => ({ ...pr, state: pr.pull_request?.merged_at ? "merged" : "open", mine: false })),
  ];

  const perPr = await mapLimit(prs, CONCURRENCY, async (pr) => {
    const repo = pr.repository_url.replace(`${API}/repos/`, "");
    const [comments, states, issueComments] = await Promise.all([
      ghAll(`/repos/${repo}/pulls/${pr.number}/comments?per_page=100`),
      threadStates(repo, pr.number).catch((err) => {
        console.error(err.message);
        return new Map();
      }),
      // Search results carry the conversation comment count, so skip the call when there are none.
      pr.comments ? ghAll(`/repos/${repo}/issues/${pr.number}/comments?per_page=100`) : [],
    ]);
    const dir = localRepoDir(repo);
    // Merged PRs are already on the base branch, so there's nothing to check out.
    const checkoutUrl = pr.state === "merged" ? null : `${PR_EXTENSION}/checkout-pull-request?uri=${encodeURIComponent(pr.html_url)}`;
    const common = (c) => ({
      id: c.id,
      url: c.html_url,
      author: c.user?.login ?? "ghost",
      avatar: c.user?.avatar_url ?? "",
      repo,
      pr: pr.number,
      prTitle: pr.title,
      prUrl: pr.html_url,
      prState: pr.state,
      prAuthor: pr.user?.login ?? "ghost",
      onMyPr: pr.mine,
      body: c.body ?? "",
      vscodeCheckoutUrl: checkoutUrl,
      createdAt: c.created_at,
      reactions: Object.fromEntries(
        ["+1", "-1", "laugh", "hooray", "confused", "heart", "rocket", "eyes"]
          .map((k) => [k, c.reactions?.[k] ?? 0])
          .filter(([, n]) => n > 0)
      ),
      reactionCount: c.reactions?.total_count ?? 0,
    });
    const review = comments.map((c) => {
      const state = states.get(c.id);
      // Outdated comments have no current line; fall back to where they were made.
      const line = c.line ?? c.original_line ?? null;
      const localPath = dir && c.path ? `${dir}/${c.path}` : null;
      return {
        ...common(c),
        kind: "review",
        path: c.path,
        line,
        side: c.side ?? null,
        localPath,
        vscodeFileUrl: localPath
          ? `vscode://file${localPath.split("/").map(encodeURIComponent).join("/")}${line ? ":" + line : ""}`
          : null,
        resolved: state ? state.resolved : null,
        outdated: state ? state.outdated : c.line == null,
        isReply: Boolean(c.in_reply_to_id),
        inReplyTo: c.in_reply_to_id ?? null,
      };
    });
    // Replies to a review comment are the later comments in its thread. Count them
    // before repliesToViewer drops anything, so the number matches GitHub.
    for (const c of review) {
      const thread = c.inReplyTo ?? c.id;
      c.replyCount = review.filter((r) => (r.inReplyTo ?? r.id) === thread && r.createdAt > c.createdAt).length;
    }
    // Conversation-tab comments aren't tied to a file or thread. CI and other
    // bots post most of these, so keep only comments from real people.
    const conversation = issueComments
      .filter((c) => c.user?.type !== "Bot" && !c.user?.login?.endsWith("[bot]"))
      .map((c) => ({
        ...common(c),
        kind: "conversation",
        path: null,
        line: null,
        side: null,
        localPath: null,
        vscodeFileUrl: null,
        resolved: null,
        outdated: false,
        isReply: false,
        inReplyTo: null,
        replyCount: null, // no threading on the Conversation tab
      }));
    return pr.mine ? [...review, ...conversation] : repliesToViewer(review, conversation);
  });

  const comments = perPr.flat().sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return {
    viewer,
    openPrCount: open.length,
    mergedPrCount: merged.length,
    otherPrCount: otherPrs.length,
    mergedDays: MERGED_DAYS,
    comments, fetchedAt: new Date().toISOString() };
}

let cache = null;
let inflight = null;

function getData(force) {
  if (!force && cache && Date.now() - Date.parse(cache.fetchedAt) < CACHE_TTL_MS) {
    return Promise.resolve(cache);
  }
  if (!inflight) {
    inflight = loadComments()
      .then((data) => (cache = data))
      .finally(() => (inflight = null));
  }
  return inflight;
}

const INDEX = path.join(__dirname, "public", "index.html");

http
  .createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname === "/api/comments") {
      try {
        const data = await getData(url.searchParams.has("refresh"));
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(data));
      } catch (err) {
        console.error(err);
        res.writeHead(502, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }
    if (url.pathname === "/healthz") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, version: VERSION }));
      return;
    }
    if (url.pathname === "/mcp") {
      return handleMcp(req, res, getData);
    }
    if (url.pathname === "/") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      fs.createReadStream(INDEX).pipe(res);
      return;
    }
    res.writeHead(404).end("Not found");
  })
  .listen(PORT, HOST, () => console.log(`pr-comments-dashboard listening on http://localhost:${PORT}`));
