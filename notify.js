// Desktop notifications for new comments the dashboard would show, from anyone
// but you. A full dashboard load costs a few API calls per PR, too many to poll
// with, so each poll only runs the PR searches and re-fetches the PRs whose
// updated_at moved (a new comment bumps it).
const { execFile } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ENABLED = !["0", "false", "off", "no"].includes(String(process.env.NOTIFY ?? "").toLowerCase());
const INTERVAL_MS = Math.max(30, Number(process.env.NOTIFY_INTERVAL_SECONDS) || 60) * 1000;
const SOUND = process.env.NOTIFY_SOUND ?? "default";
// Also notify about your own comments, handy for checking notifications work.
const INCLUDE_MINE = ["1", "true", "on", "yes"].includes(String(process.env.NOTIFY_INCLUDE_MINE ?? "").toLowerCase());
// More new comments than this in one poll become a single summary notification.
const MAX_INDIVIDUAL = 4;
// A PR that just joined the dashboard (a new PR, or one you just commented on) has
// no baseline, so only comments newer than the last poll, plus this slack, count.
const NEW_PR_SLACK_MS = 10 * 60 * 1000;

const STATE_FILE =
  process.env.NOTIFY_STATE_FILE ||
  path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state"), "pr-comments-dashboard", "notified.json");

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    return null;
  }
}

function saveState(state) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE + ".tmp", JSON.stringify(state));
  fs.renameSync(STATE_FILE + ".tmp", STATE_FILE);
}

function run(cmd, args) {
  return new Promise((resolve, reject) =>
    execFile(cmd, args, { timeout: 10000 }, (err, _stdout, stderr) => (err ? reject(Object.assign(err, { stderr })) : resolve()))
  );
}

let warnedNotifier = false;

function snippet(body) {
  const text = body
    .replace(/```[\s\S]*?```/g, "[code]")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "[image]")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_`>#]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > 180 ? text.slice(0, 177) + "…" : text || "(no text)";
}

// Text goes in as separate argv entries, never through a shell, so comment
// bodies can't inject anything.
async function send({ title, subtitle, message, url, group }) {
  if (process.platform === "darwin") {
    try {
      // terminal-notifier (brew install terminal-notifier) opens the comment when clicked.
      const args = ["-title", title, "-subtitle", subtitle, "-message", message, "-group", group];
      if (url) args.push("-open", url);
      if (SOUND) args.push("-sound", SOUND);
      return await run("terminal-notifier", args);
    } catch (err) {
      if (err.code !== "ENOENT" && !warnedNotifier) {
        warnedNotifier = true;
        console.error(
          `Notifier: terminal-notifier failed (${String(err.stderr || err.message).trim()}); using osascript instead. ` +
            "Allow terminal-notifier in System Settings > Notifications so clicks open the comment."
        );
      }
    }
    // Built in, but clicking the notification can't open a URL.
    const script = [
      "on run argv",
      `display notification (item 3 of argv) with title (item 1 of argv) subtitle (item 2 of argv)${SOUND ? " sound name (item 4 of argv)" : ""}`,
      "end run",
    ];
    return run("osascript", [...script.flatMap((l) => ["-e", l]), title, subtitle, message, SOUND || ""]);
  }
  return run("notify-send", ["--app-name=PR comments", `${title}: ${subtitle}`, message]);
}

function notifyComments(comments, dashboardUrl) {
  if (comments.length > MAX_INDIVIDUAL) {
    const prs = new Set(comments.map((c) => c.prUrl));
    const authors = [...new Set(comments.map((c) => c.author))];
    return [
      {
        title: `${comments.length} new PR comments`,
        subtitle: `on ${prs.size} PR${prs.size === 1 ? "" : "s"}`,
        message: `From ${authors.slice(0, 3).join(", ")}${authors.length > 3 ? ` and ${authors.length - 3} more` : ""}`,
        url: dashboardUrl,
        group: "pr-comments-summary",
      },
    ];
  }
  return comments.map((c) => ({
    title: `${c.onMyPr ? "💬" : "↩️"} ${c.author} on ${c.repo.split("/")[1]}#${c.pr}`,
    subtitle: c.prTitle,
    message: snippet(c.body),
    url: c.url,
    group: `pr-comment-${c.id}`,
  }));
}

function startNotifier({ searchPrs, loadPr, getViewer, getData, onNewComments, dashboardUrl }) {
  if (!ENABLED) {
    console.log("Notifications off (NOTIFY=0).");
    return;
  }
  let state = loadState();
  let running = false;

  async function poll() {
    if (running) return;
    running = true;
    try {
      const viewer = await getViewer();
      const { prs } = await searchPrs();
      const now = Date.now();

      if (!state) {
        // First run: remember what's already there without notifying about it.
        const data = await getData(true);
        const ids = new Map();
        for (const c of data.comments) ids.set(c.prUrl, [...(ids.get(c.prUrl) || []), c.id]);
        state = {
          polledAt: now,
          prs: Object.fromEntries(prs.map((pr) => [pr.html_url, { updatedAt: pr.updated_at, ids: ids.get(pr.html_url) || [] }])),
        };
        saveState(state);
        console.log(`Notifications on: watching ${prs.length} PRs every ${INTERVAL_MS / 1000}s.`);
        return;
      }

      const fresh = [];
      const next = {};
      for (const pr of prs) {
        const known = state.prs[pr.html_url];
        if (known && known.updatedAt === pr.updated_at) {
          next[pr.html_url] = known;
          continue;
        }
        let comments;
        try {
          comments = await loadPr(pr);
        } catch (err) {
          console.error(`Notifier: ${err.message}`);
          if (known) next[pr.html_url] = known; // retry next poll
          continue;
        }
        const seen = new Set(known?.ids);
        const cutoff = state.polledAt - NEW_PR_SLACK_MS;
        fresh.push(
          ...comments.filter(
            (c) => (INCLUDE_MINE || c.author !== viewer) && (known ? !seen.has(c.id) : Date.parse(c.createdAt) > cutoff)
          )
        );
        next[pr.html_url] = { updatedAt: pr.updated_at, ids: comments.map((c) => c.id) };
      }
      state = { polledAt: now, prs: next };
      saveState(state);

      if (fresh.length) {
        fresh.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
        console.log(`Notifier: ${fresh.length} new comment(s): ${fresh.map((c) => c.url).join(" ")}`);
        onNewComments();
        for (const n of notifyComments(fresh, dashboardUrl)) {
          await send(n).catch((err) => console.error(`Notifier: couldn't show notification: ${err.message}`));
        }
      }
    } catch (err) {
      console.error(`Notifier: poll failed: ${err.message}`);
    } finally {
      running = false;
    }
  }

  setTimeout(poll, 3000);
  setInterval(poll, INTERVAL_MS).unref();
}

module.exports = { startNotifier, send };
