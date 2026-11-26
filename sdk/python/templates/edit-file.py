# /// script
# requires-python = ">=3.10"
# dependencies = []
# ///
# This file is the workflow entry point.
# Import helpers with absolute imports (for example, `import prompts`), not `from . import`.
# Never name a file `praide.py`; avoid standard-library module names.
# title: Propose a file edit
# description: Read a project file and propose a reviewed text change.

from praide import edit_replace, files, patch, run

file = files.read("README.md")
if "Praide" in file["text"]:
    patch.propose(
        "Update README marker",
        [edit_replace("README.md", "Praide", "Praide IDE")],
        summary="Proposes a README text replacement",
    )

run.finish("needs_review", summary="Proposed the file edit")
