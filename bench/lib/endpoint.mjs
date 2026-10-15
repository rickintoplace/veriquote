/**
 * Most runs in `results/` used GWDG's SAIA API, a vLLM deployment, and name
 * their models the way it does. OpenRouter serves the same open-weight models
 * under vendor-prefixed ids and switches reasoning off with its own parameter
 * instead of vLLM's chat-template flag. These helpers translate both, so a
 * run can be repeated on either endpoint and the result files keep the same
 * model names. On any other endpoint nothing is changed.
 */

const OPENROUTER_IDS = {
  'deepseek-v4-flash-0731': 'deepseek/deepseek-v4-flash-0731',
  'glm-5.3-flash': 'z-ai/glm-5.3-flash',
  'openai-gpt-oss-120b': 'openai/gpt-oss-120b',
  'qwen3.5-397b-a17b': 'qwen/qwen3.5-397b-a17b',
  'qwen3.6-35b-a3b': 'qwen/qwen3.6-35b-a3b',
  'gemma-4-31b-it': 'google/gemma-4-31b-it',
  'meta-llama-3.1-8b-instruct': 'meta-llama/llama-3.1-8b-instruct',
  // mistral-medium-3.5-128b is not on OpenRouter.
};

export const isOpenRouter = (baseUrl) => baseUrl.includes('openrouter.ai');

/** Host of the endpoint, recorded in result files. */
export const endpointHost = (baseUrl) => new URL(baseUrl).host;

/** The id to send for `model` on this endpoint. */
export const endpointModel = (model, baseUrl) => (isOpenRouter(baseUrl) && OPENROUTER_IDS[model]) || model;

/** Request fields that switch a hybrid model's reasoning off. */
export const noThinking = (baseUrl) =>
  isOpenRouter(baseUrl) ? { reasoning: { enabled: false } } : { chat_template_kwargs: { enable_thinking: false } };

/**
 * Extra fields for the logprobs judge. On OpenRouter, vLLM's switches are
 * ignored, so reasoning is switched off its own way, and only providers that
 * return logprobs are used. Elsewhere none, which keeps the request, and with
 * it the cache key of every stored answer, unchanged.
 */
export const logprobsExtraBody = (baseUrl) =>
  isOpenRouter(baseUrl) ? { ...noThinking(baseUrl), provider: { require_parameters: true } } : undefined;
