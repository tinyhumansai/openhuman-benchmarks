"""Run one DeepSeek Harness turn through the Python SDK and print the final response.

Env: DSH_HOME DSH_PROFILE (sdk | sdk-minimal) PROMPT_FILE BENCH_MODEL_DSH BENCH_REASONING
The model id sent here is DeepSeek's own name for the model; the metering proxy
rewrites it to the benchmark's pinned OpenRouter slug on the wire.
"""
import os
import sys
from pathlib import Path

from deepseek_harness import DeepSeekHarness

prompt = Path(os.environ["PROMPT_FILE"]).read_text()
kwargs = dict(
    provider="deepseek-official",
    model=os.environ.get("BENCH_MODEL_DSH", "deepseek-v4-flash"),
    cwd=str(Path.cwd().resolve()),
    dsh_home=str(Path(os.environ["DSH_HOME"]).resolve()),
    profile=os.environ.get("DSH_PROFILE", "sdk"),
)
effort = os.environ.get("BENCH_REASONING")
try:
    harness = DeepSeekHarness(reasoning_effort=effort, **kwargs) if effort else DeepSeekHarness(**kwargs)
    with harness as h:
        result = h.run(prompt, session_id="bench-1")
except Exception as error:  # an unsupported effort is rejected at initialisation
    if effort and "effort" in str(error).lower():
        print(f"[dsh_run] effort {effort!r} rejected ({error}); retrying without it", file=sys.stderr)
        with DeepSeekHarness(**kwargs) as h:
            result = h.run(prompt, session_id="bench-1")
    else:
        raise
print(result.final_response)
print(f"[dsh_run] finish_reason={result.finish_reason}", file=sys.stderr)
