/**
 * Chrome Trace Event Format.
 *
 * The format is intentionally open-ended — events carry many optional fields
 * and tool-specific extras — so we type the fields we rely on and leave the
 * rest open via an index signature.
 *
 * Reference: https://docs.google.com/document/d/1CvAClvFfyA5R-PhYUmn5OOQtYMH4h6I0nSsKchNAySU
 */
export interface TraceEvent {
  /** Event name, e.g. "RunTask", "FunctionCall". */
  name?: string;
  /** Comma-joined category list, e.g. "devtools.timeline" or "cc,benchmark". */
  cat?: string;
  /** Phase. X=complete, B/E=begin/end, I=instant, b/e/n=async, s/f/t=flow, M=metadata, P=sample. */
  ph: string;
  /** Timestamp in microseconds. */
  ts: number;
  /** Duration in microseconds (complete "X" events). */
  dur?: number;
  /** Thread-scoped duration in microseconds. */
  tdur?: number;
  /** Process id. */
  pid?: number;
  /** Thread id. */
  tid?: number;
  /** Event-specific payload. */
  args?: Record<string, unknown>;
  /** Async/flow correlation id. */
  id?: string;
  /** Scoped id form. */
  id2?: { local?: string; global?: string };
  /** Instant-event scope (g=global, p=process, t=thread). */
  s?: string;
  [key: string]: unknown;
}

/** Top-level DevTools trace metadata (the object alongside `traceEvents`). */
export interface TraceMetadata {
  source?: string;
  startTime?: string;
  hostDPR?: number;
  [key: string]: unknown;
}
