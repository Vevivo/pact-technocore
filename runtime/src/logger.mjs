export function createLogger(level = "info") {
  const weights = { debug: 10, info: 20, warn: 30, error: 40 };
  const threshold = weights[level] || weights.info;
  return (severity, message, fields = {}) => {
    if ((weights[severity] || 20) < threshold) return;
    const safeFields = Object.fromEntries(Object.entries(fields)
      .filter(([key]) => !/key|token|secret|signature|authorization/i.test(key))
      .map(([key, value]) => [key, typeof value === "string"
        ? value
          .replace(/\b(?:sk|ghp|gho|github_pat)_[A-Za-z0-9_-]{12,}\b/g, "[REDACTED]")
          .replace(/([?&](?:key|token|secret)=)[^&\s]+/gi, "$1[REDACTED]")
          .replace(/\bBearer\s+[A-Za-z0-9._~-]+/gi, "Bearer [REDACTED]")
        : value]));
    process.stdout.write(`${JSON.stringify({ ts: new Date().toISOString(), level: severity, message, ...safeFields })}\n`);
  };
}
