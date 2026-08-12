// Retries absorb Selenium races; a genuine regression still fails all three
// attempts. Timeouts are generous because each case drives a real VS Code.
//
// 120s rather than 60s, raised in review: a cold CI run pays for the workbench
// coming up for the first time, and that latency lands inside the `before`
// hook. The VS Code download itself happens in `extest setup-and-run` BEFORE
// mocha starts, so it is not on this clock — but workbench init is. The cost of
// this number is that a genuinely hung test burns 120s x 3 retries before it
// fails, which is why a test that hangs is a bug to fix rather than a number to
// raise again.
module.exports = {
  timeout: 120000,
  retries: 2,
  reporter: "spec",
};
