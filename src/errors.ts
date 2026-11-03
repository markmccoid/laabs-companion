/**
 * An error that maps directly onto an HTTP response. `code` is a stable,
 * machine-readable string; `message` is for humans and logs.
 */
export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export const isErrnoException = (error: unknown): error is NodeJS.ErrnoException =>
  error instanceof Error && typeof (error as NodeJS.ErrnoException).code === "string";
