import importlib.util
import pathlib
import sys
import types
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
WORKFLOW = ROOT / "workflows"


class FakeError(Exception):
    def __init__(self, code, message):
        self.code = code
        self.message = message
        super().__init__(f"{code}: {message}")


class WorkflowHarness:
    def __init__(
        self,
        replies=(),
        models_list=None,
        task=None,
        run_context=None,
        file_tree=None,
        patch_errors=(),
    ):
        self.replies = list(replies)
        self.models_list = (
            [{"id": "test-model", "default": True, "contextLimit": 4096}]
            if models_list is None
            else models_list
        )
        self.task = task or {
            "id": "task-1",
            "title": "Implement feature",
            "description": "Update feature.py",
            "subTasks": [],
        }
        self.run_context = run_context or {
            "taskId": "task-1",
            "resume": {"pending": []},
        }
        self.file_tree = dict(file_tree or {})
        self.patch_errors = list(patch_errors)
        self.calls = []
        self.finished = []
        self.step_events = []
        self.patches = []
        self.proposed_subtasks = []
        self.requested_paths = []
        self.requested_read_sizes = []
        self.completions = []

        harness = self

        class FakeFiles:
            @staticmethod
            def read(path, max_bytes=None):
                harness.requested_paths.append(path)
                harness.requested_read_sizes.append((path, max_bytes))
                if path in {".env", ".env.local", "secret.pem", "rejected.txt"}:
                    raise FakeError("Validation", f"Path denied: {path}")
                if path not in harness.file_tree:
                    raise FakeError("NotFound", f"missing {path}")
                value = harness.file_tree[path]
                text = value[:max_bytes] if max_bytes is not None else value
                return {
                    "path": path,
                    "text": text,
                    "truncated": len(text) < len(value),
                    "bytes": len(value.encode("utf-8")),
                    "sha256": "hash",
                }

            @staticmethod
            def list(path=""):
                harness.calls.append(("files.list", path))
                prefix = f"{path}/" if path else ""
                entries = []
                seen_dirs = set()
                for file_path in harness.file_tree:
                    if not file_path.startswith(prefix):
                        continue
                    rest = file_path[len(prefix) :]
                    if "/" in rest:
                        directory = rest.split("/", 1)[0]
                        if directory not in seen_dirs:
                            entries.append({"name": directory, "kind": "dir"})
                            seen_dirs.add(directory)
                    else:
                        entries.append({"name": rest, "kind": "file"})
                return entries[:200]

        class FakePatch:
            @staticmethod
            def propose(title, edits, summary=None):
                harness.calls.append(("patch.propose", title, edits, summary))
                if harness.patch_errors:
                    error = harness.patch_errors.pop(0)
                    if error:
                        raise error
                harness.patches.append((title, edits, summary))

        class FakeTasks:
            @staticmethod
            def get(task_id):
                harness.calls.append(("tasks.get", task_id))
                return harness.task

            @staticmethod
            def propose_subtasks(task_id, items, presentation="notify"):
                harness.proposed_subtasks.append((task_id, items, presentation))

        class FakeNotes:
            @staticmethod
            def for_task(task_id):
                harness.calls.append(("notes.for_task", task_id))
                return harness.task.get("notes", [])

        class FakeRun:
            @staticmethod
            def context():
                harness.calls.append(("run.context",))
                return harness.run_context

            @staticmethod
            def finish(outcome, summary=None, reason=None):
                harness.finished.append(
                    {"outcome": outcome, "summary": summary, "reason": reason}
                )

            @staticmethod
            def step(subtask_id):
                class Step:
                    summary = None

                    def __enter__(self):
                        harness.step_events.append(("start", subtask_id))
                        return self

                    def __exit__(self, exc_type, exc, traceback):
                        harness.step_events.append(
                            (
                                "finish",
                                subtask_id,
                                "failed" if exc is not None else "needs_review",
                                self.summary,
                            )
                        )
                        return False

                return Step()

        class FakeModels:
            @staticmethod
            def list():
                harness.calls.append(("models.list",))
                return harness.models_list

            @staticmethod
            def complete(messages, **kwargs):
                harness.completions.append((messages, kwargs))
                if not harness.replies:
                    raise AssertionError("no scripted model reply remains")
                reply = harness.replies.pop(0)
                if isinstance(reply, Exception):
                    raise reply
                return types.SimpleNamespace(text=reply)

        self.module = types.ModuleType("praide")
        self.module.PraideError = FakeError
        self.module.files = FakeFiles()
        self.module.patch = FakePatch()
        self.module.tasks = FakeTasks()
        self.module.notes = FakeNotes()
        self.module.run = FakeRun()
        self.module.models = FakeModels()

    def run_workflow(self):
        old_praide = sys.modules.get("praide")
        old_path = list(sys.path)
        try:
            sys.modules["praide"] = self.module
            sys.path.insert(0, str(WORKFLOW))
            for name in ("context", "parse", "prompts", "default_workflow_main"):
                sys.modules.pop(name, None)
            spec = importlib.util.spec_from_file_location(
                "default_workflow_main", WORKFLOW / "main.py"
            )
            module = importlib.util.module_from_spec(spec)
            sys.modules[spec.name] = module
            spec.loader.exec_module(module)
            module.main()
        finally:
            for name in ("context", "parse", "prompts", "default_workflow_main"):
                sys.modules.pop(name, None)
            sys.path[:] = old_path
            if old_praide is None:
                sys.modules.pop("praide", None)
            else:
                sys.modules["praide"] = old_praide


def edit(summary="updated", path="feature.py"):
    return (
        '{"action":"edit","summary":"'
        + summary
        + '","edits":[{"op":"replace","path":"'
        + path
        + '","search":"old","replace":"new"}]}'
    )


def replies_for_one_edit(summary="updated", path="feature.py"):
    return ['{"files":[]}', edit(summary, path)]


class DefaultWorkflowTests(unittest.TestCase):
    def test_no_default_model_fails_before_task_reads(self):
        harness = WorkflowHarness(models_list=[{"id": "unused", "default": False}])
        harness.run_workflow()
        self.assertEqual(harness.finished[0]["outcome"], "failed")
        self.assertEqual(
            harness.finished[0]["reason"],
            "No default model is set. Add a model in Settings, then run again.",
        )
        self.assertNotIn(("tasks.get", "task-1"), harness.calls)

    def test_single_unit_proposes_one_patch(self):
        harness = WorkflowHarness(
            replies_for_one_edit(),
            file_tree={"feature.py": "old"},
        )
        harness.run_workflow()
        self.assertEqual(len(harness.patches), 1)
        self.assertEqual(harness.finished[0]["outcome"], "needs_review")
        self.assertEqual(
            harness.finished[0]["summary"], "1 patches proposed for 0 steps"
        )

    def test_fails_second_pending_step_and_never_starts_third(self):
        pending = [
            {"id": "s1", "title": "first"},
            {"id": "s2", "title": "second"},
            {"id": "s3", "title": "third"},
        ]
        harness = WorkflowHarness(
            [
                '{"files":[]}',
                edit(),
                '{"files":[]}',
                '{"action":"cannot","summary":"blocked","reason":"cannot continue"}',
            ],
            task={
                "id": "task-1",
                "title": "Task",
                "subTasks": [{"id": item["id"]} for item in pending],
            },
            run_context={"taskId": "task-1", "resume": {"pending": pending}},
            file_tree={"feature.py": "old"},
        )
        harness.run_workflow()
        self.assertEqual(
            [event for event in harness.step_events if event[0] == "start"],
            [("start", "s1"), ("start", "s2")],
        )
        self.assertEqual(
            [event for event in harness.step_events if event[0] == "finish"],
            [
                ("finish", "s1", "needs_review", "updated"),
                ("finish", "s2", "failed", None),
            ],
        )
        self.assertEqual(harness.finished[0]["outcome"], "failed")
        self.assertEqual(harness.finished[0]["reason"], "cannot continue")

    def test_resume_context_skips_done_steps(self):
        pending = [{"id": "remaining", "title": "remaining"}]
        harness = WorkflowHarness(
            replies_for_one_edit(),
            task={
                "id": "task-1",
                "title": "Task",
                "subTasks": [{"id": "done"}, {"id": "remaining"}],
            },
            run_context={"taskId": "task-1", "resume": {"pending": pending}},
            file_tree={"feature.py": "old"},
        )
        harness.run_workflow()
        self.assertEqual(
            [event[1] for event in harness.step_events if event[0] == "start"],
            ["remaining"],
        )

    def test_split_proposes_notify_and_finishes_needs_review(self):
        harness = WorkflowHarness(
            [
                '{"files":[]}',
                '{"action":"split","summary":"split it","subtasks":[{"title":"one","description":"first"},{"title":"two","description":"second"}]}',
            ]
        )
        harness.run_workflow()
        self.assertEqual(harness.proposed_subtasks[0][2], "notify")
        self.assertEqual(harness.finished[0]["outcome"], "needs_review")
        self.assertEqual(
            harness.finished[0]["summary"],
            "Proposed 2 subtasks; accept them and run again",
        )
        self.assertEqual(harness.step_events, [])

    def test_split_is_rejected_inside_a_step(self):
        pending = [{"id": "s1", "title": "step"}]
        harness = WorkflowHarness(
            [
                '{"files":[]}',
                '{"action":"split","summary":"split","subtasks":[{"title":"one"},{"title":"two"}]}',
                '{"files":[]}',
                '{"action":"cannot","summary":"no","reason":"no more"}',
            ],
            task={"id": "task-1", "title": "Task", "subTasks": [{"id": "s1"}]},
            run_context={"taskId": "task-1", "resume": {"pending": pending}},
        )
        harness.run_workflow()
        self.assertEqual(harness.proposed_subtasks, [])
        self.assertEqual(harness.finished[0]["outcome"], "failed")

    def test_fenced_and_surrounded_json_are_extracted(self):
        harness = WorkflowHarness(
            [
                '```json\n{"files":[]}\n```',
                'Here is the result: {"action":"edit","summary":"ok","edits":[{"op":"write","path":"out.txt","content":"done"}]} Thanks.',
            ]
        )
        harness.run_workflow()
        self.assertEqual(len(harness.patches), 1)

    def test_invalid_json_is_repaired(self):
        harness = WorkflowHarness(
            ['{"files":[]}', "not json", edit("repaired")],
            file_tree={"feature.py": "old"},
        )
        harness.run_workflow()
        self.assertEqual(len(harness.patches), 1)
        self.assertEqual(len(harness.completions), 3)

    def test_patch_validation_is_repaired_with_error(self):
        harness = WorkflowHarness(
            ['{"files":[]}', edit("first"), edit("repaired")],
            file_tree={"feature.py": "old"},
            patch_errors=[FakeError("Validation", "search matched 2 times")],
        )
        harness.run_workflow()
        self.assertEqual(len(harness.patches), 1)
        self.assertIn("search matched 2 times", harness.completions[2][0][1]["content"])

    def test_previous_run_reason_and_summary_are_in_edit_prompt(self):
        harness = WorkflowHarness(
            replies_for_one_edit(),
            run_context={
                "taskId": "task-1",
                "resume": {"pending": []},
                "previous": {
                    "outcome": "failed",
                    "reason": "model timed out",
                    "summary": "one file remains",
                },
            },
            file_tree={"feature.py": "old"},
        )
        harness.run_workflow()
        prompt = harness.completions[1][0][1]["content"]
        self.assertIn("model timed out", prompt)
        self.assertIn("one file remains", prompt)

    def test_model_errors_have_clear_failure_reasons(self):
        for code, expected in (
            ("ModelUnavailable", "Model unavailable"),
            ("ModelError", "Model error"),
        ):
            with self.subTest(code=code):
                harness = WorkflowHarness(
                    ['{"files":[]}', FakeError(code, "provider is not ready")],
                    file_tree={"feature.py": "old"},
                )
                harness.run_workflow()
                self.assertEqual(harness.finished[0]["outcome"], "failed")
                self.assertIn(expected, harness.finished[0]["reason"])

    def test_context_budget_small_and_missing_limit(self):
        harness = WorkflowHarness()
        old_praide = sys.modules.get("praide")
        sys.modules["praide"] = harness.module
        sys.path.insert(0, str(WORKFLOW))
        try:
            import context as workflow_context

            small = workflow_context.budget_for_context(1000)
            self.assertEqual(small["max_tokens"], 125)
            self.assertEqual(small["file_chars"], int((1000 - 125) * 3 * 0.60))
            missing = workflow_context.budget_for_context(None)
            self.assertEqual(missing["context_limit"], 16000)
            self.assertLessEqual(
                missing["file_chars"],
                int((16000 - missing["max_tokens"]) * 3 * 0.60),
            )
        finally:
            sys.path.remove(str(WORKFLOW))
            sys.modules.pop("context", None)
            if old_praide is None:
                sys.modules.pop("praide", None)
            else:
                sys.modules["praide"] = old_praide

    def test_truncated_file_is_marked_in_prompt(self):
        harness = WorkflowHarness(
            ['{"files":[]}', edit()],
            file_tree={"feature.py": "old" + "x" * 100},
            models_list=[{"id": "test-model", "default": True, "contextLimit": 64}],
        )
        harness.run_workflow()
        edit_prompt = harness.completions[1][0][1]["content"]
        self.assertIn("[TRUNCATED:", edit_prompt)
        self.assertIn("do not use replace edits on unseen text", edit_prompt)

    def test_context_too_large_retries_with_smaller_file_budget(self):
        harness = WorkflowHarness(
            [
                '{"files":["other.py"]}',
                FakeError("ContextTooLarge", "too much"),
                edit("retry"),
            ],
            file_tree={
                "feature.py": "old" + "x" * 5000,
                "other.py": "other" + "y" * 5000,
            },
        )
        harness.run_workflow()
        sizes_by_path = {}
        for path, size in harness.requested_read_sizes:
            sizes_by_path.setdefault(path, []).append(size)
        self.assertEqual(len(harness.completions), 3)
        for sizes in sizes_by_path.values():
            self.assertEqual(len(sizes), 2)
            self.assertLess(sizes[1], sizes[0])
        self.assertEqual(len(harness.patches), 1)

    def test_second_context_too_large_fails_with_clear_reason(self):
        harness = WorkflowHarness(
            [
                '{"files":[]}',
                FakeError("ContextTooLarge", "first request too large"),
                FakeError("ContextTooLarge", "reduced request too large"),
            ],
            file_tree={"feature.py": "old"},
        )
        harness.run_workflow()
        self.assertEqual(harness.finished[0]["outcome"], "failed")
        self.assertIn("Model context is too large", harness.finished[0]["reason"])

    def test_seed_paths_skip_missing_and_never_repeat_rejected_paths(self):
        harness = WorkflowHarness(
            replies_for_one_edit(),
            task={
                "id": "task-1",
                "title": "Read missing.py, rejected.txt and .env.local, then update feature.py",
                "description": "missing.py rejected.txt .env.local feature.py",
                "anchors": [{"path": ".env.local"}],
                "subTasks": [],
                "notes": [
                    {
                        "content": "See missing.py, rejected.txt and feature.py",
                        "anchors": [{"path": ".env.local"}],
                    }
                ],
            },
            file_tree={"feature.py": "old"},
        )
        harness.run_workflow()
        self.assertEqual(harness.requested_paths.count(".env.local"), 0)
        self.assertEqual(harness.requested_paths.count("env.local"), 0)
        self.assertEqual(harness.requested_paths.count("missing.py"), 1)
        self.assertEqual(harness.requested_paths.count("rejected.txt"), 1)
        self.assertEqual(harness.requested_paths.count("feature.py"), 1)

    def test_log_never_prints_unbounded_model_text(self):
        harness = WorkflowHarness(
            replies_for_one_edit("s" * 500),
            file_tree={"feature.py": "old"},
        )
        old_stdout = sys.stdout
        import io

        capture = io.StringIO()
        try:
            sys.stdout = capture
            harness.run_workflow()
        finally:
            sys.stdout = old_stdout
        self.assertTrue(
            all(len(line) <= 200 for line in capture.getvalue().splitlines())
        )


if __name__ == "__main__":
    unittest.main()
