// TASK-003 §20.3: голый @ts-expect-error без пояснения в той же строке — ОБЯЗАН давать error
// (@typescript-eslint/ban-ts-comment, allow-with-description).
// @ts-expect-error
export const answer = 42 as unknown as string;
