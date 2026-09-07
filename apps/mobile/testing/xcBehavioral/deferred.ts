/** A promise whose settlement the test controls — the seam every
 * interleaving scenario uses to hold a native/network step mid-flight. */
export interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
  settled: boolean;
}

export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const d: Deferred<T> = {
    promise: new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    }),
    resolve: value => {
      d.settled = true;
      resolve(value);
    },
    reject: error => {
      d.settled = true;
      reject(error);
    },
    settled: false,
  };
  return d;
}
