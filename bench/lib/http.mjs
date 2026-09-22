/**
 * Rate-limit-aware HTTP client for benchmark runs.
 *
 * Reads the budget from `x-ratelimit-remaining-{minute,hour,day,month}` and
 * `ratelimit-reset` where an endpoint sends them; an endpoint that omits those
 * headers simply falls back to fixed concurrency plus backoff on 429.
 *
 * The point is to stay inside somebody else's quota without hand-tuning sleeps
 * per model, and to make a run that hits a limit slow down rather than fail.
 */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const WINDOWS = ['minute', 'hour', 'day', 'month'];
const WINDOW_MS = { minute: 60000, hour: 3600000, day: 86400000, month: 2592000000 };

export class RateLimitedClient {
  /**
   * @param {object} opts
   * @param {string} opts.baseUrl
   * @param {string} opts.apiKey
   * @param {number} [opts.concurrency]      parallel in-flight requests
   * @param {number} [opts.reserveFraction]  keep this share of each window unspent
   * @param {number} [opts.maxRetries]
   * @param {number} [opts.timeoutMs]
   * @param {number} [opts.recheckMs]       how long to park before re-probing a spent window
   * @param {number} [opts.maxWaitMs]       total time to spend waiting on one window
   * @param {(msg: string) => void} [opts.log]
   */
  constructor({
    baseUrl,
    apiKey,
    concurrency = 4,
    reserveFraction = 0.1,
    maxRetries = 4,
    timeoutMs = 120000,
    recheckMs = 300000,
    maxWaitMs = 7200000,
    log,
  }) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.apiKey = apiKey;
    this.reserveFraction = reserveFraction;
    this.maxRetries = maxRetries;
    this.timeoutMs = timeoutMs;
    // How long to park before asking the server again whether a long window has
    // recovered, and how long to keep doing that before giving up. Two hours is
    // generous, but an hourly window can take most of an hour to come back and
    // giving up just short of that wastes everything already spent.
    this.recheckMs = recheckMs;
    this.maxWaitMs = maxWaitMs;
    this.windowWaited = {};
    this.log = log ?? (() => {});

    this.limits = {};        // window -> { limit, remaining }
    this.resetAfterMs = 0;   // server-advertised seconds until the counter resets
    this.gateUntil = 0;      // epoch ms; no request starts before this
    this.inFlight = 0;
    this.concurrency = concurrency;
    this.waiters = [];
    this.stats = { requests: 0, retries: 0, rateLimitWaits: 0, errors: 0 };
  }

  async #acquire() {
    if (this.inFlight >= this.concurrency) {
      await new Promise((resolve) => this.waiters.push(resolve));
    }
    this.inFlight++;
  }

  #release() {
    this.inFlight--;
    const next = this.waiters.shift();
    if (next) next();
  }

  #readLimits(headers) {
    for (const window of WINDOWS) {
      const limit = Number(headers.get(`x-ratelimit-limit-${window}`));
      const remaining = Number(headers.get(`x-ratelimit-remaining-${window}`));
      // limit 0 means the window is not enforced (some endpoints report
      // 0/0 for unmetered keys), which is not the same as a budget of zero.
      if (Number.isFinite(limit) && Number.isFinite(remaining) && limit > 0) {
        this.limits[window] = { limit, remaining };
      }
    }
    // Seconds until the binding window resets. Which window that is has to be
    // inferred from which one is actually short.
    const reset = Number(headers.get('ratelimit-reset') ?? headers.get('x-ratelimit-reset'));
    this.resetAfterMs = Number.isFinite(reset) && reset > 0 ? reset * 1000 : 0;

    // Park every worker when a window runs low, rather than racing into 429s.
    // The reserve scales with the window: holding 20 requests back is prudent
    // on a 1000/day budget and crippling on a 30/minute one.
    for (const [window, v] of Object.entries(this.limits)) {
      const reserve = Math.max(1, Math.ceil(v.limit * this.reserveFraction));
      if (v.remaining > reserve) {
        this.windowWaited[window] = 0; // recovered
        continue;
      }

      // `ratelimit-reset` counts down the window that is currently binding, not
      // always the shortest one: an endpoint can report 2781s while 29 of 30 requests are
      // left in the minute, because the hour is what actually ran out. So trust
      // it when it is plausible for this window, and otherwise park for a
      // recheck interval and let the next response's headers decide -- sleeping
      // out a whole hour to discover the budget returned after ten minutes
      // wastes the run. The reserve left in the window pays for the probes.
      const advertised = this.resetAfterMs;
      const plausible = advertised > 0 && advertised <= WINDOW_MS[window];
      const waitMs = plausible
        ? Math.min(advertised, this.recheckMs)
        : Math.min(this.recheckMs, WINDOW_MS[window]);

      const now = Date.now();
      this.windowWaited[window] = (this.windowWaited[window] ?? 0) + waitMs;
      if (this.windowWaited[window] > this.maxWaitMs) {
        throw new Error(
          `${window} budget exhausted (${v.remaining}/${v.limit} left) and still not recovered after ` +
            `${Math.round(this.windowWaited[window] / 60000)} minutes of waiting. Resume later or reduce the run.`,
        );
      }
      this.gateUntil = Math.max(this.gateUntil, now + waitMs);
      this.stats.rateLimitWaits++;
      this.log(
        `${window} budget low (${v.remaining}/${v.limit}) - pausing ${Math.round(waitMs / 1000)}s` +
          (advertised ? `, resets in ${Math.round(advertised / 1000)}s` : '') +
          `, then rechecking`,
      );
    }
  }

  /**
   * Learn the current budget. `GET /models` does not carry the rate-limit
   * headers on every endpoint, so fall back to the cheapest
   * possible completion — one request spent to avoid wasting a hundred.
   */
  async readBudget({ model } = {}) {
    await this.listModels().catch(() => {});
    if (Object.keys(this.limits).length || !model) return this.limits;
    await this.post('/chat/completions', {
      model,
      max_tokens: 1,
      temperature: 0,
      messages: [{ role: 'user', content: 'ok' }],
    }).catch(() => {});
    return this.limits;
  }

  /**
   * Refuse a run that cannot fit in the remaining budget, instead of burning
   * half of somebody's quota and failing in the middle. A no-op when the
   * endpoint advertises no limits -- silence is not a promise of capacity, but
   * refusing every run on an unmetered endpoint would be worse.
   *
   * The windows are not equivalent. Exceeding the day or month budget means the
   * run cannot happen today at all, so it is refused. Exceeding only the hour
   * means it merely has to wait, which is a decision for the caller: `wait`
   * lets it ride the window out, and without it the run stops with a message
   * rather than stalling for three quarters of an hour unannounced.
   */
  assertBudget(plannedRequests, { wait = false } = {}) {
    for (const [window, v] of Object.entries(this.limits)) {
      if (window === 'minute') continue; // pacing handles this one
      if (plannedRequests <= v.remaining) continue;

      const recoverable = window === 'hour' && wait;
      if (recoverable) {
        this.log(
          `${window} budget has ${v.remaining} of ${v.limit} left and this run needs ` +
            `${plannedRequests}; waiting for the window instead of refusing`,
        );
        continue;
      }
      throw new Error(
        `run needs ${plannedRequests} requests but only ${v.remaining} left in the ${window} ` +
          `window (limit ${v.limit}). ` +
          (window === 'hour'
            ? 'Pass --wait to ride out the window, or reduce --models/--limit.'
            : 'Reduce --models/--limit, or come back tomorrow.'),
      );
    }
  }

  /** POST a JSON body, retrying on 429/5xx and honouring advertised limits. */
  async post(path, body) {
    return (await this.postTimed(path, body)).body;
  }

  /**
   * As `post`, but also reports how long the successful request itself took.
   * Timing the outer call would measure queue wait, which says more about the
   * benchmark's concurrency than about the model.
   */
  async postTimed(path, body) {
    await this.#acquire();
    try {
      for (let attempt = 0; ; attempt++) {
        const wait = this.gateUntil - Date.now();
        if (wait > 0) await sleep(wait);

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.timeoutMs);
        const sentAt = Date.now();
        let res;
        let text;
        try {
          res = await fetch(`${this.baseUrl}${path}`, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              authorization: `Bearer ${this.apiKey}`,
            },
            body: JSON.stringify(body),
            signal: controller.signal,
          });
          // The body is read under the same timeout: an endpoint can send
          // headers and then stall, which would otherwise hang the run forever.
          text = await res.text();
        } catch (err) {
          this.stats.errors++;
          if (attempt >= this.maxRetries) throw err;
          this.stats.retries++;
          await sleep(1000 * 2 ** attempt);
          continue;
        } finally {
          clearTimeout(timer);
        }

        this.stats.requests++;
        this.#readLimits(res.headers);

        if (res.status === 429 || res.status >= 500) {
          const retryAfter = Number(res.headers.get('retry-after'));
          if (attempt >= this.maxRetries) {
            throw new Error(`${res.status} after ${attempt} retries: ${text.slice(0, 200)}`);
          }
          const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
            ? retryAfter * 1000
            : Math.min(60000, 1000 * 2 ** attempt);
          this.stats.retries++;
          this.gateUntil = Math.max(this.gateUntil, Date.now() + waitMs);
          this.log(`${res.status} - backing off ${Math.round(waitMs / 1000)}s`);
          continue;
        }

        if (!res.ok) {
          throw new Error(`${res.status}: ${text.slice(0, 300)}`);
        }
        return { body: JSON.parse(text), fetchMs: Date.now() - sentAt, attempts: attempt + 1 };
      }
    } finally {
      this.#release();
    }
  }

  async listModels() {
    const res = await fetch(`${this.baseUrl}/models`, {
      headers: { authorization: `Bearer ${this.apiKey}` },
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) throw new Error(`GET /models: ${res.status}`);
    this.#readLimits(res.headers);
    return (await res.json()).data ?? [];
  }

  describeLimits() {
    const parts = Object.entries(this.limits).map(([w, v]) => `${w} ${v.remaining}/${v.limit}`);
    return parts.length ? parts.join(', ') : 'not advertised';
  }
}
