const { join } = require("path");

// Store Chrome inside the project directory so it persists from build → runtime
// on Render. The default cache (~/.cache/puppeteer, i.e. /opt/render/.cache) is
// written at build time but NOT preserved into the runtime environment, which is
// why puppeteer.launch() failed with "Could not find Chrome".
module.exports = {
  cacheDirectory: join(__dirname, ".cache", "puppeteer"),
};
