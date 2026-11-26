# ///
# requires-python = ">=3.10"
# dependencies = []
# ///

from praide import run, tasks

context = run.context()
current = tasks.get(context["taskId"])
proposal_id = tasks.propose_batch(
    source_task_id=current["id"],
    presentation="notify",
    items=[
        {"key": "first", "title": "First step"},
        {
            "key": "second",
            "title": "Second step",
            "dependsOnKey": "first",
        },
        {
            "key": "third",
            "title": "Third step",
            "dependsOnKey": "second",
        },
    ],
)
print(f"Proposed a three-task split for {current['title']}: {proposal_id}")
