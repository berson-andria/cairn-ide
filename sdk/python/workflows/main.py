# /// script
# requires-python = ">=3.10"
# dependencies = []
# ///
# This file is the workflow entry point.
# Import helpers with absolute imports (for example, `import prompts`), not `from . import`.
# Never name a file `cairn.py`; avoid standard-library module names.
# title: Read task and notes
# description: Read the current task and linked notes, then finish the run.

import sys

from cairn import notes, run, tasks

context = run.context()
task = tasks.get(context["taskId"])
task_notes = notes.for_task(task["id"])
summary = f"Read task '{task['title']}' and {len(task_notes)} linked note(s)."
print(summary, file=sys.stderr)
run.finish("needs_review", summary=summary)
