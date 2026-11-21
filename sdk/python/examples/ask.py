# /// script
# requires-python = ">=3.10"
# dependencies = []
# ///

from cairn import models, run

response = models.complete(
    [{"role": "user", "content": "Say hello in one short sentence."}]
)
print(response.text)
run.finish("needs_review", summary=f"Asked {response.model} for a greeting.")
