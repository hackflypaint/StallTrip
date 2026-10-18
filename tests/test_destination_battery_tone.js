/**
 * Unit tests for destinationBatteryTone (SOC ok/warn/danger).
 * Run: node tests/test_destination_battery_tone.js
 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function loadTone() {
  const src = fs.readFileSync(path.join(__dirname, "..", "static", "app.js"), "utf8");
  const start = src.indexOf("function destinationBatteryTone");
  assert(start >= 0, "destinationBatteryTone missing from app.js");
  const end = src.indexOf("// Application State", start);
  assert(end > start, "could not slice destinationBatteryTone");
  const snippet = src.slice(start, end);
  const sandbox = { window: {}, console };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(snippet, sandbox);
  assert(typeof sandbox.destinationBatteryTone === "function", "tone not defined");
  return sandbox.destinationBatteryTone;
}

function run() {
  const tone = loadTone();
  assert(tone(67.1, 15) === "ok", "healthy SOC is ok");
  assert(tone(15.9, 15) === "ok", "at target is ok");
  assert(tone(15, 15) === "ok", "exact target is ok");
  assert(tone(10, 15) === "warn", "between half-target and target is warn");
  assert(tone(7.5, 15) === "warn", "half of 15 is warn");
  assert(tone(7.4, 15) === "danger", "below half-target is danger");
  assert(tone(0, 15) === "danger", "zero is danger");
  assert(tone(20, 30) === "warn", "below higher target is warn");
  assert(tone(14, 30) === "danger", "below half of higher target is danger");
  assert(tone(30, 30) === "ok", "meets higher target");
  assert(tone("12", "15") === "warn", "string numbers coerce");
  assert(tone(NaN, 15) === "unknown", "NaN unknown");
  console.log("test_destination_battery_tone.js: ALL PASSED");
}

run();
