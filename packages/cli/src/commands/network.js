import path from "node:path";
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import {
  HARNESS_ADAPTERS,
  createFunctionExecutor,
  fail,
  readNetworkDefinition,
  registerHarness,
  requireProjectRoot,
  runNetworkRoute,
} from "@mind/core";
import { formatNetworkExecution } from "../network-display.js";

const usage = "usage: mind network run <router-id> --signal <text> --payload <text> [--project <dir>] [--registry-module <trusted-host-module>] [--verbose]";

export const run = async (argv) => {
  if (argv[0] !== "run" || !argv[1]) fail(usage);
  const routerId = argv[1];
  const values = {};
  for (let i = 2; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--verbose" && values[flag] === undefined) {
      values[flag] = true;
      continue;
    }
    if (!["--signal", "--payload", "--project", "--registry-module"].includes(flag) || values[flag] !== undefined || !argv[i + 1]) fail(usage);
    values[flag] = argv[++i];
  }
  if (!values["--signal"] || values["--payload"] === undefined) fail(usage);
  const root = requireProjectRoot(values["--project"] ? path.resolve(values["--project"]) : process.cwd());
  const network = readNetworkDefinition(root);
  if (!network) fail("network definition is missing");
  let registry = null;
  if (values["--registry-module"]) {
    if (process.env.ALTER_DEPTH !== undefined) fail("host registry modules cannot be loaded from an Alter run");
    const modulePath = realpathSync(path.resolve(values["--registry-module"]));
    const projectPath = realpathSync(root);
    if (modulePath === projectPath || modulePath.startsWith(projectPath + path.sep)) fail("host registry module must be outside the project root");
    const mod = await import(pathToFileURL(modulePath).href);
    if (typeof mod.createRegistry !== "function") fail("host registry module must export createRegistry()");
    registry = await mod.createRegistry();
    if (!registry?.get || !registry?.execute) fail("createRegistry() must return a capability registry");
  }
  const previous = HARNESS_ADAPTERS.get("function");
  if (registry) registerHarness("function", createFunctionExecutor({ registry }));
  try {
    const run = await runNetworkRoute(root, {
      routerId,
      routingSignal: values["--signal"],
      payload: values["--payload"],
      capabilityRegistry: registry,
    });
    if (values["--verbose"]) process.stderr.write(formatNetworkExecution(network, {
      routerId,
      decision: run.decision,
      routerSpawned: true,
    }));
    process.stdout.write(JSON.stringify({
      ok: run.result.ok,
      network: network.id,
      route: run.decision?.selected_route_id || null,
      child: run.decision?.child_component_id || null,
      result: run.result.text,
      router_home: path.relative(root, run.home),
      child_home: run.decision?.child_home || null,
      error: run.decision?.error || null,
      message: run.result.ok ? null : run.result.capability_error || run.result.llm_error || null,
    }, null, 2) + "\n");
    if (!run.result.ok) process.exitCode = 1;
  } finally {
    if (registry) {
      if (previous) HARNESS_ADAPTERS.set("function", previous);
      else HARNESS_ADAPTERS.delete("function");
    }
  }
};
