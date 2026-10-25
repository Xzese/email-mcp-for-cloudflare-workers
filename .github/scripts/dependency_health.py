"""Read dependency health; retry one failed CI attempt only for transport faults."""
import datetime as dt
import json
import os
from pathlib import Path
import re
import subprocess
import sys


class GitHub:
    def __init__(self, repo):
        if not re.fullmatch(r"[\w.-]+/[\w.-]+", repo):
            raise ValueError("Invalid repository")
        self.repo = repo

    def command(self, args):
        result = subprocess.run(["gh", *args], capture_output=True, text=True, timeout=45)
        if result.returncode:
            raise RuntimeError("GitHub request failed; private output withheld")
        return result.stdout

    def get(self, path):
        return json.loads(self.command(["api", f"repos/{self.repo}/{path}"]))

    def pages(self, path, key=None):
        rows = []
        for page in range(1, 11):
            separator = "&" if "?" in path else "?"
            value = self.get(f"{path}{separator}per_page=100&page={page}")
            items = value[key] if key else value
            rows.extend(items)
            if len(items) < 100:
                return rows
        raise RuntimeError("Pagination limit reached; no partial decision made")

    def logs(self, run_id, job_id):
        text = self.command(["run", "view", str(run_id), "--repo", self.repo,
                             "--job", str(job_id), "--log-failed"])
        if len(text) > 2 * 1024 * 1024:
            raise RuntimeError("Failure log too large for automatic classification")
        return text

    def rerun(self, run_id):
        self.command(["api", "--method", "POST",
                      f"repos/{self.repo}/actions/runs/{run_id}/rerun-failed-jobs"])


def dependency_pr(pr, repo, sha=None):
    return (pr.get("state") == "open" and not pr.get("draft")
            and pr.get("user", {}).get("login") == "dependabot[bot]"
            and pr.get("base", {}).get("ref") == "main"
            and pr.get("head", {}).get("repo", {}).get("full_name") == repo
            and (sha is None or pr["head"]["sha"] == sha))


def transient_failure(log):
    # Any other npm code (including unknown codes) requires a real fix or review.
    npm_codes = re.findall(r"npm (?:error|ERR!) code ([\w-]+)", log, re.I)
    if any(code.upper() not in {"ECONNRESET", "EAI_AGAIN", "ETIMEDOUT"} for code in npm_codes):
        return False
    # Never treat compiler or assertion failures as runner/network retries.
    if re.search(r"AssertionError|\berror TS\d{4}\b|\b(?:tests?|assertions?) failed\b|"
                 r"\[ERROR\]|Could not resolve|Cannot find (?:module|package)|Module not found|"
                 r"Transform failed|Build failed|ERR_MODULE_NOT_FOUND|SyntaxError|ReferenceError|"
                 r"(?:^|\n).*\bnot ok \d|# fail [1-9]|TypeError:(?![ \t]*fetch failed)", log, re.I):
        return False
    return bool(re.search(r"(?:code:\s*['\"]|Error:\s*(?:(?:write|read|connect) )?|npm (?:error|ERR!) code )"
                          r"(?:ECONNRESET|EAI_AGAIN|ETIMEDOUT)(?:['\"\s]|$)", log[-8192:]))


def first_failed_attempt(run, repo):
    return (run.get("name") == "CI" and run.get("path", "").split("@")[0] == ".github/workflows/ci.yml"
            and run.get("event") == "pull_request" and run.get("status") == "completed"
            and run.get("conclusion") == "failure" and run.get("run_attempt") == 1
            and run.get("head_repository", {}).get("full_name") == repo
            and re.fullmatch(r"[a-f0-9]{40}", run.get("head_sha", "")) is not None)


def retry(api, event):
    run_id = int(event["workflow_run"]["id"])
    run = api.get(f"actions/runs/{run_id}")
    if not first_failed_attempt(run, api.repo):
        return "No retry: this is not the first failed same-repository PR CI attempt."
    candidates = api.pages("pulls?state=open")
    pr = next((p for p in candidates if dependency_pr(p, api.repo, run["head_sha"])
               and p.get("auto_merge")), None)
    if pr is None:
        return "No retry: no matching current Dependabot PR with auto-merge enabled."
    jobs = api.pages(f"actions/runs/{run_id}/attempts/1/jobs", "jobs")
    failed = [j for j in jobs if j.get("conclusion") not in ("success", "skipped", "neutral")]
    if not failed or len(failed) > 10 or any(j.get("conclusion") != "failure" for j in failed):
        return "No retry: failures are not eligible for transport classification."
    if not all(transient_failure(api.logs(run_id, int(j["id"]))) for j in failed):
        return "No retry: at least one failed job has an unclassified or deterministic failure."
    # Recheck both authorities immediately before the only write operation.
    fresh_pr = api.get(f"pulls/{int(pr['number'])}")
    fresh_run = api.get(f"actions/runs/{run_id}")
    if (not dependency_pr(fresh_pr, api.repo, run["head_sha"]) or not fresh_pr.get("auto_merge")
            or not first_failed_attempt(fresh_run, api.repo) or fresh_run["head_sha"] != run["head_sha"]):
        return "No retry: PR or run changed during inspection."
    api.rerun(run_id)
    return f"Requested one failed-job retry for PR #{int(pr['number'])}, run {run_id}. Original logs remain retained."


def instant(value):
    return dt.datetime.fromisoformat(value.replace("Z", "+00:00"))


def report(api, now):
    rows = []
    for item in api.pages("pulls?state=open"):
        if not dependency_pr(item, api.repo):
            continue
        pr = api.get(f"pulls/{int(item['number'])}")
        if not dependency_pr(pr, api.repo, item["head"]["sha"]):
            continue
        checks = api.pages(f"commits/{pr['head']['sha']}/check-runs", "check_runs")
        bad = [c for c in checks if c.get("conclusion") not in ("success", "neutral", "skipped")]
        blockers = [(instant(c.get("completed_at") or c.get("started_at") or pr["updated_at"]),
                     f"{c['name']}: {c.get('conclusion') or c.get('status', 'unknown')}") for c in bad]
        if not pr.get("auto_merge"):
            blockers.append((instant(pr["updated_at"]), "Auto-merge is not enabled"))
        state = pr.get("mergeable_state")
        if not bad and state in ("behind", "blocked", "dirty", "unstable"):
            blockers.append((instant(pr["updated_at"]), "Merge state: " + state))
        old = [((now - since).total_seconds() / 3600, reason) for since, reason in blockers
               if (now - since).total_seconds() >= 24 * 3600]
        if old:
            reasons = [reason for _, reason in old]
            if bad and state in ("behind", "blocked", "dirty", "unstable"):
                reasons.append("Merge state: " + state)
            rows.append((int(pr["number"]), round(max(hours for hours, _ in old)), reasons))
    return rows


def markdown(value):
    return str(value).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace("|", "\\|").replace("\n", " ")


def main():
    api = GitHub(os.environ["GITHUB_REPOSITORY"])
    if sys.argv[1:] == ["retry"]:
        event = json.loads(Path(os.environ["GITHUB_EVENT_PATH"]).read_text())
        text, failed = retry(api, event), False
    elif sys.argv[1:] == ["report"]:
        rows = report(api, dt.datetime.now(dt.timezone.utc))
        lines = ["## Dependency PRs blocked for at least 24 hours", ""]
        for number, hours, reasons in rows:
            lines.append(f"- [PR #{number}](https://github.com/{api.repo}/pull/{number}) ({hours} hours): " + markdown("; ".join(reasons)))
        text, failed = "\n".join(lines) if rows else "No dependency PRs have been blocked for 24 hours.", bool(rows)
    else:
        raise ValueError("Use retry or report")
    print(text)
    if os.environ.get("GITHUB_STEP_SUMMARY"):
        with Path(os.environ["GITHUB_STEP_SUMMARY"]).open("a") as stream:
            stream.write(text + "\n")
    return int(failed)


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (KeyError, ValueError, RuntimeError, subprocess.TimeoutExpired):
        print("Dependency health could not complete its GitHub checks; no merge action was attempted.", file=sys.stderr)
        raise SystemExit(1)
