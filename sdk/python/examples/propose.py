# /// script
# requires-python = ">=3.10"
# dependencies = []
# ///

from praide import run, tasks

context = run.context()
task = tasks.get(context["taskId"])
proposal_id = tasks.propose(
    title=f"Follow up: {task['title']}",
    description=f"Continue work related to {task['title']}.",
)
print(f"Proposed follow-up task {proposal_id}")
