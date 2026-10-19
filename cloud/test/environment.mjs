// Evaluated before config.mjs in every test process. Never use the user's token or live AGENT_ROOT.
import fs from "node:fs";
import { after } from "node:test";

export const testRoot = fs.mkdtempSync("/tmp/personal-agent-connectors-test-");
process.env.AGENT_ROOT = testRoot;
process.env.AGENT_TOKEN = "fake-local-connectors-test-token";
process.env.AGENT_HOST = "127.0.0.1";
process.env.AGENT_PORT = "0";
process.env.AGENT_ACTIVITY_SUMMARIES = "0";
after(() => fs.rmSync(testRoot, { recursive: true, force: true }));
