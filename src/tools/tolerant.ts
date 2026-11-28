import { D2LApiError } from '../client.js';
import { SessionExpiredError } from '../session.js';

export interface Tolerant<T> {
  value?: T;
  /** Why the call gave nothing, in words a student can relay. */
  error?: string;
}

/**
 * Run a call whose failure shouldn't sink a bigger answer: schools turn off different parts
 * of the API for students, so a 403 on rubrics or quizzes is normal. An expired login is
 * still thrown, because nothing else will work either.
 */
export async function tolerant<T>(fn: () => Promise<T>): Promise<Tolerant<T>> {
  try {
    return { value: await fn() };
  } catch (error) {
    if (error instanceof SessionExpiredError) throw error;
    if (error instanceof D2LApiError && (error.status === 403 || error.status === 404)) {
      return { error: error.status === 403 ? 'not available to students at this school' : 'not found' };
    }
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

/** A lookup that was skipped, typed like tolerant()'s result. */
export const skipped = <T>(): Promise<Tolerant<T>> => Promise.resolve({});
