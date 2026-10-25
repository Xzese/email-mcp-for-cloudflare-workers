import copy
import datetime as dt
import unittest
from dependency_health import report, retry


REPO = "owner/repo"
SHA = "a" * 40
RUN = dict(id=7, name="CI", path=".github/workflows/ci.yml", event="pull_request",
           status="completed", conclusion="failure", run_attempt=1, head_sha=SHA,
           head_repository=dict(full_name=REPO))
PR = dict(number=42, state="open", draft=False, user=dict(login="dependabot[bot]"),
          base=dict(ref="main"), head=dict(sha=SHA, repo=dict(full_name=REPO)),
          auto_merge=dict(merge_method="squash"), created_at="2026-10-23T00:00:00Z",
          updated_at="2026-10-23T00:00:00Z", mergeable_state="blocked")


class FakeGitHub:
    repo = REPO

    def __init__(self):
        self.run, self.pr = copy.deepcopy(RUN), copy.deepcopy(PR)
        self.log = "TypeError: fetch failed\n[cause]: Error: write ECONNRESET\ncode: 'ECONNRESET'"
        self.fresh_sha = SHA
        self.writes = []
        self.checks = [dict(name="Cloudflare Worker", conclusion="failure", completed_at="2026-10-23T01:00:00Z")]

    def get(self, path):
        if path.startswith("actions/runs/"):
            return copy.deepcopy(self.run)
        value = copy.deepcopy(self.pr)
        value["head"]["sha"] = self.fresh_sha
        return value

    def pages(self, path, key=None):
        if path.startswith("pulls"):
            return [copy.deepcopy(self.pr)]
        if path.startswith("commits"):
            return self.checks
        return [dict(id=8, conclusion="failure")]

    def logs(self, run_id, job_id):
        return self.log

    def rerun(self, run_id):
        self.writes.append(run_id)
        self.run["run_attempt"] = 2


class DependencyHealth(unittest.TestCase):
    def test_transport_retry_is_bounded_and_deterministic_errors_stay_blocked(self):
        api = FakeGitHub()
        self.assertIn("Requested one", retry(api, dict(workflow_run=RUN)))
        self.assertIn("No retry", retry(api, dict(workflow_run=RUN)))
        self.assertEqual(api.writes, [7])
        for log in ["error TS2591: Cannot find name 'node:buffer'\nError: write ECONNRESET",
                    "AssertionError: expected 403\nError: write ECONNRESET",
                    'Error: write ECONNRESET\n✘ [ERROR] Could not resolve "missing-package"',
                    "Error: write ECONNRESET\nTypeError: value is not a function",
                    "Error: write ECONNRESET\nnot ok 3 - upload",
                    "Error: write ECONNRESET\nnpm error code ERESOLVE\nnpm error unable to resolve dependency tree",
                    "Error: write ECONNRESET\nnpm error code EUSAGE",
                    "Error: write ECONNRESET\nnpm ERR! code EUNKNOWN",
                    "Process exited with code 1"]:
            with self.subTest(log=log):
                api = FakeGitHub()
                api.log = log
                self.assertIn("No retry", retry(api, dict(workflow_run=RUN)))
                self.assertEqual(api.writes, [])

    def test_wrong_author_fork_or_changed_head_cannot_request_retry(self):
        for change in ["author", "fork", "sha", "disabled", "workflow"]:
            with self.subTest(change=change):
                api = FakeGitHub()
                if change == "author": api.pr["user"]["login"] = "someone-else"
                if change == "fork": api.pr["head"]["repo"]["full_name"] = "other/repo"
                if change == "sha": api.fresh_sha = "b" * 40
                if change == "disabled": api.pr["auto_merge"] = None
                if change == "workflow": api.run["path"] = ".github/workflows/other.yml"
                self.assertIn("No retry", retry(api, dict(workflow_run=RUN)))
                self.assertEqual(api.writes, [])

    def test_report_flags_old_failures_but_not_fresh_runs_or_success(self):
        api = FakeGitHub()
        now = dt.datetime(2026, 10, 25, tzinfo=dt.timezone.utc)
        self.assertEqual(report(api, now), [(42, 47, ["Cloudflare Worker: failure", "Merge state: blocked"])])
        api.checks.append(dict(name="New pending check", conclusion=None, status="in_progress", started_at="2026-10-24T23:30:00Z"))
        self.assertEqual(report(api, now), [(42, 47, ["Cloudflare Worker: failure", "Merge state: blocked"])])
        api.checks.pop()
        api.checks[0]["completed_at"] = "2026-10-24T23:30:00Z"
        self.assertEqual(report(api, now), [])
        api.checks[0]["conclusion"] = "success"
        api.pr["mergeable_state"] = "clean"
        self.assertEqual(report(api, now), [])
        self.assertEqual(api.writes, [])


if __name__ == "__main__":
    unittest.main()
