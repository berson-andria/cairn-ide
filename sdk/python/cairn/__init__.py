import json
import sys
from dataclasses import dataclass

API_VERSION = 1

_rpc_stdout = sys.stdout
_rpc_stdin = sys.stdin
sys.stdout = sys.stderr

_request_id = 0
_hello_complete = False


class CairnError(Exception):
    def __init__(self, code, message):
        self.code = code
        self.message = message
        super().__init__(f"{code}: {message}")


def _send(method, params):
    global _request_id
    _request_id += 1
    request_id = _request_id
    request = {
        "jsonrpc": "2.0",
        "id": request_id,
        "method": method,
        "params": params,
    }
    _rpc_stdout.write(json.dumps(request, separators=(",", ":")) + "\n")
    _rpc_stdout.flush()

    line = _rpc_stdin.readline()
    if not line:
        sys.exit(1)
    try:
        response = json.loads(line)
    except json.JSONDecodeError as error:
        raise CairnError("ProtocolError", "The host returned invalid JSON") from error
    if response.get("id") != request_id:
        raise CairnError("ProtocolError", "The host returned a mismatched request id")
    if "error" in response:
        error = response["error"]
        details = error.get("data") or {}
        raise CairnError(details.get("code", error.get("code")), details.get("message", error.get("message", "RPC error")))
    if "result" not in response:
        raise CairnError("ProtocolError", "The host returned no result")
    return response["result"]


def call(method, params=None):
    global _hello_complete
    if method != "hello" and not _hello_complete:
        _send("hello", {"apiVersion": API_VERSION})
        _hello_complete = True
    result = _send(method, {} if params is None else params)
    if method == "hello":
        _hello_complete = True
    return result


@dataclass(frozen=True)
class ModelResponse:
    text: str
    finish_reason: str | None
    usage: dict
    model: str
    ms: int


class _Tasks:
    @staticmethod
    def get(task_id):
        return call("tasks.get", {"id": task_id})

    @staticmethod
    def list():
        return call("tasks.list")

    @staticmethod
    def propose(
        title,
        description=None,
        anchors=None,
        linked_note_ids=None,
        sub_tasks=None,
        depends_on=None,
        acceptance_criteria=None,
        presentation="notify",
    ):
        params = {"title": title}
        optional = {
            "description": description,
            "anchors": anchors,
            "linkedNoteIds": linked_note_ids,
            "subTasks": sub_tasks,
            "dependsOn": depends_on,
            "acceptanceCriteria": acceptance_criteria,
            "presentation": presentation,
        }
        params.update({key: value for key, value in optional.items() if value is not None})
        return call("tasks.propose", params)["proposalId"]

    @staticmethod
    def propose_batch(items, source_task_id=None, presentation="notify"):
        params = {"items": items, "presentation": presentation}
        if source_task_id is not None:
            params["sourceTaskId"] = source_task_id
        return call("tasks.propose_batch", params)["proposalId"]

    @staticmethod
    def propose_subtasks(task_id, items, presentation="notify"):
        return call(
            "tasks.propose_subtasks",
            {"taskId": task_id, "items": items, "presentation": presentation},
        )["proposalId"]


class _Proposals:
    @staticmethod
    def list():
        return call("proposals.list")


class _Notes:
    @staticmethod
    def get(note_id):
        return call("notes.get", {"id": note_id})

    @staticmethod
    def for_task(task_id):
        return call("notes.for_task", {"taskId": task_id})


class _Files:
    @staticmethod
    def read(path, max_bytes=None):
        params = {"path": path}
        if max_bytes is not None:
            params["maxBytes"] = max_bytes
        return call("files.read", params)

    @staticmethod
    def list(path=""):
        return call("files.list", {"path": path})


class _Patch:
    @staticmethod
    def propose(title, edits, summary=None):
        params = {"title": title, "edits": edits}
        if summary is not None:
            params["summary"] = summary
        return call("patch.propose", params)


class _Run:
    @staticmethod
    def context():
        return call("run.context")

    @staticmethod
    def pending_steps():
        return _Run.context()["resume"]["pending"]

    @staticmethod
    def step_start(subtask_id):
        return call("step.start", {"subtaskId": subtask_id})

    @staticmethod
    def step_finish(subtask_id, outcome, summary=None, reason=None):
        params = {"subtaskId": subtask_id, "outcome": outcome}
        if summary is not None:
            params["summary"] = summary
        if reason is not None:
            params["reason"] = reason
        return call("step.finish", params)

    @staticmethod
    def step(subtask_id):
        return _Step(subtask_id)

    @staticmethod
    def finish(outcome, summary=None, reason=None):
        params = {"outcome": outcome}
        if summary is not None:
            params["summary"] = summary
        if reason is not None:
            params["reason"] = reason
        return call("run.finish", params)


class _Models:
    @staticmethod
    def list():
        return call("models.list")

    @staticmethod
    def complete(
        messages,
        model=None,
        max_tokens=None,
        temperature=None,
        stop=None,
        json=False,
    ):
        params = {"messages": messages}
        optional = {
            "model": model,
            "maxTokens": max_tokens,
            "temperature": temperature,
            "stop": stop,
        }
        params.update({key: value for key, value in optional.items() if value is not None})
        if json:
            params["json"] = True
        result = call("models.complete", params)
        usage = result.get("usage") or {}
        return ModelResponse(
            text=result["text"],
            finish_reason=result.get("finishReason"),
            usage=usage,
            model=result["model"],
            ms=result["ms"],
        )


class _Step:
    def __init__(self, subtask_id):
        self.subtask_id = subtask_id
        self.summary = None

    def __enter__(self):
        run.step_start(self.subtask_id)
        return self

    def __exit__(self, exception_type, exception, traceback):
        if exception is None:
            run.step_finish(self.subtask_id, "needs_review", summary=self.summary)
        else:
            run.step_finish(
                self.subtask_id,
                "failed",
                reason=str(exception)[:500],
            )
        return False


def edit_replace(path, search, replace):
    return {"op": "replace", "path": path, "search": search, "replace": replace}


def edit_write(path, content):
    return {"op": "write", "path": path, "content": content}


tasks = _Tasks()
proposals = _Proposals()
notes = _Notes()
files = _Files()
patch = _Patch()
run = _Run()
models = _Models()
