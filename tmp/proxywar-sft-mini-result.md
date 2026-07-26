# ProxyWar mini-SFT viability probe

Date: 2026-07-17

Status: local diagnostic only. This is not closed-loop gameplay evaluation, RL,
or evidence of cross-environment transfer.

## Setup

- Model: `mlx-community/Qwen2.5-0.5B-Instruct-4bit`
- Trainer: MLX-LM 0.31.3, LoRA on the final 8 layers
- Trainable parameters: 1.466M / 494.033M (0.297%)
- Training: 300 iterations, batch size 2, completion-only loss
- Data: mechanically clean `planner-executor` / `real-llm` decision summaries
- Split: whole run; 87 train runs, 6 validation runs, 11 test runs
- Written examples: 5,000 train, 500 validation, 500 test
- Task: choose an offered action kind from observation summary + legal-menu counts

## Results

- Base model test loss (100 examples): 9.692; perplexity 16,189.014
- Final 300-iteration adapter test loss (100 examples): 0.391; perplexity 1.478
- Best validation checkpoint: iteration 100
- Iteration-100 test loss (100 examples): 0.411; perplexity 1.508
- Base generation on 200 examples: 0% exact, 0% legal
- Iteration-100 generation on all 500 test examples:
  - 55.2% exact action-kind accuracy
  - 99.8% legal output rate
- Baselines on those same 500 examples:
  - 51.0% unconstrained majority (`attack`)
  - 56.4% globally frequent label constrained to offered kinds
  - 59.0% exact-menu-signature lookup

## Verdict

The current summaries contain enough signal to teach a small model the output
contract and offered-label vocabulary. They do not yet demonstrate strategic
policy learning: the best SFT checkpoint did not beat a trivial legal-menu
baseline on held-out runs.

This result does not reject the full ProxyWar post-training hypothesis. The
probe omitted full `AgentObservation`, full `LegalAction[]` metadata, next
state, outcome/reward conditioning, policy provenance, primary-action
deduplication, and closed-loop play. Those missing pieces are exactly what a
transition exporter and interactive gym must supply.
