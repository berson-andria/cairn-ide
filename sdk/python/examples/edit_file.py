# /// script
# requires-python = ">=3.10"
# dependencies = []
# ///

from praide import edit_replace, files, patch, run

file = files.read("README.md")
if "Praide" in file["text"]:
    patch.propose(
        "Update README marker",
        [edit_replace("README.md", "Praide", "Praide IDE")],
        summary="Proposes a README text replacement",
    )

run.finish("needs_review", summary="Proposed the file edit")
