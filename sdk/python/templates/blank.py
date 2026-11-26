# /// script
# requires-python = ">=3.10"
# dependencies = []
# ///
# This file is the workflow entry point.
# Import helpers with absolute imports (for example, `import prompts`), not `from . import`.
# Never name a file `praide.py`; avoid standard-library module names.
# title: Blank workflow
# description: Read the current task context and finish with a review summary.

from praide import run, tasks

context = run.context()
task = tasks.get(context["taskId"])
run.finish("needs_review", summary=f"Read task '{task['title']}'.")
