import argparse
import gc
import json
import re
from collections import Counter
from pathlib import Path

import mlx.core as mx
from mlx_lm import generate, load


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", required=True)
    parser.add_argument("--data", required=True)
    parser.add_argument("--adapter", default=None)
    parser.add_argument("--limit", type=int, default=200)
    return parser.parse_args()


def normalize(output: str) -> str:
    match = re.search(r"[a-z][a-z0-9_]*", output.lower())
    return match.group(0) if match else ""


def offered_labels(prompt: str):
    offered_line = next(
        (line for line in prompt.splitlines() if line.startswith("Offered: ")),
        "",
    )
    return {
        match.group(1)
        for match in re.finditer(r"([a-z][a-z0-9_]*)\(\d+\)", offered_line)
    }


def main():
    args = parse_args()
    rows = []
    with Path(args.data).open() as handle:
        for line in handle:
            if not line.strip():
                continue
            rows.append(json.loads(line))
            if len(rows) >= args.limit:
                break

    model, tokenizer = load(args.model, adapter_path=args.adapter)
    exact = 0
    legal = 0
    predictions = Counter()
    truth = Counter()
    for index, row in enumerate(rows, start=1):
        messages = row["messages"]
        expected = messages[-1]["content"].strip()
        prompt = tokenizer.apply_chat_template(
            messages[:-1], tokenize=False, add_generation_prompt=True
        )
        output = generate(
            model,
            tokenizer,
            prompt=prompt,
            max_tokens=8,
            verbose=False,
        )
        predicted = normalize(output)
        allowed = offered_labels(messages[0]["content"])
        exact += int(predicted == expected)
        legal += int(predicted in allowed)
        predictions[predicted or "<empty>"] += 1
        truth[expected] += 1
        if index % 50 == 0:
            mx.clear_cache()

    print(
        json.dumps(
            {
                "model": args.model,
                "adapter": args.adapter,
                "examples": len(rows),
                "exactAccuracy": exact / len(rows),
                "legalOutputRate": legal / len(rows),
                "truth": truth,
                "predictions": predictions,
            },
            indent=2,
        )
    )
    del model
    gc.collect()
    mx.clear_cache()


if __name__ == "__main__":
    main()
