import { fail, initMind } from "@mind/core";

// Flag parsing and printing. The procedure itself lives in core (`initMind`), so a host
// creating a mind over HTTP and a human running `mind init` scaffold the same thing.
export const run = (argv, ctx) => {
  let source = null;
  let force = false;
  let name = null;
  let newIdentity = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--source") source = argv[++i];
    else if (argv[i] === "--name") name = argv[++i];
    else if (argv[i] === "--force") force = true;
    else if (argv[i] === "--new-identity") newIdentity = true;
    else fail("unknown flag: " + argv[i]);
  }

  const report = initMind(process.cwd(), { name, source, force, newIdentity, cliVersion: ctx.cliVersion });

  const verb = report.reinitialized ? "reinitialized" : "initialized";
  console.log(`${verb} mind "${report.name}" (profile: ${report.profile}) in ${report.root}`);
  console.log(`  agent_id: ${report.agentId}${report.identityPreserved ? " (preserved)" : ""}`);
  if (report.previousAgentId) {
    console.log(`  was:      ${report.previousAgentId} — this mind no longer reads that mind's memory`);
  }
};
