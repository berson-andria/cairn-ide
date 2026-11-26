# /// script
# requires-python = ">=3.10"
# dependencies = []
# ///
# This file is the workflow entry point.
# Import helpers with absolute imports (for example, `import prompts`), not `from . import`.
# Never name a file `praide.py`; avoid standard-library module names.
# title: Resumable steps
# description: Process task subtasks as resumable workflow steps.

from praide import run

summaries = []
for pending_step in run.pending_steps():
    try:
        with run.step(pending_step["id"]) as step:
            title = pending_step["title"]
            if title.startswith("FAIL: "):
                raise RuntimeError(f"Step failed: {title}")
            step.summary = f"Finished {title}"
            summaries.append(step.summary)
    except Exception as error:
        run.finish("failed", reason=str(error)[:500])
        break
else:
    run.finish("needs_review", summary="; ".join(summaries))
