import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { analyzeComparison } from "./analyze-comparison.mjs";
import { exclusionsFor, loadComparisonPlan } from "./run-comparison.mjs";
import { loadTaskSet, scoreBlindReview } from "./task-set.mjs";

export const applyBlindRatings = ({ resultsDir, ratingsFile }) => {
  const packets = JSON.parse(readFileSync(path.join(resultsDir, "blind-packets.json"), "utf8"));
  const map = JSON.parse(readFileSync(path.join(resultsDir, "blind-map.json"), "utf8"));
  const ratings = JSON.parse(readFileSync(ratingsFile, "utf8"));
  const report = JSON.parse(readFileSync(path.join(resultsDir, "report.json"), "utf8"));
  const { plan, sha256: planSha } = loadComparisonPlan(path.join(resultsDir, "plan.json"));
  const { set, sha256: taskSetSha } = loadTaskSet();
  if (report.plan_sha256 !== planSha || report.task_set_sha256 !== taskSetSha) throw new Error("review uses a different plan or task set");
  if (Object.keys(ratings).length !== packets.length || packets.some((packet) => !Object.hasOwn(ratings, packet.review_id))) {
    throw new Error("ratings must cover every blind packet exactly once");
  }
  const scores = new Map(packets.map((packet) => {
    const task = set.tasks.find((item) => item.id === packet.case_id);
    return [packet.review_id, scoreBlindReview(task, ratings[packet.review_id])];
  }));
  const records = readFileSync(path.join(resultsDir, "records.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
  for (const [reviewId, identity] of Object.entries(map)) {
    const record = records.find((item) => item.case_id === identity.case_id && item.repetition === identity.repetition &&
      item.condition_id === identity.condition_id);
    if (!record || !scores.has(reviewId)) throw new Error(`missing observation for review ${reviewId}`);
    record.quality_score = scores.get(reviewId);
  }
  const reviewed = {
    ...report,
    exclusions: exclusionsFor(set, report.phase, new Set(plan[report.phase].case_ids)),
    review: { method: "blind_rubric", packets: packets.length, ratings_file: path.basename(ratingsFile) },
    analysis: analyzeComparison(records, plan.conditions),
  };
  writeFileSync(path.join(resultsDir, "report-reviewed.json"), JSON.stringify(reviewed, null, 2));
  return reviewed;
};

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  const result = applyBlindRatings({ resultsDir: path.resolve(process.argv[2] || ""), ratingsFile: path.resolve(process.argv[3] || "") });
  process.stdout.write(JSON.stringify({ review: result.review, analysis: result.analysis }, null, 2) + "\n");
}
