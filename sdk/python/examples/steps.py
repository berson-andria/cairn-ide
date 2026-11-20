# /// script
# requires-python = ">=3.10"
# dependencies = []
# ///

from cairn import run

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
        reason = str(error)[:500]
        run.finish("failed", reason=reason)
        # Stopping at the first failure makes resume continue from that step.
        break
else:
    run.finish("needs_review", summary="; ".join(summaries))
