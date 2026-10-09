// Opt-in: uses the selected provider's signed-in account for one short request.
// Reports timing and counts only; never prints prompts, answers or reasoning.
// node scripts/reasoning-stream.live.mjs agy gemini-3.1-pro-high
import { runCli, PROVIDERS } from '../server/cliModels.js';

const [providerId, model] = process.argv.slice(2);
if (!['agy', 'codex'].includes(providerId) || !model) {
  console.error('Usage: node scripts/reasoning-stream.live.mjs <agy|codex> <model>');
  process.exitCode = 1;
} else {
  const started = Date.now();
  const report = { provider: providerId, model, firstReasoningMs: null, firstAnswerMs: null, reasoningChunks: 0, answerChunks: 0 };
  try {
    await runCli({
      provider: PROVIDERS[providerId], model, think: 'medium',
      env: { CLI_TIMEOUT_MS: '90000' },
      request: {
        system: 'Answer briefly. Do not use any tools or modify files.',
        prompt: 'Explain SQL joins in Korean in three short paragraphs.', images: [],
      },
      onDelta(delta) {
        if (delta.reasoning && String(delta.thinking || '').replace(/[\s\u200b]/g, '')) {
          report.firstReasoningMs ??= Date.now() - started;
          report.reasoningChunks++;
        }
        if (delta.content) {
          report.firstAnswerMs ??= Date.now() - started;
          report.answerChunks++;
        }
      },
    });
    report.doneMs = Date.now() - started;
    report.reasoningBeforeAnswer = report.firstReasoningMs !== null
      && (report.firstAnswerMs === null || report.firstReasoningMs < report.firstAnswerMs);
    console.log(JSON.stringify(report, null, 2));
    // A finished answer or a placeholder alone must never pass this check.
    if (!report.reasoningBeforeAnswer) process.exitCode = 2;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
