# /// script
# requires-python = ">=3.10"
# dependencies = []
# ///

import sys

from cairn import notes, run, tasks

context = run.context()
task = tasks.get(context["taskId"])
task_notes = notes.for_task(task["id"])
summary = f"Read task '{task['title']}' and {len(task_notes)} linked note(s)."
print(summary, file=sys.stderr)
run.finish("needs_review", summary=summary)
