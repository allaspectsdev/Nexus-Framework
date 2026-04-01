# Local Model Integration

## Supported Endpoints

Nexus works with any OpenAI-compatible API endpoint:

| Platform | Default Endpoint | Notes |
|---|---|---|
| [exo](https://github.com/exo-explore/exo) | `http://localhost:52415/v1` | Distributed inference across multiple devices |
| [ollama](https://ollama.ai) | `http://localhost:11434/v1` | Single-machine, easy setup |
| [vLLM](https://github.com/vllm-project/vllm) | `http://localhost:8000/v1` | Production-grade serving |
| [llama.cpp server](https://github.com/ggerganov/llama.cpp) | `http://localhost:8080/v1` | Lightweight C++ inference |
| [LM Studio](https://lmstudio.ai) | `http://localhost:1234/v1` | Desktop app with GUI |

Set `EXO_ENDPOINT` in your `.env` to point to your endpoint.

## Recommended Models

For the tasks Nexus routes locally (summarization, classification, extraction):

| Model | Parameters | Quality | Speed |
|---|---|---|---|
| Llama 3.3 70B | 70B | Best for local routing | Good on exo clusters |
| Qwen 3 235B | 235B | Excellent reasoning | Needs large cluster |
| Llama 3.1 8B | 8B | Adequate for summaries | Very fast, single GPU |
| Mistral Nemo 12B | 12B | Good extraction | Fast, single GPU |

## Exo Cluster Setup

[exo](https://github.com/exo-explore/exo) distributes model inference across multiple consumer devices. A typical setup:

```bash
# On each machine in the cluster:
pip install exo-inference
exo start --model llama-3.3-70b

# exo auto-discovers peers on the local network
# The API is available at http://any-node:52415/v1
```

With 4 machines each having 24GB VRAM, you can run a 70B model at ~30 tok/s — more than sufficient for summarization and classification tasks.

## Graceful Fallback

When the local model is unavailable, Nexus automatically falls back:

1. **Availability check** — On first routing decision, pings `GET /v1/models`
2. **Cached result** — Availability is cached for the session (no repeated pings)
3. **Fallback** — All tasks route to Claude API with a log warning
4. **Summarization fallback** — Context decay uses extractive summarization (first N chars) instead of LLM-generated summaries

No configuration change needed — just start Nexus with or without the local endpoint running.

## What Runs Locally vs. Claude

| Task | Local Model | Claude API |
|---|---|---|
| Tool result summarization | The decay summary tier uses the local model to compress old tool results into one-paragraph summaries | - |
| Incremental compaction | When context gets long, the local model summarizes older messages | - |
| Routing classification | Pattern matching (no LLM needed) | - |
| Code generation | - | Complex reasoning requires Claude |
| Multi-step planning | - | Architectural decisions need Claude |
| Bug diagnosis | - | Root cause analysis needs Claude |
| Security review | - | False negatives are costly |

The local model handles ~40% of all inference calls in a typical session, saving 60-75% of API token costs.
