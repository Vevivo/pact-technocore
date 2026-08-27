function parseRow(row) {
  try { return { row, event: JSON.parse(row.payload_json) }; }
  catch { return null; }
}

export function buildTaskViews(rows, now = Date.now()) {
  const views = new Map();
  for (const parsed of rows.map(parseRow).filter(Boolean)) {
    const { row, event } = parsed;
    if (event.kind === "task") {
      if (!views.has(event.id)) {
        views.set(event.id, {
          task: event,
          author: row.author_did,
          seq: row.seq,
          ts: row.ts,
          claims: [],
          submissions: [],
          decisions: [],
        });
      }
      continue;
    }
    const view = views.get(event.taskId);
    if (!view) continue;
    const item = { ...event, author: row.author_did, seq: row.seq, ts: row.ts };
    if (event.kind === "claim") view.claims.push(item);
    if (event.kind === "submission") view.submissions.push(item);
    if (event.kind === "decision") view.decisions.push(item);
  }

  for (const view of views.values()) {
    view.claims.sort((a, b) => a.seq - b.seq);
    view.submissions.sort((a, b) => a.seq - b.seq);
    view.decisions.sort((a, b) => a.seq - b.seq);
    view.submissions = view.submissions.map((submission) => {
      const submittedAt = Date.parse(submission.ts);
      const winningClaim = view.claims.find((claim) => {
        const claimedAt = Date.parse(claim.ts);
        return claim.seq < submission.seq && Number.isFinite(claimedAt) && claimedAt + claim.leaseSeconds * 1000 >= submittedAt;
      });
      const validClaim = Boolean(winningClaim && winningClaim.id === submission.claimId && winningClaim.author === submission.author);
      return { ...submission, validClaim };
    });
    const validSubmissions = view.submissions.filter((item) => item.validClaim);
    const submissionIds = new Set(validSubmissions.map((item) => item.id));
    const validDecisions = view.decisions.filter((item) => item.author === view.author && submissionIds.has(item.submissionId));
    view.decision = validDecisions.at(-1) || null;
    view.activeClaim = view.claims.find((claim) => {
      const started = Date.parse(claim.ts);
      return Number.isFinite(started) && started + claim.leaseSeconds * 1000 > now;
    }) || null;
    const taskExpired = view.task.expiresAt && Date.parse(view.task.expiresAt) <= now;
    view.status = view.decision?.verdict
      || (validSubmissions.length ? "submitted" : taskExpired ? "expired" : view.activeClaim ? "claimed" : "open");
    delete view.decisions;
  }
  return [...views.values()].sort((a, b) => b.seq - a.seq);
}

export function taskForId(rows, taskId, now = Date.now()) {
  return buildTaskViews(rows, now).find((item) => item.task.id === taskId) || null;
}
