#!/usr/bin/env python3
"""Select a pinned, seeded subset of SWE-bench Verified and write a task suite.

  .cache/swebench-venv/bin/python swebench/prepare.py --n 10 --seed 20261001 \
      --out tasks/generated/swe [--pull]

Writes <out>/tasks.json plus one dir per instance holding prompt.txt, and
instances-<n>.txt next to this file (commit it: it is the fixed task list every
harness sees). Instances are sorted before sampling so the pick depends only on
the seed and the dataset revision, not on dataset row order.
"""
import argparse
import json
import pathlib
import random
import subprocess

from datasets import load_dataset

# The SWE-bench org copy carries the `image` column the 5.x evaluator needs.
DATASET = "SWE-bench/SWE-bench_Verified"
# Pin so "the same 10 tasks" stays true if the dataset is later edited.
REVISION = "78f471bf655a3137b2e8a75af1501690ec009ec3"  # pinned dataset commit

# Identical for every harness. No hints about tests or the harness's own tools.
WRAPPER = """You are working in a git checkout of the repository at {workdir}. Resolve the following issue by editing the source code in place.

Do not modify or add test files unless the issue requires it. Make the smallest correct change. When you are done, stop; your changes are collected from the working tree.

<issue>
{problem_statement}
</issue>
"""


def image_for(instance_id: str) -> str:
    # Official naming: django__django-11099 -> django_1776_django-11099
    return "swebench/sweb.eval.x86_64." + instance_id.replace("__", "_1776_").lower() + ":latest"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--n", type=int, default=10)
    ap.add_argument("--seed", type=int, default=20261001)
    ap.add_argument("--out", default="tasks/generated/swe")
    ap.add_argument("--revision", default=REVISION)
    ap.add_argument("--pull", action="store_true")
    args = ap.parse_args()

    ds = load_dataset(DATASET, split="test", revision=args.revision)
    rows = sorted(ds, key=lambda r: r["instance_id"])
    picked = random.Random(args.seed).sample(rows, args.n)
    picked.sort(key=lambda r: r["instance_id"])

    out = pathlib.Path(args.out).resolve()
    tasks = []
    for row in picked:
        d = out / row["instance_id"]
        d.mkdir(parents=True, exist_ok=True)
        (d / "prompt.txt").write_text(
            WRAPPER.format(workdir="/testbed", problem_statement=row["problem_statement"].strip())
        )
        tasks.append(
            {"id": row["instance_id"], "image": row["image"], "workdir": "/testbed", "dir": str(d)}
        )
    (out / "tasks.json").write_text(json.dumps(tasks, indent=2))

    here = pathlib.Path(__file__).parent
    (here / f"instances-{args.n}.txt").write_text(
        f"# {DATASET} revision={args.revision or 'default'} seed={args.seed}\n"
        + "\n".join(r["instance_id"] for r in picked)
        + "\n"
    )
    print(f"selected {len(picked)} instances -> {out}")
    if args.pull:
        for t in tasks:
            print("pull", t["image"])
            subprocess.run(["docker", "pull", t["image"]], check=True)


if __name__ == "__main__":
    main()
