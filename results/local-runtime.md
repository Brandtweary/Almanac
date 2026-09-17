# Local runtime measurements

These measurements describe one RTX 5090 deployment and bounded test runs. They support the selected model-runtime configuration; they do not establish complete production-corpus quality, repeat-run reliability, or performance on other machines.

## Configuration

The [pinned runtime descriptor](../deploy/muse-glimmer-vllm-candidate.json) identifies `nvidia/Muse-Glimmer-30B-NVFP4` at revision `47818374517751c48c55cde2621594926b1888b6` and vLLM 0.29.0 at source revision `98dff2a81d747d1dba01a47f939f48c3526d4206`. The checkpoint uses mixed W4A16 NVFP4, FP8 and BF16 weights; it is distinct from an all-W4A4 checkpoint.

The measured serving configuration uses native 131,072-token context without RoPE extrapolation, BF16 KV cache, `FLASH_ATTN`, one active sequence, 2,048-token prefill batches, and one decode CUDA graph. Explicit KV allocation is 2.25 GiB; the engine reports capacity for 159,047 tokens. Requests reserve 2,048 output tokens and use temperature 1, top-p 0.95 and top-k 64. PocketTTS Alba runs on CPU, with one TTS admission at a time; Whisper remains warmed on CUDA.

## Observed results

| Check | Result |
|---|---|
| Isolated full-window recall and correction | 128,494 input tokens; exact expected values, correction and total; 50.97 seconds |
| Full-window generation during speech activity | 128,522 input tokens; exact answer and native tokenizer/usage agreement; 54.16 seconds, first generated token at 46.16 seconds |
| Concurrent speech requests | 18 Whisper transcriptions and 10 PocketTTS syntheses completed without errors |
| GPU memory during that overlap | 26,531 MiB peak used; 5,579 MiB minimum free |
| PocketTTS during overlap | First audio 0.270–0.449 seconds; real-time factor 0.565–0.649 |
| Short-prompt hardware throughput | 600 forced greedy output tokens in 11.79 seconds: 50.90 tokens/second, with native count agreement |
| Cancellation and reuse | Cancelled request reached `interrupted`; the subsequent request completed in 2.33 seconds with native count agreement |

The full-window probe is a synthetic recall/correction exercise. Its exact success is evidence for that input, not a general long-document accuracy score. The greedy throughput probe measures hardware execution separately from the published-sampling quality runs; it is not full-window decode throughput or time to first token.

## Bounded model-quality scope

All 15 existing heldout cases passed mechanical checks and receipt-bound agent semantic review: nine source-research cases, two retained-memory roles and four isolated Bash tasks. Two separate development audit/compaction compatibility cases also passed, with no critical semantic failures identified. These runs used a 24,576-token profile; the largest observed prompt was 9,598 tokens. They used the same weights, template, sampling, attention backend and BF16 cache format as the expanded-window runtime.

There was one sampled trajectory per case. The cases exercise controlled source fixtures and application tools, not production-index retrieval quality. Audit and compaction coverage is development coverage, not heldout coverage. Some correct answers used redundant searches, so these results do not establish optimal tool-use efficiency.

## Descriptor and reproduction status

The [local evaluation workflow](../evaluation/local.md) generates candidate profiles and reproduces the unchanged stock scenarios. Profiles remain `qualified:false` because component measurements are not whole-product admission.

The descriptor's `proposed_measurement.memory_gate` retains its pre-measurement “admission pending” wording. That annotation is superseded by the results above: the profile generator fingerprints the entire descriptor, including explanatory text, so changing it would change the reproduced profile identity. The descriptor is preserved byte-for-byte to reproduce the measured profile; its historical annotation is not a statement that these runtime checks remain unperformed.
