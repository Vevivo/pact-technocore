import { open } from "./crypto.mjs";
import { newEvent } from "./protocol.mjs";
import { buildTaskViews } from "./tasks.mjs";
import { readSource } from "./source-reader.mjs";
import { runInference } from "./providers.mjs";
import { policyAllows } from "./policy.mjs";

export class AgentWorker {
  constructor(config, store, technocore, logger) {
    this.config = config;
    this.store = store;
    this.technocore = technocore;
    this.logger = logger;
    this.timer = null;
    this.scanning = false;
  }

  start() {
    if (this.timer) return;
    const tick = () => void this.scan();
    this.timer = setInterval(tick, this.config.agentScanMs);
    this.timer.unref();
    setTimeout(tick, 1500).unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async scan() {
    if (this.scanning) return;
    this.scanning = true;
    try {
      await this.technocore.syncOnce();
      const rows = this.store.roomEvents(this.config.room);
      const views = buildTaskViews(rows);
      const day = new Date().toISOString().slice(0, 10);
      for (const agent of this.store.enabledAgents()) {
        const policy = JSON.parse(agent.policy_json);
        if (this.store.completedToday(agent.id, day) >= policy.maxTasksPerDay) continue;
        const task = views.find((view) => policyAllows(policy, view) && !this.store.hasExecution(view.task.id, agent.id));
        if (!task) continue;
        await this.execute(agent, policy, task);
      }
      this.store.setState("agent_last_scan", new Date().toISOString());
    } catch (error) {
      this.store.setState("agent_scan_error", error.message);
      this.logger("error", "Agent scan failed", { error: error.message });
    } finally {
      this.scanning = false;
    }
  }

  async execute(agent, policy, view) {
    let execution;
    try {
      const privateJwk = JSON.parse(open(this.config.masterKey, agent.private_key_enc, `agent-private:${agent.id}`));
      const apiKey = open(this.config.masterKey, agent.api_key_enc, `provider-key:${agent.id}`);
      const claim = newEvent("claim", { taskId: view.task.id, leaseSeconds: 600 });
      await this.technocore.publish(privateJwk, agent.did, claim);
      await this.technocore.syncOnce();
      const current = buildTaskViews(this.store.roomEvents(this.config.room)).find((item) => item.task.id === view.task.id);
      if (!current?.activeClaim || current.activeClaim.id !== claim.id || current.activeClaim.author !== agent.did) return;

      execution = this.store.createExecution(view.task.id, agent.id, claim.id);
      this.logger("info", "Agent claimed task", { agentDid: agent.did, taskId: view.task.id });
      const sources = [];
      let remaining = policy.maxSourceChars;
      for (const sourceUrl of view.task.sources) {
        const source = await readSource(sourceUrl);
        source.text = source.text.slice(0, Math.max(0, remaining));
        remaining -= source.text.length;
        sources.push(source);
      }
      const result = await runInference(agent.provider, agent.model, apiKey, view.task, sources);
      const submission = newEvent("submission", {
        taskId: view.task.id,
        claimId: claim.id,
        summary: result.summary,
        evidence: result.evidence,
        model: `${agent.provider}:${agent.model}`,
      });
      await this.technocore.publish(privateJwk, agent.did, submission);
      this.store.finishExecution(execution.id, "submitted", {
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        result: { submissionId: submission.id, evidence: result.evidence },
      });
      this.store.markAgentActivity(agent.id, null);
      this.logger("info", "Agent submitted task", { agentDid: agent.did, taskId: view.task.id, submissionId: submission.id });
    } catch (error) {
      if (execution) this.store.finishExecution(execution.id, "failed", { error: error.message });
      this.store.markAgentActivity(agent.id, error.message.slice(0, 1000));
      this.logger("error", "Agent execution failed", { agentDid: agent.did, taskId: view.task.id, error: error.message });
    }
  }
}
