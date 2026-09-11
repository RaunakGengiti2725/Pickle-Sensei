/** The lifetime free-rating allowance the suites model and assert — the
 * database's public.free_rating_limit() (migration 20260910170000: ONE) and
 * the handler's FREE_RATING_LIMIT. Scenarios derive their arithmetic from it
 * so the number lives in exactly one place per layer. */
export const FREE_RATING_LIMIT = 1;
