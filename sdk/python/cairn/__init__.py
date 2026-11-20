import json
import sys

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
        anchor=None,
        linked_note_ids=None,
        sub_tasks=None,
        depends_on=None,
        acceptance_criteria=None,
    ):
        params = {"title": title}
        optional = {
            "description": description,
            "anchor": anchor,
            "linkedNoteIds": linked_note_ids,
            "subTasks": sub_tasks,
            "dependsOn": depends_on,
            "acceptanceCriteria": acceptance_criteria,
        }
        params.update({key: value for key, value in optional.items() if value is not None})
        return call("tasks.propose", params)["proposalId"]


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


class _Run:
    @staticmethod
    def context():
        return call("run.context")

    @staticmethod
    def finish(outcome, summary=None, reason=None):
        params = {"outcome": outcome}
        if summary is not None:
            params["summary"] = summary
        if reason is not None:
            params["reason"] = reason
        return call("run.finish", params)


tasks = _Tasks()
proposals = _Proposals()
notes = _Notes()
run = _Run()
