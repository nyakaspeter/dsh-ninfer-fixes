import { IMAGE_OFFLOAD_REQUIRED_CODE, LlmError } from '@deepseek-ai/dsh-llm';

export const name = 'ninfer-fixes';
export const inject = ['agents', 'sessions'];

// pi-ai preserves HTTP status + JSON body in its display string, but not in
// LlmFailure.status. Accept only the complete, exact NInfer signature.
export function isVisionBudgetFailure(failure) {
  if (failure?.code !== 'INVALID_REQUEST' || typeof failure.message !== 'string') return false;
  const match = /^(?:HTTP )?400(?:\s*:\s*|\s+)(\{[\s\S]*\})\s*$/.exec(failure.message);
  if (!match || (failure.status !== undefined && failure.status !== 400)) return false;
  try {
    const body = JSON.parse(match[1]);
    const error = body.error ?? body;
    return error.code === 'media_budget_exceeded'
      && error.message === 'vision raw patches exceed processor budget'
      && error.param === 'messages' && error.type === 'invalid_request_error';
  } catch { return false; }
}

// Read the official executor's eligible occurrences in the same surface order.
// Never select images here; selection and durable projection belong to DSH.
function retained(session) {
  const keys = [];
  for (const seq of session.surface.nodes) {
    const event = session.eventAt(seq);
    if (event.type !== 'user/message' && event.type !== 'tool/result') continue;
    let index = 0;
    for (const block of session.deriveEventMessage(event).content) {
      if (block.type !== 'image') continue;
      if (block.offloaded !== true) keys.push(`${seq}:${index}`);
      index++;
    }
  }
  return keys;
}

export function apply(ctx, config = {}) {
  const { providers, maxRetries = 32 } = config;
  if (providers !== undefined && (!Array.isArray(providers) || providers.length === 0
      || providers.some(p => typeof p !== 'string' || !p.length))) {
    throw new Error('ninfer-fixes: providers, when supplied, must list existing NInfer provider IDs');
  }
  if (!Number.isSafeInteger(maxRetries) || maxRetries < 1 || maxRetries > 1024) {
    throw new Error('ninfer-fixes: maxRetries must be an integer from 1 to 1024');
  }
  const routes = providers === undefined ? undefined : new Set(providers);
  const attempts = new WeakMap();
  ctx.on('agent/request-error', async (payload, next) => {
    const { agent, turn, step, provider, failure, signal } = payload;
    if ((routes !== undefined && !routes.has(provider)) || !isVisionBudgetFailure(failure) || signal.aborted) return next();
    const stop = detail => {
      throw new LlmError(`NInfer vision-budget recovery stopped: ${detail}`, 'NINFER_IMAGE_RECOVERY_STOPPED');
    };
    const before = retained(agent.session);
    if (before.length <= 1) stop('no older eligible image remains; the newest image is preserved. Reduce its resolution or start a new conversation.');
    const prior = attempts.get(agent);
    const state = prior?.turn === turn && prior.step === step && prior.provider === provider
      ? prior : { turn, step, provider, count: 0 };
    if (state.count >= maxRetries) stop(`retry bound (${maxRetries}) reached.`);
    state.count++;
    attempts.set(agent, state);
    // Waterfall shares its payload with downstream listeners. Replace the
    // immutable failure snapshot, never mutate the frozen snapshot itself.
    payload.failure = new LlmError(failure.message, IMAGE_OFFLOAD_REQUIRED_CODE,
      { status: 400, offloadImages: 1 }).failure;
    const action = await next();
    signal.throwIfAborted();
    const after = retained(agent.session);
    if (action?.kind !== 'retry' || after.length !== before.length - 1
        || after.some((key, i) => key !== before[i + 1])) {
      stop('official image-offload did not omit exactly the oldest image and request retry. Enable @deepseek-ai/dsh-compaction-image-offload in this scope.');
    }
    return action;
  }, { prepend: true });
}
