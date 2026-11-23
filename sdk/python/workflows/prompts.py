import json


def _json_text(value):
    return json.dumps(value, ensure_ascii=True, indent=2)


def _previous_text(previous):
    if not isinstance(previous, dict):
        return ""
    fields = [
        f"Previous run outcome: {previous.get('outcome', 'unknown')}",
        f"Previous run reason: {previous.get('reason') or '(none)'}",
        f"Previous run summary: {previous.get('summary') or '(none)'}",
    ]
    return "\n".join(fields)


def _task_text(task, unit, notes):
    return (
        "Task and unit:\n"
        + _json_text(
            {
                "task": {
                    "title": task.get("title"),
                    "description": task.get("description"),
                    "acceptanceCriteria": task.get("acceptanceCriteria"),
                },
                "unit": unit,
                "notes": notes,
            }
        )
    )


def explore_messages(task, unit, notes, seed_names, listing, repair_error=None):
    system = (
        "Select at most 6 additional existing project-relative files that are "
        "necessary for this unit. Do not select secrets, generated files, or "
        "paths outside the project. Return exactly one JSON object: "
        '{"files":["path", ...]}.'
    )
    user = (
        _task_text(task, unit, notes)
        + "\nSeed files already selected:\n"
        + _json_text(seed_names)
        + "\nProject root and one-level listing (at most 200 entries):\n"
        + listing
        + "\nReturn only the JSON files object."
    )
    if repair_error:
        user += "\nRepair the previous response. Error: " + repair_error
    return [{"role": "system", "content": system}, {"role": "user", "content": user}]


def edit_messages(
    task,
    unit,
    notes,
    file_records,
    repair_error=None,
    previous=None,
    has_subtasks=False,
):
    actions = (
        'Use {"action":"edit","summary":str,"edits":[{"op":"replace","path":str,'
        '"search":str,"replace":str} | {"op":"write","path":str,"content":str}]} '
        'or {"action":"cannot","summary":str,"reason":str}.'
    )
    if not has_subtasks:
        actions += (
            ' For a task without subtasks only, you may instead return '
            '{"action":"split","summary":str,"subtasks":[{"title":str,'
            '"description":str}, ...]} with 2 to 8 subtasks.'
        )
    system = (
        "Make the smallest useful implementation change. Use paths relative to "
        "the project. Never touch secrets or generated files. For replace, "
        "search must match exactly once in the complete file text shown. Never "
        "use replace edits on truncated files or text you have not seen. "
        "Keep edits relevant to the task. Return exactly one JSON object. "
        + actions
    )
    file_texts = []
    for path, record in file_records.items():
        truncation = ""
        if record.get("truncated"):
            truncation = (
                f"\n[TRUNCATED: file is {record.get('bytes', 0)} bytes; only the "
                "returned prefix is shown; do not use replace edits on unseen text]"
            )
        file_texts.append(
            f"--- FILE {path} ---\n{record['text']}{truncation}"
        )
    user_parts = [_task_text(task, unit, notes)]
    previous_text = _previous_text(previous)
    if previous_text:
        user_parts.append(previous_text)
    user_parts.append("Files read:\n" + ("\n\n".join(file_texts) or "(none)"))
    if repair_error:
        user_parts.append(
            "Repair the previous response. Error: "
            + repair_error
            + "\nUse the current file contents above; do not repeat the error."
        )
    return [
        {"role": "system", "content": system},
        {"role": "user", "content": "\n\n".join(user_parts)},
    ]
