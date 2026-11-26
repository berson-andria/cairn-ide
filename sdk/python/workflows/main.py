# /// script
# requires-python = ">=3.10"
# dependencies = []
# ///
# title: Implement a task with reviewed patches
# description: Explore project files and propose minimal task changes for review.

import context
import parse
import prompts
from praide import PraideError, models, notes, patch, run, tasks


class UnitFailure(Exception):
    pass


def _failure_reason(error):
    code = getattr(error, "code", None)
    message = getattr(error, "message", str(error))
    if code == "ModelUnavailable":
        return f"Model unavailable: {message}"
    if code == "ModelError":
        return f"Model error: {message}"
    if code == "ContextTooLarge":
        return f"Model context is too large: {message}"
    if code:
        return f"{code}: {message}"
    return message


def _log(message):
    for line in str(message).splitlines() or [""]:
        print(line[:200])


def _default_model(model_list):
    if not isinstance(model_list, list):
        return None
    return next(
        (
            model
            for model in model_list
            if isinstance(model, dict)
            and model.get("default") is True
            and isinstance(model.get("id"), str)
        ),
        None,
    )


def _unit_text(task, unit):
    return "\n".join(
        value
        for value in (
            task.get("title"),
            task.get("description"),
            task.get("acceptanceCriteria"),
            unit.get("title"),
            unit.get("description"),
        )
        if isinstance(value, str) and value
    )


def _seed_paths(task, unit, task_notes):
    paths = []
    for anchor in task.get("anchors") or []:
        if isinstance(anchor, dict) and isinstance(anchor.get("path"), str):
            paths.append(anchor["path"])
    note_text = []
    for note in task_notes:
        if not isinstance(note, dict):
            continue
        content = note.get("content")
        if isinstance(content, str):
            note_text.append(content)
        for anchor in note.get("anchors", []):
            if isinstance(anchor, dict) and isinstance(anchor.get("path"), str):
                paths.append(anchor["path"])
    texts = [_unit_text(task, unit), *note_text]
    paths.extend(context.paths_in_text(text) for text in texts)
    flattened = []
    for item in paths:
        if isinstance(item, list):
            flattened.extend(item)
        else:
            flattened.append(item)
    return context.unique_paths(flattened), note_text


def _explore(extra_model, model_id, max_tokens, task, unit, notes_text, seeds, listing):
    repair_error = None
    for attempt in range(3):
        messages = prompts.explore_messages(
            task,
            unit,
            notes_text,
            [record["path"] for record in seeds.values()],
            listing,
            repair_error=repair_error,
        )
        response = extra_model.complete(
            messages, model=model_id, max_tokens=max_tokens, json=True
        )
        try:
            value = parse.first_json_object(response.text)
            if not isinstance(value, dict) or not isinstance(value.get("files"), list):
                raise ValueError("response must be a JSON object with a files list")
            return context.unique_paths(
                path
                for path in value["files"][:6]
                if isinstance(path, str) and context.is_safe_project_path(path)
            )[:6]
        except ValueError as error:
            repair_error = f"Invalid explore response: {error}"
            if attempt == 2:
                raise UnitFailure(repair_error) from error
    raise UnitFailure(repair_error or "Could not read explore response")


def _action(value, has_subtasks):
    if not isinstance(value, dict):
        raise UnitFailure("Model response must be a JSON object")
    action = value.get("action")
    if not isinstance(value.get("summary"), str):
        raise UnitFailure("Model response must include a string summary")
    if action == "cannot":
        if not isinstance(value.get("reason"), str) or not value["reason"]:
            raise UnitFailure("Cannot response must include a reason")
        return value
    if action == "split":
        if has_subtasks:
            raise UnitFailure(
                "A split can only be proposed for a task without subtasks"
            )
        items = value.get("subtasks")
        if not isinstance(items, list) or not 2 <= len(items) <= 8:
            raise UnitFailure("Split response must contain 2 to 8 subtasks")
        if any(
            not isinstance(item, dict)
            or not isinstance(item.get("title"), str)
            or not item["title"]
            or not isinstance(item.get("description", ""), str)
            for item in items
        ):
            raise UnitFailure(
                "Each proposed subtask needs a title and string description"
            )
        return value
    if action != "edit":
        raise UnitFailure(f"Unsupported model action: {action}")
    edits = value.get("edits")
    if not isinstance(edits, list) or not edits:
        raise UnitFailure("Edit response must contain at least one edit")
    for edit in edits:
        if not isinstance(edit, dict) or not isinstance(edit.get("path"), str):
            raise UnitFailure("Each edit must include a project-relative path")
        if not context.is_safe_project_path(edit["path"]):
            raise UnitFailure(f"Edit path is not allowed: {edit['path']}")
        if edit.get("op") == "replace":
            if not all(isinstance(edit.get(key), str) for key in ("search", "replace")):
                raise UnitFailure("Replace edits need string search and replace values")
        elif edit.get("op") == "write":
            if not isinstance(edit.get("content"), str):
                raise UnitFailure("Write edits need string content")
        else:
            raise UnitFailure(f"Unsupported edit operation: {edit.get('op')}")
    return value


def _repair_files(collector, paths, file_budget):
    return collector.read_paths(context.unique_paths(paths), file_budget, refresh=True)[
        "files"
    ]


def _process_unit(
    model, model_id, task, unit, task_notes, has_subtasks, previous, budget
):
    seed_paths, notes_text = _seed_paths(task, unit, task_notes)
    collector = context.FileCollector()
    seed_result = collector.read_paths(seed_paths, budget["file_chars"] // 2)
    listing = context.project_listing()
    extra_paths = _explore(
        model,
        model_id,
        min(256, budget["max_tokens"]),
        task,
        unit,
        notes_text,
        seed_result["files"],
        listing,
    )
    already_read = {context.path_key(path) for path in seed_paths}
    extra_paths = [
        path for path in extra_paths if context.path_key(path) not in already_read
    ]
    extra_budget = max(0, budget["file_chars"] - seed_result["used"])
    extra_result = collector.read_paths(extra_paths, extra_budget)
    all_paths = context.unique_paths([*seed_result["paths"], *extra_result["paths"]])
    file_records = dict(seed_result["files"])
    file_records.update(extra_result["files"])

    repair_error = None
    repair_file_paths = []
    context_retried = False
    action = None
    for repair_number in range(3):
        if repair_error and repair_file_paths:
            prompt_files = _repair_files(
                collector,
                repair_file_paths,
                budget["file_chars"] // (2 if context_retried else 1),
            )
        else:
            prompt_files = file_records
        messages = prompts.edit_messages(
            task,
            unit,
            notes_text,
            prompt_files,
            repair_error=repair_error,
            previous=previous,
            has_subtasks=has_subtasks,
        )
        try:
            response = model.complete(
                messages,
                model=model_id,
                max_tokens=budget["max_tokens"],
                json=True,
            )
        except PraideError as error:
            if error.code == "ContextTooLarge" and not context_retried:
                context_retried = True
                reduced_budget = budget["file_chars"] // 2
                reduced = collector.read_paths(all_paths, reduced_budget, refresh=True)
                file_records = reduced["files"]
                repair_error = None
                repair_file_paths = []
                repair_number -= 1
                continue
            raise

        try:
            parsed = parse.first_json_object(response.text)
            action = _action(parsed, has_subtasks)
        except (ValueError, UnitFailure) as error:
            repair_error = f"Invalid model response: {error}"
            repair_file_paths = list(all_paths)
            if repair_number == 2:
                raise UnitFailure(repair_error) from error
            continue

        if action["action"] == "cannot":
            raise UnitFailure(action["reason"])
        if action["action"] == "split":
            items = [
                {"title": item["title"], "description": item.get("description", "")}
                for item in action["subtasks"]
            ]
            tasks.propose_subtasks(task["id"], items, presentation="notify")
            message = f"Proposed {len(items)} subtasks; accept them and run again"
            return {"split": True, "summary": message}
        try:
            patch.propose(
                unit["title"],
                action["edits"],
                summary=action["summary"][:2000],
            )
            _log(f"Proposed patch: {action['summary'][:180]}")
            return {"split": False, "summary": action["summary"]}
        except PraideError as error:
            if error.code != "Validation":
                raise
            repair_error = f"patch.propose Validation: {error.message}"
            repair_file_paths = [
                edit["path"]
                for edit in action["edits"]
                if isinstance(edit, dict) and isinstance(edit.get("path"), str)
            ]
            if repair_number == 2:
                raise UnitFailure(repair_error) from error

    raise UnitFailure(repair_error or "Could not produce a valid edit")


def main():
    try:
        run_context = run.context()
        previous = run_context.get("previous")
        model_info = _default_model(models.list())
        if model_info is None:
            run.finish(
                "failed",
                reason="No default model is set. Add a model in Settings, then run again.",
            )
            return

        task = tasks.get(run_context["taskId"])
        task_notes = notes.for_task(task["id"])
        subtasks = task.get("subTasks") or []
        has_subtasks = bool(subtasks)
        if has_subtasks:
            units = [
                {
                    "id": item["id"],
                    "title": item.get("title", "Untitled subtask"),
                    "description": item.get("description", ""),
                }
                for item in run_context.get("resume", {}).get("pending", [])
            ]
        else:
            units = [
                {
                    "id": None,
                    "title": task.get("title", "Task"),
                    "description": task.get("description", ""),
                }
            ]

        budget = context.budget_for_context(model_info.get("contextLimit"))
        patch_count = 0
        processed_steps = 0
        for unit in units:
            _log(f"Working on: {unit['title'][:180]}")
            try:
                if unit["id"] is not None:
                    with run.step(unit["id"]) as step:
                        result = _process_unit(
                            models,
                            model_info["id"],
                            task,
                            unit,
                            task_notes,
                            has_subtasks,
                            previous,
                            budget,
                        )
                        if result["split"]:
                            run.finish("needs_review", summary=result["summary"])
                            return
                        step.summary = result["summary"][:2000]
                    processed_steps += 1
                else:
                    result = _process_unit(
                        models,
                        model_info["id"],
                        task,
                        unit,
                        task_notes,
                        has_subtasks,
                        previous,
                        budget,
                    )
                    if result["split"]:
                        run.finish("needs_review", summary=result["summary"])
                        return
                patch_count += 1
            except Exception as error:
                # Stop here so a retry resumes from this failed step.
                if isinstance(error, PraideError):
                    reason = _failure_reason(error)
                elif isinstance(error, UnitFailure):
                    reason = str(error)
                else:
                    reason = type(error).__name__
                run.finish("failed", reason=reason[:500])
                return

        run.finish(
            "needs_review",
            summary=f"{patch_count} patches proposed for {processed_steps} steps",
        )
    except PraideError as error:
        run.finish("failed", reason=_failure_reason(error)[:500])
    except Exception as error:
        run.finish("failed", reason=type(error).__name__)


if __name__ == "__main__":
    main()
