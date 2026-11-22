# /// script
# requires-python = ">=3.10"
# dependencies = []
# ///

from cairn import edit_replace, files, patch, run

file = files.read("README.md")
if "Cairn" in file["text"]:
    patch.propose(
        "Update README marker",
        [edit_replace("README.md", "Cairn", "Cairn IDE")],
        summary="Proposes a README text replacement",
    )

run.finish("needs_review", summary="Proposed the file edit")
