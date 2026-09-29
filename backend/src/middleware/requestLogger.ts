import { Request, Response, NextFunction } from "express";

/**
 * Simple UUID generator without external dependency.
 * Uses crypto.randomUUID() which is available in Node.js 14.17+.
 */
function generateRequestId(): string {
  // Use crypto.randomUUID if available, otherwise fallback
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  // Fallback for older environments
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/**
 * Sanitize sensitive data from request/response for logging.
 */
function sanitizeForLogging(obj: any): any {
  if (!obj || typeof obj !== "object") return obj;

  const sensitiveKeys = [
    "authorization",
    "cookie",
    "x-api-key",
    "api_key",
    "password",
    "secret",
    "token",
    "session",
    "credit",
    "card",
    "cvv",
    "ssn",
  ];

  if (Array.isArray(obj)) {
    return obj.map(sanitizeForLogging);
  }

  const sanitized: any = {};
  for (const [key, value] of Object.entries(obj)) {
    const lowerKey = key.toLowerCase();
    let isSensitive = false;
    for (const k of sensitiveKeys) {
      if (lowerKey.includes(k)) {
        isSensitive = true;
        break;
      }
    }
    if (isSensitive) {
      sanitized[key] = "[REDACTED]";
    } else if (value && typeof value === "object") {
      sanitized[key] = sanitizeForLogging(value);
    } else {
      sanitized[key] = value;
    }
  }
  return sanitized;
}

/**
 * Request logging middleware.
 * Logs structured request/response information without sensitive data.
 */
export function requestLogger(req: Request, res: Response, next: NextFunction): void {
  const startTime = process.hrtime.bigint();
  const requestId = generateRequestId();

  // Attach request ID to request for downstream use
  (req as any).requestId = requestId;
  res.setHeader("X-Request-ID", requestId);

  // Capture response data
  const originalJson = res.json.bind(res);
  let responseBody: any = null;
  res.json = (body: any) => {
    responseBody = body;
    return originalJson(body);
  };

  // Log on response finish
  res.on("finish", () => {
    const endTime = process.hrtime.bigint();
    const durationMs = Number(endTime - startTime) / 1_000_000;

    // Skip logging for health checks in non-debug mode
    if (req.path === "/api/health" && process.env.LOG_HEALTH_CHECKS !== "true") {
      return;
    }

    const logEntry = {
      timestamp: new Date().toISOString(),
      requestId,
      method: req.method,
      path: req.path,
      statusCode: res.statusCode,
      durationMs: Math.round(durationMs * 100) / 100,
      ip: req.ip,
      userAgent: req.get("user-agent"),
      // Only include query params if not sensitive
      query: sanitizeForLogging(req.query),
      // Don't log full request body - could be large or sensitive
      hasBody: !!req.body && Object.keys(req.body).length > 0,
      // Response info
      responseSize: res.get("content-length") || JSON.stringify(responseBody || {}).length,
      // Error info if applicable
      error: res.statusCode >= 400 ? sanitizeForLogging(responseBody) : undefined,
    };

    // Use console.log for structured JSON logging
    // In production, this could be sent to a log aggregation service
    console.log(JSON.stringify(logEntry));
  });

  next();
}

/**
 * Error logging helper - logs errors with request context.
 */
export function logError(req: Request, error: Error, context?: string): void {
  const requestId = (req as any).requestId || "unknown";
  console.error(
    JSON.stringify({
      timestamp: new Date().toISOString(),
      requestId,
      level: "error",
      message: error.message,
      stack: error.stack,
      context,
      method: req.method,
      path: req.path,
      ip: req.ip,
    })
  );
}